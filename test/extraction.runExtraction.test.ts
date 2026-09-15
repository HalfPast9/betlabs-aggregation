import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runExtraction } from "../src/extraction/runExtraction.js";
import { FakeVisionExtractor } from "../src/extraction/fakeVisionExtractor.js";
import { sha256Hex } from "../src/lib/hash.js";
import { createTmpObjectStore } from "./helpers/tmpObjectStore.js";
import { resetDb } from "./helpers/testApp.js";

const execFileAsync = promisify(execFile);

async function makeTestVideo(durationSeconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "betlab-testvideo-"));
  try {
    const outPath = join(dir, "out.mp4");
    await execFileAsync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x240:rate=5:duration=${durationSeconds}`,
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runExtraction", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await resetDb(prisma);
  });
  afterEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeFundedSubmission(videoBuffer: Buffer, grantAmount?: number) {
    const participant = await prisma.participant.create({ data: {} });
    const enrollment = await prisma.enrollment.create({
      data: { participantId: participant.id, casino: "AcmeCasino", state: "funded" },
    });
    if (grantAmount !== undefined) {
      await prisma.grant.create({
        data: { enrollmentId: enrollment.id, amount: grantAmount, sentAt: new Date() },
      });
    }
    const contentHash = sha256Hex(videoBuffer);
    const mediaAsset = await prisma.mediaAsset.create({
      data: { blobKey: contentHash, contentHash, bytes: videoBuffer.byteLength },
    });
    const submission = await prisma.submission.create({
      data: { enrollmentId: enrollment.id, kind: "wager_recording", channel: "dropbox", mediaAssetId: mediaAsset.id, contentHash },
    });
    return { participant, enrollment, submission, contentHash };
  }

  it("samples frames, stitches rows, and persists a reconciliation", async () => {
    const video = await makeTestVideo(4);
    const { store: objectStore, cleanup } = await createTmpObjectStore();

    try {
      const { submission } = await makeFundedSubmission(video, 100);
      await objectStore.put(submission.contentHash, video);

      const visionExtractor = new FakeVisionExtractor((frame) => [
        {
          timestamp: new Date(2026, 8, 15, 12, frame.index).toISOString(),
          type: "bet",
          amount: 10,
          balanceAfter: 100 - frame.index * 10,
          confidence: 0.9,
        },
      ]);

      const result = await runExtraction(
        {
          prisma,
          objectStore,
          visionExtractor,
          extractorVersion: "test",
          frameIntervalSeconds: 1,
          dedupHammingThreshold: 0,
        },
        submission.id,
      );

      expect(result.rowCount).toBeGreaterThan(0);

      const run = await prisma.extractionRun.findUniqueOrThrow({
        where: { id: result.extractionRunId },
        include: { rows: true, reconciliation: true },
      });
      expect(run.status).toBe("succeeded");
      expect(run.rows.length).toBe(result.rowCount);
      expect(run.reconciliation).not.toBeNull();
      expect(Number(run.reconciliation!.wageredTotal)).toBeGreaterThan(0);
      expect(Number(run.reconciliation!.grantedAmount)).toBe(100);
    } finally {
      await cleanup();
    }
  });

  it("flags WAGER_SHORTFALL when wagered total is under the granted amount", async () => {
    const video = await makeTestVideo(2);
    const { store: objectStore, cleanup } = await createTmpObjectStore();

    try {
      const { submission } = await makeFundedSubmission(video, 1000);
      await objectStore.put(submission.contentHash, video);

      const visionExtractor = new FakeVisionExtractor((frame) => [
        { timestamp: `2026-09-15T12:0${frame.index}:00Z`, type: "bet", amount: 5, balanceAfter: null, confidence: 0.9 },
      ]);

      await runExtraction(
        { prisma, objectStore, visionExtractor, extractorVersion: "test", frameIntervalSeconds: 1, dedupHammingThreshold: 0 },
        submission.id,
      );

      const flags = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(flags.some((f) => f.code === "WAGER_SHORTFALL")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("flags ARITHMETIC_MISMATCH when balance doesn't reconcile with the row amount", async () => {
    const video = await makeTestVideo(2);
    const { store: objectStore, cleanup } = await createTmpObjectStore();

    try {
      const { submission } = await makeFundedSubmission(video);
      await objectStore.put(submission.contentHash, video);

      let call = 0;
      const visionExtractor = new FakeVisionExtractor((frame) => {
        call++;
        return [
          {
            timestamp: `2026-09-15T12:0${frame.index}:00Z`,
            type: "bet",
            amount: 10,
            balanceAfter: call === 1 ? 100 : 50, // second row's balance doesn't match a 10-unit move
            confidence: 0.9,
          },
        ];
      });

      await runExtraction(
        { prisma, objectStore, visionExtractor, extractorVersion: "test", frameIntervalSeconds: 1, dedupHammingThreshold: 0 },
        submission.id,
      );

      const flags = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(flags.some((f) => f.code === "ARITHMETIC_MISMATCH")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("dedupes rows read identically across multiple sampled frames", async () => {
    const video = await makeTestVideo(3);
    const { store: objectStore, cleanup } = await createTmpObjectStore();

    try {
      const { submission } = await makeFundedSubmission(video);
      await objectStore.put(submission.contentHash, video);

      // Every frame "reads" the exact same single row — like a static screen sampled multiple times.
      const visionExtractor = new FakeVisionExtractor(() => [
        { timestamp: "2026-09-15T12:00:00Z", type: "bet", amount: 10, balanceAfter: 90, confidence: 0.9 },
      ]);

      const result = await runExtraction(
        { prisma, objectStore, visionExtractor, extractorVersion: "test", frameIntervalSeconds: 1, dedupHammingThreshold: 0 },
        submission.id,
      );

      expect(result.rowCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("marks the run failed when the object store can't find the media", async () => {
    const video = await makeTestVideo(1);
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video);
      // Deliberately never put the bytes into the object store.
      const visionExtractor = new FakeVisionExtractor();

      await expect(
        runExtraction(
          { prisma, objectStore, visionExtractor, extractorVersion: "test", frameIntervalSeconds: 1, dedupHammingThreshold: 0 },
          submission.id,
        ),
      ).rejects.toThrow();

      const run = await prisma.extractionRun.findFirstOrThrow({ where: { submissionId: submission.id } });
      expect(run.status).toBe("failed");
      expect(run.error).toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});
