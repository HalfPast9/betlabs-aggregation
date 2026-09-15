import type { PrismaClient } from "@prisma/client";
import type { ObjectStore } from "../storage/objectStore.js";
import type { VisionExtractor } from "./visionExtractor.js";
import {
  computeDHash,
  hammingDistance,
  probeFormat,
  probeKeyframeTimes,
  sampleFrames,
  type SampledFrame,
} from "./ffmpeg.js";
import { stitchRows } from "./stitch.js";
import { validateArithmetic, validateTimestamps, safeParseDate } from "./validate.js";
import { reconcile } from "./reconcile.js";
import { checkEncoderMismatch, checkFrameDiscontinuity, type IntegritySignal } from "../integrity/videoSignals.js";
import { checkSubmissionGap } from "../integrity/simpleFlags.js";
import { checkDuplicateMedia, checkSharedRows } from "../integrity/crossSubmission.js";

export interface RunExtractionDeps {
  prisma: PrismaClient;
  objectStore: ObjectStore;
  visionExtractor: VisionExtractor;
  extractorVersion: string;
  frameIntervalSeconds: number;
  /** Consecutive frames within this Hamming distance are treated as duplicates and skipped. */
  dedupHammingThreshold: number;
}

export interface RunExtractionResult {
  extractionRunId: string;
  rowCount: number;
  flagCount: number;
}

