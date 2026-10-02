import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runExtraction } from "../src/extraction/runExtraction.js";
import { FakeVisionExtractor } from "../src/extraction/fakeVisionExtractor.js";
import type { RawExtractedRow, TileInput } from "../src/extraction/visionExtractor.js";
import { sha256Hex } from "../src/lib/hash.js";
import { createTmpObjectStore } from "./helpers/tmpObjectStore.js";
import { resetDb } from "./helpers/testApp.js";
import { makeScrollVideo } from "./helpers/scrollVideo.js";

const ROW_H = 90;

function row(overrides: Partial<RawExtractedRow>): RawExtractedRow {
  return {
    timestamp: null,
    type: "bet",
    description: null,
    amount: -1,
    balanceBefore: null,
    balanceAfter: null,
    confidence: 0.9,
    fullyVisible: true,
    yTop: null,
    ...overrides,
  };
}

/**
 * A scripted reader that "sees" a fixed list of rows laid out at ROW_H px
 * pitch in the panorama, and returns whichever ones fall inside each tile —
 * exactly what a real read of a correctly stitched panorama produces,
 * including the same row appearing in two overlapping tiles.
 */
function listReader(list: Array<Partial<RawExtractedRow>>) {
  return (tile: TileInput): RawExtractedRow[] =>
    list
      .map((r, i) => ({ r, top: i * ROW_H + 10 }))
      .filter(({ top }) => top >= tile.top && top + ROW_H * 0.8 <= tile.bottom)
      .map(({ r, top }) => row({ ...r, yTop: top / tile.scale }));
}

