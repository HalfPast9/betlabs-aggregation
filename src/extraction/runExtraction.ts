import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import type { ObjectStore } from "../storage/objectStore.js";
import type { VisionExtractor } from "./visionExtractor.js";
import { computeDHash, probeFormat, probeKeyframeTimes } from "./ffmpeg.js";
import {
  compositeSegment,
  cutBandTile,
  detectRowBands,
  locateInFrames,
  planReconstruction,
  sampleDenseFrames,
  tilePanorama,
  type PanoramaImage,
  type ReconstructionPlan,
  type RowBand,
  type Tile,
} from "./panorama.js";
import { assembleRows, foldSegments, type AssembledRow } from "./assemble.js";
import { normalizeRows } from "./normalize.js";
import { verifyChain, type ChainResult } from "./chain.js";
import { assessRecording, type RecordingQuality } from "./quality.js";
import { crossCheckRows } from "./crossCheck.js";
import type { TileReadResult, VisionExtractionResult } from "./visionExtractor.js";
import { validateArithmetic, validateTimestamps, safeParseDate } from "./validate.js";
import { reconcile } from "./reconcile.js";
import { sha256Hex } from "../lib/hash.js";
import { checkEncoderMismatch, checkFrameDiscontinuity, type IntegritySignal } from "../integrity/videoSignals.js";
import { checkSubmissionGap } from "../integrity/simpleFlags.js";
import { checkDuplicateMedia, checkSharedRows } from "../integrity/crossSubmission.js";

export interface RunExtractionDeps {
  prisma: PrismaClient;
  objectStore: ObjectStore;
  visionExtractor: VisionExtractor;
  /** Independent second reader for timestamps/descriptions (docs/extraction-hardening.md §3). Absent = no cross-check. */
  crossCheckExtractor?: VisionExtractor;
  extractorVersion: string;
  /** Frames per second to decode for scroll reconstruction. Denser = more robust to fast flicks; CPU only. */
  panoramaFps: number;
}

export interface RunExtractionOptions {
  /** Execute an ExtractionRun row that was created earlier (queued) instead of creating one. */
  runId?: string;
  /** Read the recording even if its quality assessment says reject. */
  force?: boolean;
}

export interface RunExtractionResult {
  extractionRunId: string;
  rowCount: number;
  flagCount: number;
  chainComplete: boolean;
  quality: RecordingQuality;
}

/** Tiles re-read around chain breaks, at most, per run. */
const RETRY_MAX_TILES = 4;

const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * PRD §6.3 pipeline for one submission, rebuilt around scroll reconstruction:
 * decode densely → align frames → composite the whole scrolled list into one
 * panorama → cut it into overlapping tiles → read each tile once → merge by
 * position → verify the balance chain → reconcile against the grant.
 * Everything is persisted as a new `extraction_run` (re-runnable per §6.2).
 */
