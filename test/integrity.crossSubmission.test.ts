import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { checkDuplicateMedia, checkSharedRows } from "../src/integrity/crossSubmission.js";
import { resetDb } from "./helpers/testApp.js";

describe("checkDuplicateMedia", () => {
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

  it("flags a media asset whose stored dHash is within the similarity threshold", async () => {
    const existing = await prisma.mediaAsset.create({
      data: { blobKey: "h1", contentHash: "h1", bytes: 1, sourceMeta: { dHash: "ff00ff00ff00ff00" } },
    });
    const target = await prisma.mediaAsset.create({
      data: { blobKey: "h2", contentHash: "h2", bytes: 1 },
    });

    // Same hash exactly -> distance 0, well within threshold.
    const flag = await checkDuplicateMedia(prisma, target.id, BigInt("0xff00ff00ff00ff00"));
    expect(flag?.code).toBe("DUPLICATE_MEDIA");
    expect(flag?.detail).toContain(existing.id);
  });

  it("does not flag a perceptually distant hash", async () => {
    await prisma.mediaAsset.create({
      data: { blobKey: "h3", contentHash: "h3", bytes: 1, sourceMeta: { dHash: "0000000000000000" } },
    });
    const target = await prisma.mediaAsset.create({ data: { blobKey: "h4", contentHash: "h4", bytes: 1 } });

    const flag = await checkDuplicateMedia(prisma, target.id, BigInt("0xffffffffffffffff"));
    expect(flag).toBeNull();
  });
});

describe("checkSharedRows", () => {
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

  async function makeExtractionRunWithRows(participantId: string | undefined, rowKeys: string[]) {
    const p = participantId ? { id: participantId } : await prisma.participant.create({ data: {} });
    const enrollment = await prisma.enrollment.create({ data: { participantId: p.id, casino: "AcmeCasino" } });
    const mediaAsset = await prisma.mediaAsset.create({
      data: { blobKey: `blob-${enrollment.id}`, contentHash: `hash-${enrollment.id}`, bytes: 1 },
    });
    const submission = await prisma.submission.create({
      data: {
        enrollmentId: enrollment.id,
        kind: "wager_recording",
        channel: "dropbox",
        mediaAssetId: mediaAsset.id,
        contentHash: mediaAsset.contentHash,
      },
    });
    const run = await prisma.extractionRun.create({
      data: { submissionId: submission.id, extractorVersion: "test", model: "test", status: "succeeded" },
    });
    for (const [sequence, rowKey] of rowKeys.entries()) {
      await prisma.transactionRow.create({ data: { extractionRunId: run.id, sequence, rowKey } });
    }
    return { participant: p, enrollment, run };
  }

  it("flags rows that also appear in another participant's extraction run", async () => {
    const a = await makeExtractionRunWithRows(undefined, ["rowkey-shared", "rowkey-a-only"]);
    const b = await makeExtractionRunWithRows(undefined, ["rowkey-shared", "rowkey-b-only"]);

    const flag = await checkSharedRows(prisma, b.run.id, b.participant.id, ["rowkey-shared", "rowkey-b-only"]);
    expect(flag?.code).toBe("SHARED_ROWS");
    void a;
  });

  it("does not flag rows unique to the participant's own submissions", async () => {
    const a = await makeExtractionRunWithRows(undefined, ["rowkey-1", "rowkey-2"]);

    const flag = await checkSharedRows(prisma, a.run.id, a.participant.id, ["rowkey-1", "rowkey-2"]);
    expect(flag).toBeNull();
  });

  it("does not flag rows repeated across the same participant's own enrollments", async () => {
    const participant = await prisma.participant.create({ data: {} });
    await makeExtractionRunWithRows(participant.id, ["rowkey-x"]);
    const second = await makeExtractionRunWithRows(participant.id, ["rowkey-x"]);

    const flag = await checkSharedRows(prisma, second.run.id, participant.id, ["rowkey-x"]);
    expect(flag).toBeNull();
  });
});