describe("runExtraction", () => {
  const prisma = new PrismaClient();
  let video: Buffer;

  beforeAll(async () => {
    await resetDb(prisma);
    video = (await makeScrollVideo({ rowCount: 24, speed: 400 })).buffer;
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
      await prisma.grant.create({ data: { enrollmentId: enrollment.id, amount: grantAmount, sentAt: new Date() } });
    }
    const contentHash = sha256Hex(videoBuffer);
    const mediaAsset = await prisma.mediaAsset.create({ data: { blobKey: contentHash, contentHash, bytes: videoBuffer.byteLength } });
    const submission = await prisma.submission.create({
      data: { enrollmentId: enrollment.id, kind: "wager_recording", channel: "dropbox", mediaAssetId: mediaAsset.id, contentHash },
    });
    return { participant, enrollment, submission, contentHash };
  }

  const deps = (objectStore: Awaited<ReturnType<typeof createTmpObjectStore>>["store"], visionExtractor: FakeVisionExtractor, version = "test") => ({
    prisma,
    objectStore,
    visionExtractor,
    extractorVersion: version,
    panoramaFps: 10,
  });

  // A newest-first list whose balance chain is intact: 100 → 99 → 101 → 100 → …
  const intactList: Array<Partial<RawExtractedRow>> = [
    { timestamp: "2026-09-15 12:05", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 },
    { timestamp: "2026-09-15 12:04", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 },
    { timestamp: "2026-09-15 12:03", type: "bet", amount: -1, balanceBefore: 101, balanceAfter: 100 },
    { timestamp: "2026-09-15 12:02", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 },
    { timestamp: "2026-09-15 12:01", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 },
    { timestamp: "2026-09-15 12:00", type: "deposit", amount: 100, balanceBefore: 0, balanceAfter: 100 },
  ];

  it("reconstructs the scroll, reads tiles, and persists rows with a verified chain", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video, 3);
      await objectStore.put(submission.contentHash, video);

      const result = await runExtraction(deps(objectStore, new FakeVisionExtractor(listReader(intactList))), submission.id);

      expect(result.rowCount).toBe(intactList.length);
      expect(result.chainComplete).toBe(true);

      const run = await prisma.extractionRun.findUniqueOrThrow({
        where: { id: result.extractionRunId },
        include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true },
      });
      expect(run.status).toBe("succeeded");
      expect(run.frameCount).toBeGreaterThan(10);
      expect(run.tileCount).toBeGreaterThanOrEqual(1);
      expect(run.panoramaBlobKey).toBeTruthy();
      expect((await objectStore.get(run.panoramaBlobKey!)).byteLength).toBeGreaterThan(1000);

      expect(run.rows.map((r) => r.type)).toEqual(["win", "bet", "bet", "win", "bet", "deposit"]);
      expect(run.rows.every((r) => r.sourceFrameTs !== null && r.boxY !== null)).toBe(true);
      expect(run.reconciliation!.chainComplete).toBe(true);
      expect(run.reconciliation!.newestFirst).toBe(true);
      expect(Number(run.reconciliation!.chainStart)).toBe(0);
      expect(Number(run.reconciliation!.chainEnd)).toBe(101);
      expect(Number(run.reconciliation!.wageredTotal)).toBe(3);
      expect(Number(run.reconciliation!.grantedAmount)).toBe(3);
    } finally {
      await cleanup();
    }
  });

  it("merges the same row read from two overlapping tiles by position, not content", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video);
      await objectStore.put(submission.contentHash, video);

      // 20 rows at 90px pitch = 1800px of list → two tiles with a 320px overlap
      // (tile 0: 0-1400, tile 1: 1080-2160). Several rows straddle both. Rows
      // alternate bet/win under one displayed minute so every other row is
      // content-identical — like a real same-minute run, and unlike the same
      // row read twice.
      const identical = Array.from({ length: 20 }, (_, i) => ({
        timestamp: "2026-09-15 12:00",
        type: i % 2 === 0 ? ("bet" as const) : ("win" as const),
        amount: i % 2 === 0 ? -1 : 1,
        balanceBefore: i % 2 === 0 ? 100 : 99,
        balanceAfter: i % 2 === 0 ? 99 : 100,
        description: `row ${i}`,
      }));
      const extractor = new FakeVisionExtractor(listReader(identical));
      const result = await runExtraction(deps(objectStore, extractor), submission.id);

      // Content-identical rows stay distinct; overlap reads collapse.
      expect(result.rowCount).toBe(20);
      const run = await prisma.extractionRun.findUniqueOrThrow({ where: { id: result.extractionRunId } });
      expect(run.tileCount).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("flags EXTRACTION_INCOMPLETE when the balance chain has a break, and not when it doesn't", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video);
      await objectStore.put(submission.contentHash, video);

      const withGap = intactList.filter((_, i) => i !== 2); // drop the 101→100 row
      await runExtraction(deps(objectStore, new FakeVisionExtractor(listReader(withGap))), submission.id);
      let flags = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(flags.some((f) => f.code === "EXTRACTION_INCOMPLETE")).toBe(true);

      await runExtraction(deps(objectStore, new FakeVisionExtractor(listReader(intactList)), "v2"), submission.id);
      flags = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(flags.some((f) => f.code === "EXTRACTION_INCOMPLETE")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("flags WAGER_SHORTFALL when wagered total is under the granted amount", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video, 1000);
      await objectStore.put(submission.contentHash, video);
      await runExtraction(deps(objectStore, new FakeVisionExtractor(listReader(intactList))), submission.id);
      const flags = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(flags.some((f) => f.code === "WAGER_SHORTFALL")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("flags ARITHMETIC_MISMATCH when a row's own balances don't move by its amount", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video);
      await objectStore.put(submission.contentHash, video);
      const bad = [{ timestamp: "2026-09-15 12:00", type: "bet" as const, amount: -10, balanceBefore: 100, balanceAfter: 50 }];
      await runExtraction(deps(objectStore, new FakeVisionExtractor(listReader(bad))), submission.id);
      const flags = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(flags.some((f) => f.code === "ARITHMETIC_MISMATCH")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("marks the run failed when the object store can't find the media", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video);
      await expect(runExtraction(deps(objectStore, new FakeVisionExtractor()), submission.id)).rejects.toThrow();
      const run = await prisma.extractionRun.findFirstOrThrow({ where: { submissionId: submission.id } });
      expect(run.status).toBe("failed");
      expect(run.error).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it("replaces stale extraction-derived flags on re-run, but leaves ingest-time flags alone", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const { submission } = await makeFundedSubmission(video);
      await objectStore.put(submission.contentHash, video);

      await prisma.integrityFlag.create({
        data: { submissionId: submission.id, code: "MANUAL_INTAKE", severity: "info", detail: "test fixture", generatedBy: "test" },
      });

      const broken = [{ timestamp: "2026-09-15 12:00", type: "bet" as const, amount: -10, balanceBefore: 100, balanceAfter: 50 }];
      await runExtraction(deps(objectStore, new FakeVisionExtractor(listReader(broken)), "v1"), submission.id);
      const afterFirstRun = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(afterFirstRun.some((f) => f.code === "ARITHMETIC_MISMATCH")).toBe(true);
      expect(afterFirstRun.some((f) => f.code === "MANUAL_INTAKE")).toBe(true);

      const fixed = [{ timestamp: "2026-09-15 12:00", type: "bet" as const, amount: -10, balanceBefore: 100, balanceAfter: 90 }];
      await runExtraction(deps(objectStore, new FakeVisionExtractor(listReader(fixed)), "v2"), submission.id);
      const afterSecondRun = await prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
      expect(afterSecondRun.some((f) => f.code === "ARITHMETIC_MISMATCH")).toBe(false);
      expect(afterSecondRun.filter((f) => f.code === "MANUAL_INTAKE")).toHaveLength(1);

      const runs = await prisma.extractionRun.findMany({ where: { submissionId: submission.id } });
      expect(runs).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});

describe("runExtraction — hardening", () => {
  const prisma = new PrismaClient();
  let video: Buffer;

  beforeAll(async () => {
    await resetDb(prisma);
    video = (await makeScrollVideo({ rowCount: 24, speed: 400 })).buffer;
  });
  afterEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function funded(videoBuffer: Buffer) {
    const participant = await prisma.participant.create({ data: {} });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino", state: "funded" } });
    const contentHash = sha256Hex(videoBuffer);
    const mediaAsset = await prisma.mediaAsset.create({ data: { blobKey: contentHash, contentHash, bytes: videoBuffer.byteLength } });
    return prisma.submission.create({ data: { enrollmentId: enrollment.id, kind: "wager_recording", channel: "dropbox", mediaAssetId: mediaAsset.id, contentHash } });
  }

  const list: Array<Partial<RawExtractedRow>> = [
    { timestamp: "2026-09-15 12:05", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 },
    { timestamp: "2026-09-15 12:04", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 },
    { timestamp: "2026-09-15 12:03", type: "bet", amount: -1, balanceBefore: 101, balanceAfter: 100 },
    { timestamp: "2026-09-15 12:02", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 },
    { timestamp: "2026-09-15 12:01", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 },
    { timestamp: "2026-09-15 12:00", type: "deposit", amount: 100, balanceBefore: 0, balanceAfter: 100 },
  ];

  it("re-reads the tiles around a chain break before flagging, and keeps the better read", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const sub = await funded(video);
      await objectStore.put(sub.contentHash, video);

      // First read of any tile misreads row 2's balance; every later read is right.
      let calls = 0;
      const extractor = new FakeVisionExtractor((tile) => {
        calls++;
        const wrong = calls === 1;
        return listReader(list.map((r, i) => (wrong && i === 2 ? { ...r, balanceBefore: 105 } : r)))(tile);
      });
      const result = await runExtraction({ prisma, objectStore, visionExtractor: extractor, extractorVersion: "test", panoramaFps: 10 }, sub.id);

      expect(result.chainComplete).toBe(true);
      const run = await prisma.extractionRun.findUniqueOrThrow({ where: { id: result.extractionRunId } });
      expect(run.retryTiles).toBe(1);
      const flags = await prisma.integrityFlag.findMany({ where: { submissionId: sub.id } });
      expect(flags.some((f) => f.code === "EXTRACTION_INCOMPLETE")).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("cross-checks timestamps and descriptions with a second reader and records disagreements per row", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const sub = await funded(video);
      await objectStore.put(sub.contentHash, video);

      const primary = new FakeVisionExtractor(listReader(list));
      const second = new FakeVisionExtractor(listReader(list.map((r, i) => (i === 3 ? { ...r, timestamp: "2026-09-15 12:09" } : r))));
      const result = await runExtraction(
        { prisma, objectStore, visionExtractor: primary, crossCheckExtractor: second, extractorVersion: "test", panoramaFps: 10 },
        sub.id,
      );

      const run = await prisma.extractionRun.findUniqueOrThrow({ where: { id: result.extractionRunId }, include: { rows: { orderBy: { sequence: "asc" } } } });
      expect(run.crossCheckModel).toBe("fake");
      expect(run.rows.every((r) => r.crossChecked)).toBe(true);
      expect(run.rows.map((r) => r.disagreements)).toEqual([[], [], [], ["timestamp"], [], []]);
      const flags = await prisma.integrityFlag.findMany({ where: { submissionId: sub.id } });
      expect(flags.find((f) => f.code === "READ_DISAGREEMENT")?.detail).toContain("row 3: timestamp");
    } finally {
      await cleanup();
    }
  });

  it("rejects a recording with no list and skips the model, unless forced", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      // A static frame of nothing: no scrolling list to reconstruct.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { mkdtemp, readFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "betlab-blank-"));
      const out = join(dir, "blank.mp4");
      await promisify(execFile)("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=white:s=320x480:r=10:d=4", "-pix_fmt", "yuv420p", out]);
      const blank = await readFile(out);
      await rm(dir, { recursive: true, force: true });

      const sub = await funded(blank);
      await objectStore.put(sub.contentHash, blank);
      let reads = 0;
      const extractor = new FakeVisionExtractor(() => {
        reads++;
        return [];
      });
      const deps = { prisma, objectStore, visionExtractor: extractor, extractorVersion: "test", panoramaFps: 10 };

      const result = await runExtraction(deps, sub.id);
      expect(result.quality.verdict).toBe("reject");
      expect(reads).toBe(0);
      const flags = await prisma.integrityFlag.findMany({ where: { submissionId: sub.id } });
      expect(flags.find((f) => f.code === "RECORDING_QUALITY")?.severity).toBe("high");

      await runExtraction(deps, sub.id, { force: true });
      expect(reads).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