export async function runExtraction(deps: RunExtractionDeps, submissionId: string, options: RunExtractionOptions = {}): Promise<RunExtractionResult> {
  const submission = await deps.prisma.submission.findUniqueOrThrow({
    where: { id: submissionId },
    include: { mediaAsset: true, enrollment: { include: { grant: true } } },
  });

  const runData = {
    extractorVersion: deps.extractorVersion,
    model: deps.visionExtractor.model,
    crossCheckModel: deps.crossCheckExtractor?.model ?? null,
    status: "running",
    startedAt: new Date(),
  };
  const run = options.runId
    ? await deps.prisma.extractionRun.update({ where: { id: options.runId }, data: runData })
    : await deps.prisma.extractionRun.create({ data: { submissionId, ...runData } });

  try {
    const videoBuffer = await deps.objectStore.get(submission.mediaAsset.blobKey);
    const frames = await sampleDenseFrames(videoBuffer, deps.panoramaFps);
    let firstFrameJpeg: Buffer;
    let panoramas: PanoramaImage[];
    let tiles: Tile[];
    let plan: ReconstructionPlan;
    let bandsPerSegment: RowBand[][];
    try {
      firstFrameJpeg = await readFile(frames.files[0]!);
      plan = await planReconstruction(frames);
      panoramas = [];
      tiles = [];
      bandsPerSegment = [];
      for (let si = 0; si < plan.segments.length; si++) {
        const pano = await compositeSegment(frames, plan, plan.segments[si]!);
        panoramas.push(pano);
        const bands = await detectRowBands(pano.png);
        bandsPerSegment.push(bands);
        tiles.push(...(await tilePanorama(pano, si, tiles.length, { bands })));
      }
    } finally {
      await frames.cleanup();
    }

    // Judge the recording before spending on the model (§4). A rejected
    // recording is stored with its verdict and no rows so the runner can
    // re-record now; `force` reads it anyway.
    const quality = assessRecording(plan, bandsPerSegment, { count: frames.files.length, fps: frames.fps });
    const shouldRead = quality.verdict !== "reject" || options.force === true;

    const toInputs = (ts: Tile[]) => ts.map((t) => ({ index: t.index, jpegBuffer: t.jpegBuffer, top: t.top, bottom: t.bottom, scale: t.scale }));
    let visionResult: VisionExtractionResult = shouldRead
      ? await deps.visionExtractor.extractRows(toInputs(tiles))
      : { tiles: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };

    // Segment order: within a list broken by a flick, the scroll direction
    // says which piece is above; across paginated pages, the later page is
    // the older one. The balance chain decides — whichever order links up.
    let scrollsTowardTop = plan.segments.reduce((acc, s) => acc + (s.placements[s.placements.length - 1]!.top - s.placements[0]!.top), 0) < 0;
    const assembleAndVerify = (readTiles: Tile[], reads: TileReadResult[], towardTop: boolean) => {
      const assembly = assembleRows(readTiles, reads, towardTop);
      const rows = foldSegments(normalizeRows(assembly.rows));
      return { assembly, rows, chain: verifyChain(rows) };
    };
    const bestOrder = (readTiles: Tile[], reads: TileReadResult[]) => {
      let best = { towardTop: scrollsTowardTop, ...assembleAndVerify(readTiles, reads, scrollsTowardTop) };
      if (plan.segments.length > 1) {
        const flipped = { towardTop: !scrollsTowardTop, ...assembleAndVerify(readTiles, reads, !scrollsTowardTop) };
        if (flipped.chain.breaks.length < best.chain.breaks.length) best = flipped;
      }
      return best;
    };
    let best = bestOrder(tiles, visionResult.tiles);

    // Retry before flagging (§2): a chain break is more often one misread
    // than a missing transaction. Re-read the tiles around each break in a
    // different framing (one band of context each side) and keep the
    // result if it links up better.
    let retryTiles = 0;
    if (shouldRead && best.chain.breaks.length > 0) {
      const retried = await retryAroundBreaks(deps, panoramas, bandsPerSegment, tiles, best.rows, best.chain);
      if (retried) {
        retryTiles = retried.tiles.length;
        const merged: TileReadResult[] = [...visionResult.tiles.filter((r) => !retried.replaced.has(r.tileIndex)), ...retried.result.tiles];
        const keptTiles = [...tiles.filter((t) => !retried.replaced.has(t.index)), ...retried.tiles];
        const candidate = bestOrder(keptTiles, merged);
        visionResult = {
          tiles: visionResult.tiles,
          inputTokens: visionResult.inputTokens + retried.result.inputTokens,
          outputTokens: visionResult.outputTokens + retried.result.outputTokens,
          costUsd: visionResult.costUsd === null || retried.result.costUsd === null ? null : visionResult.costUsd + retried.result.costUsd,
        };
        if (candidate.chain.breaks.length < best.chain.breaks.length) {
          best = candidate;
          tiles = keptTiles;
          visionResult = { ...visionResult, tiles: merged };
        }
      }
    }
    scrollsTowardTop = best.towardTop;
    const { assembly, rows, chain } = best;

    // Independent second read for the fields the chain can't protect (§3).
    let crossCheck: ReturnType<typeof crossCheckRows> | null = null;
    if (shouldRead && deps.crossCheckExtractor && rows.length > 0) {
      const second = await deps.crossCheckExtractor.extractRows(toInputs(tiles));
      const secondRows = foldSegments(normalizeRows(assembleRows(tiles, second.tiles, scrollsTowardTop).rows));
      crossCheck = crossCheckRows(rows, secondRows);
      visionResult = {
        ...visionResult,
        inputTokens: visionResult.inputTokens + second.inputTokens,
        outputTokens: visionResult.outputTokens + second.outputTokens,
        costUsd: visionResult.costUsd === null || second.costUsd === null ? null : visionResult.costUsd + second.costUsd,
      };
    }
    const chronological = chain.newestFirst ? [...rows].reverse() : rows;

    const arithmeticFlags = validateArithmetic(rows);
    const timestampFlags = validateTimestamps(chronological);
    const allFlags: IntegritySignal[] = [...arithmeticFlags, ...timestampFlags];

    if (chain.checkedRows > 0 && !chain.complete) {
      allFlags.push({
        code: "EXTRACTION_INCOMPLETE",
        severity: "warning",
        detail: `Balance chain has ${chain.breaks.length} break(s) — a row may be missing or misread, or the app's own list omits a transaction (e.g. a filtered-out bonus/adjustment): ${chain.breaks
          .slice(0, 3)
          .map((b) => `row ${b.rowIndex}: ${b.detail}`)
          .join("; ")}${chain.breaks.length > 3 ? "; …" : ""}`,
      });
    }
    // A page change or loading screen produces a gap going in and one coming
    // out a few frames later; report that as one event.
    const gapTimes = plan.gaps.map((g) => g.timestampSeconds).filter((t, i, arr) => i === 0 || t - arr[i - 1]! > 1);
    for (const t of gapTimes) {
      allFlags.push({
        code: "SCROLL_GAP",
        severity: "info",
        detail: `Could not align consecutive frames at ${t.toFixed(1)}s (scrolled past more than a screen, or the view changed — e.g. a page change) — content between may be unrecorded`,
      });
    }
    if (assembly.conflicts > 0) {
      allFlags.push({
        code: "READ_CONFLICT",
        severity: "warning",
        detail: `${assembly.conflicts} row(s) were read differently by two overlapping tiles; the higher-quality read was kept`,
      });
    }
    if (quality.verdict !== "ok") {
      allFlags.push({
        code: "RECORDING_QUALITY",
        severity: quality.verdict === "reject" ? "high" : "warning",
        detail: `${quality.verdict === "reject" ? "Recording rejected" : "Recording quality"}: ${quality.reasons.join("; ")}${quality.verdict === "reject" && !shouldRead ? " — not read; re-record, or extract with force=true" : ""}`,
      });
    }
    if (shouldRead && rows.length > 0 && chain.checkedRows === 0) {
      allFlags.push({
        code: "RECORDING_QUALITY",
        severity: "warning",
        detail: "This list shows no running balance, so completeness can't be verified by the balance chain — rows rest on the reconstruction alone",
      });
    }
    if (crossCheck && crossCheck.disagreeingRows > 0) {
      const which = rows
        .map((r, i) => ({ i, d: crossCheck!.perRow[i]!.disagreements }))
        .filter((x) => x.d.length > 0)
        .slice(0, 5)
        .map((x) => `row ${x.i}: ${x.d.join("/")}`)
        .join("; ");
      allFlags.push({
        code: "READ_DISAGREEMENT",
        severity: "warning",
        detail: `A second read (${deps.crossCheckExtractor!.model}) disagreed on ${crossCheck.disagreeingRows} row(s): ${which}${crossCheck.disagreeingRows > 5 ? "; …" : ""}`,
      });
    }

    const grantedAmount = submission.enrollment.grant ? Number(submission.enrollment.grant.amount) : null;
    const reconciliation = reconcile(rows, grantedAmount, arithmeticFlags);
    if (reconciliation.shortfall) {
      allFlags.push({
        code: "WAGER_SHORTFALL",
        severity: "high",
        detail: `Wagered ${reconciliation.wageredTotal.toFixed(2)} < granted ${grantedAmount!.toFixed(2)}`,
      });
    }

    const lowConfidenceRows = rows.filter((r) => r.confidence !== null && r.confidence < LOW_CONFIDENCE_THRESHOLD);
    if (lowConfidenceRows.length > 0) {
      allFlags.push({
        code: "LOW_CONFIDENCE",
        severity: "warning",
        detail: `${lowConfidenceRows.length} of ${rows.length} row(s) read with confidence below ${LOW_CONFIDENCE_THRESHOLD}`,
      });
    }

    const submissionGapFlag = checkSubmissionGap(submission.receivedAt, submission.enrollment.grant?.sentAt ?? null);
    if (submissionGapFlag) allFlags.push(submissionGapFlag);

    // PRD §6.1 provenance dependency: these two checks are only meaningful
    // for the pristine Dropbox path — anything else may carry a legitimate
    // re-encode signature and must be suppressed, not flagged.
    let representativeDHash: bigint | null = null;
    if (submission.channel === "dropbox") {
      const [format, keyframeTimes] = await Promise.all([probeFormat(videoBuffer), probeKeyframeTimes(videoBuffer)]);
      const encoderFlag = checkEncoderMismatch(format);
      if (encoderFlag) allFlags.push(encoderFlag);
      const discontinuityFlag = checkFrameDiscontinuity(keyframeTimes);
      if (discontinuityFlag) allFlags.push(discontinuityFlag);

      representativeDHash = await computeDHash(firstFrameJpeg);
      const duplicateFlag = await checkDuplicateMedia(deps.prisma, submission.mediaAssetId, representativeDHash);
      if (duplicateFlag) allFlags.push(duplicateFlag);
    }

    const rowKeys = rows.map(rowKey);
    const sharedRowsFlag = await checkSharedRows(deps.prisma, run.id, submission.enrollment.participantId, rowKeys);
    if (sharedRowsFlag) allFlags.push(sharedRowsFlag);

    // The stitched list itself is worth keeping for review — it's the thing
    // the rows were read from, and the console highlights rows on it.
    const panoramaBlobKey = `panorama/${run.id}.png`;
    await deps.objectStore.put(panoramaBlobKey, await stackPanoramas(panoramas, scrollsTowardTop));
    const segmentOffsets = panoramaOffsets(panoramas, scrollsTowardTop);
    const regionH = plan.scrollRegion.bottom - plan.scrollRegion.top;

    await deps.prisma.$transaction(async (tx) => {
      if (representativeDHash !== null) {
        await tx.mediaAsset.update({
          where: { id: submission.mediaAssetId },
          data: { sourceMeta: { dHash: representativeDHash.toString(16) } },
        });
      }

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const segment = plan.segments[row.segmentIndex]!;
        const loc = locateInFrames(segment, regionH, row.panoramaTop, row.panoramaBottom);
        await tx.transactionRow.create({
          data: {
            extractionRunId: run.id,
            sequence: i,
            rowKey: rowKeys[i]!,
            timestamp: safeParseDate(row.timestamp),
            type: row.type,
            description: row.description,
            amount: row.amount,
            balanceBefore: row.balanceBefore,
            balanceAfter: row.balanceAfter,
            confidence: row.confidence,
            partial: row.partial,
            segmentIndex: row.segmentIndex,
            panoramaTop: row.panoramaTop + (segmentOffsets[row.segmentIndex] ?? 0),
            panoramaBottom: row.panoramaBottom + (segmentOffsets[row.segmentIndex] ?? 0),
            crossChecked: crossCheck?.perRow[i]?.crossChecked ?? false,
            disagreements: crossCheck?.perRow[i]?.disagreements ?? [],
            sourceFrameTs: loc?.placement.timestampSeconds ?? null,
            boxX: loc ? 0 : null,
            boxY: loc ? (plan.scrollRegion.top + loc.yInRegion) / frames.height : null,
            boxW: loc ? 1 : null,
            boxH: loc ? (row.panoramaBottom - row.panoramaTop) / frames.height : null,
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
          chainComplete: chain.checkedRows > 0 ? chain.complete : null,
          chainBreaks: chain.breaks.map((b) => ({ ...b })),
          chainStart: chain.startBalance,
          chainEnd: chain.endBalance,
          newestFirst: chain.newestFirst,
        },
      });

      // Extraction-derived flags reflect current analysis, not a historical
      // record — a decision's evidenceSnapshot is what freezes point-in-time
      // state (PRD §6.5). Re-running extraction replaces them; ingest-time
      // flags (extractionRunId null) are untouched.
      await tx.integrityFlag.deleteMany({ where: { submissionId, extractionRunId: { not: null } } });
      for (const flag of allFlags) {
        await tx.integrityFlag.create({
          data: { submissionId, extractionRunId: run.id, code: flag.code, severity: flag.severity, detail: flag.detail, generatedBy: `extractor@${deps.extractorVersion}` },
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
          frameCount: frames.files.length,
          tileCount: tiles.length,
          panoramaBlobKey,
          quality: { verdict: quality.verdict, reasons: quality.reasons, metrics: { ...quality.metrics } },
          retryTiles,
          tileReads: {
            tiles: tiles.map((t) => ({ index: t.index, segmentIndex: t.segmentIndex, top: t.top, bottom: t.bottom, scale: t.scale, bands: t.bands ? t.bands.map((b) => ({ ...b })) : null, firstBandIndex: t.firstBandIndex })),
            reads: visionResult.tiles.map((r) => ({ tileIndex: r.tileIndex, rows: r.rows.map((row) => ({ ...row })) })),
          },
        },
      });
    });

    return { extractionRunId: run.id, rowCount: rows.length, flagCount: allFlags.length, chainComplete: chain.complete, quality };
  } catch (err) {
    await deps.prisma.extractionRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: (err as Error).message },
    });
    throw err;
  }
}