const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Full PRD §6.3 pipeline for one submission: sample frames, drop
 * near-duplicates, read rows via the vision extractor, stitch, validate, and
 * reconcile against the grant — persisting everything, including cost
 * instrumentation, as a new `extraction_run` (re-runnable per §6.2: "history
 * is reprocessed rather than re-collected").
 */
export async function runExtraction(
  deps: RunExtractionDeps,
  submissionId: string,
): Promise<RunExtractionResult> {
  const submission = await deps.prisma.submission.findUniqueOrThrow({
    where: { id: submissionId },
    include: { mediaAsset: true, enrollment: { include: { grant: true } } },
  });

  const run = await deps.prisma.extractionRun.create({
    data: {
      submissionId,
      extractorVersion: deps.extractorVersion,
      model: "vision-extractor",
      status: "running",
    },
  });

  try {
    const videoBuffer = await deps.objectStore.get(submission.mediaAsset.blobKey);
    const allFrames = await sampleFrames(videoBuffer, deps.frameIntervalSeconds);
    const keptFrames = await dedupeFrames(allFrames, deps.dedupHammingThreshold);

    const visionResult = await deps.visionExtractor.extractRows(
      keptFrames.map((f) => ({ index: f.index, timestampSeconds: f.timestampSeconds, jpegBuffer: f.jpegBuffer })),
    );

    const frameTimestampByIndex = new Map(keptFrames.map((f) => [f.index, f.timestampSeconds]));
    const stitched = stitchRows(
      visionResult.frames.map((fr) => ({
        rows: fr.rows,
        timestampSeconds: frameTimestampByIndex.get(fr.frameIndex) ?? 0,
      })),
    );

    const arithmeticFlags = validateArithmetic(stitched);
    const timestampFlags = validateTimestamps(stitched);
    const allFlags: IntegritySignal[] = [...arithmeticFlags, ...timestampFlags];

    const grantedAmount = submission.enrollment.grant ? Number(submission.enrollment.grant.amount) : null;
    const reconciliation = reconcile(stitched, grantedAmount, arithmeticFlags);
    if (reconciliation.shortfall) {
      allFlags.push({
        code: "WAGER_SHORTFALL",
        severity: "high",
        detail: `Wagered ${reconciliation.wageredTotal.toFixed(2)} < granted ${grantedAmount!.toFixed(2)}`,
      });
    }

    const lowConfidenceRows = stitched.filter(
      (r) => r.confidence !== null && r.confidence < LOW_CONFIDENCE_THRESHOLD,
    );
    if (lowConfidenceRows.length > 0) {
      allFlags.push({
        code: "LOW_CONFIDENCE",
        severity: "warning",
        detail: `${lowConfidenceRows.length} of ${stitched.length} row(s) read with confidence below ${LOW_CONFIDENCE_THRESHOLD}`,
      });
    }

    const submissionGapFlag = checkSubmissionGap(
      submission.receivedAt,
      submission.enrollment.grant?.sentAt ?? null,
    );
    if (submissionGapFlag) allFlags.push(submissionGapFlag);

    // PRD §6.1 provenance dependency: these two checks are only meaningful
    // for the pristine Dropbox path — anything else may carry a legitimate
    // re-encode signature and must be suppressed, not flagged.
    let representativeDHash: bigint | null = null;
    if (submission.channel === "dropbox") {
      const [format, keyframeTimes] = await Promise.all([
        probeFormat(videoBuffer),
        probeKeyframeTimes(videoBuffer),
      ]);
      const encoderFlag = checkEncoderMismatch(format);
      if (encoderFlag) allFlags.push(encoderFlag);
      const discontinuityFlag = checkFrameDiscontinuity(keyframeTimes);
      if (discontinuityFlag) allFlags.push(discontinuityFlag);

      if (keptFrames[0]) {
        representativeDHash = await computeDHash(keptFrames[0].jpegBuffer);
        const duplicateFlag = await checkDuplicateMedia(
          deps.prisma,
          submission.mediaAssetId,
          representativeDHash,
        );
        if (duplicateFlag) allFlags.push(duplicateFlag);
      }
    }

    const sharedRowsFlag = await checkSharedRows(
      deps.prisma,
      run.id,
      submission.enrollment.participantId,
      stitched.map((r) => r.rowKey),
    );
    if (sharedRowsFlag) allFlags.push(sharedRowsFlag);

    await deps.prisma.$transaction(async (tx) => {
      if (representativeDHash !== null) {
        await tx.mediaAsset.update({
          where: { id: submission.mediaAssetId },
          data: { sourceMeta: { dHash: representativeDHash.toString(16) } },
        });
      }

      for (const row of stitched) {
        await tx.transactionRow.create({
          data: {
            extractionRunId: run.id,
            rowKey: row.rowKey,
            timestamp: safeParseDate(row.timestamp),
            type: row.type,
            amount: row.amount,
            balanceAfter: row.balanceAfter,
            sourceFrameTs: row.sourceFrameTs,
            confidence: row.confidence,
          },
        });
      }

      await tx.reconciliation.create({
        data: {
          extractionRunId: run.id,
          wageredTotal: reconciliation.wageredTotal,
          grantedAmount: reconciliation.grantedAmount,
          delta: reconciliation.delta,
          arithmeticOk: reconciliation.arithmeticOk,
        },
      });

      for (const flag of allFlags) {
        await tx.integrityFlag.create({
          data: {
            submissionId,
            code: flag.code,
            severity: flag.severity,
            detail: flag.detail,
            generatedBy: `extractor@${deps.extractorVersion}`,
          },
        });
      }

      await tx.extractionRun.update({
        where: { id: run.id },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          inputTokens: visionResult.inputTokens,
          outputTokens: visionResult.outputTokens,
          costUsd: visionResult.costUsd,
        },
      });
    });

    return { extractionRunId: run.id, rowCount: stitched.length, flagCount: allFlags.length };
  } catch (err) {
    await deps.prisma.extractionRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: (err as Error).message },
    });
    throw err;
  }
}

async function dedupeFrames(frames: SampledFrame[], threshold: number): Promise<SampledFrame[]> {
  const kept: SampledFrame[] = [];
  let lastHash: bigint | null = null;
  for (const frame of frames) {
    const hash = await computeDHash(frame.jpegBuffer);
    if (lastHash !== null && hammingDistance(hash, lastHash) <= threshold) continue;
    kept.push(frame);
    lastHash = hash;
  }
  return kept;
}