/**
 * Re-read the tiles whose bands hold the rows on either side of each chain
 * break, cut with one extra band of context above and below.
 */
async function retryAroundBreaks(
  deps: RunExtractionDeps,
  panoramas: PanoramaImage[],
  bandsPerSegment: RowBand[][],
  tiles: Tile[],
  rows: AssembledRow[],
  chain: ChainResult,
): Promise<{ tiles: Tile[]; result: VisionExtractionResult; replaced: Set<number> } | null> {
  const targets = new Map<number, Tile>();
  for (const b of chain.breaks) {
    for (const i of [b.rowIndex - 1, b.rowIndex, b.rowIndex + 1]) {
      const row = rows[i];
      if (!row) continue;
      const tile = tiles.find((t) => t.index === row.tileIndex);
      if (tile && tile.bands) targets.set(tile.index, tile);
    }
  }
  const chosen = [...targets.values()].slice(0, RETRY_MAX_TILES);
  if (chosen.length === 0) return null;

  let nextIndex = Math.max(...tiles.map((t) => t.index)) + 1;
  const retryTiles: Tile[] = [];
  for (const t of chosen) {
    const bands = bandsPerSegment[t.segmentIndex]!;
    const first = t.firstBandIndex - 1;
    const last = t.firstBandIndex + t.bands!.length; // one band of context each side
    retryTiles.push(await cutBandTile(panoramas[t.segmentIndex]!, bands, first, last, t.segmentIndex, nextIndex++));
  }
  const result = await deps.visionExtractor.extractRows(
    retryTiles.map((t) => ({ index: t.index, jpegBuffer: t.jpegBuffer, top: t.top, bottom: t.bottom, scale: t.scale })),
  );
  return { tiles: retryTiles, result, replaced: new Set(chosen.map((t) => t.index)) };
}

function rowKey(row: AssembledRow): string {
  const canonical = `${row.timestamp ?? ""}|${row.type ?? ""}|${row.amount ?? ""}|${row.balanceBefore ?? ""}|${row.balanceAfter ?? ""}`;
  return sha256Hex(Buffer.from(canonical, "utf8"));
}

/** Segments in display order (top of the list first). */
function displayOrder(panoramas: PanoramaImage[], scrollsTowardTop: boolean): PanoramaImage[] {
  return scrollsTowardTop ? [...panoramas].reverse() : panoramas;
}

/** Vertical offset of each segment inside the stacked review image. */
function panoramaOffsets(panoramas: PanoramaImage[], scrollsTowardTop: boolean): number[] {
  const offsets = new Array<number>(panoramas.length).fill(0);
  let y = 0;
  for (const pano of displayOrder(panoramas, scrollsTowardTop)) {
    offsets[panoramas.indexOf(pano)] = y;
    y += pano.height + GAP_BAND;
  }
  return offsets;
}

const GAP_BAND = 24;

async function stackPanoramas(panoramas: PanoramaImage[], scrollsTowardTop: boolean): Promise<Buffer> {
  const ordered = displayOrder(panoramas, scrollsTowardTop);
  if (ordered.length === 1) return ordered[0]!.png;
  const width = Math.max(...ordered.map((p) => p.width));
  const height = ordered.reduce((acc, p) => acc + p.height, 0) + GAP_BAND * (ordered.length - 1);
  const composites = [];
  let y = 0;
  for (const p of ordered) {
    composites.push({ input: p.png, left: 0, top: y });
    y += p.height + GAP_BAND;
  }
  // Gap bands are a visible seam: the participant scrolled past something here.
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 200, b: 200 } } }).composite(composites).png().toBuffer();
}
