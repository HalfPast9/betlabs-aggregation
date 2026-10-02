import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createExtractionQueue } from "../src/jobs/extractionQueue.js";
import { FakeVisionExtractor } from "../src/extraction/fakeVisionExtractor.js";
import { sha256Hex } from "../src/lib/hash.js";
import { createTmpObjectStore } from "./helpers/tmpObjectStore.js";
import { resetDb } from "./helpers/testApp.js";
import { makeScrollVideo } from "./helpers/scrollVideo.js";

describe("extraction queue", () => {
  const prisma = new PrismaClient();
  let video: Buffer;

  beforeAll(async () => {
    await resetDb(prisma);
    video = (await makeScrollVideo({ rowCount: 6, speed: 400 })).buffer;
  });
  afterEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function submission() {
    const participant = await prisma.participant.create({ data: {} });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino", state: "funded" } });
    const contentHash = sha256Hex(video);
    const mediaAsset = await prisma.mediaAsset.create({ data: { blobKey: contentHash, contentHash, bytes: video.byteLength } });
    return prisma.submission.create({ data: { enrollmentId: enrollment.id, kind: "wager_recording", channel: "dropbox", mediaAssetId: mediaAsset.id, contentHash } });
  }

  it("returns a pending run at once and finishes it in the background", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const sub = await submission();
      await objectStore.put(sub.contentHash, video);
      const queue = createExtractionQueue({ prisma, objectStore, visionExtractor: new FakeVisionExtractor(), extractorVersion: "test", panoramaFps: 10 }, () => {});

      const { runId } = await queue.enqueue(sub.id);
      const early = await prisma.extractionRun.findUniqueOrThrow({ where: { id: runId } });
      expect(["pending", "running"]).toContain(early.status);

      await queue.drain();
      const done = await prisma.extractionRun.findUniqueOrThrow({ where: { id: runId } });
      expect(done.status).toBe("succeeded");
      expect(done.frameCount).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("re-queues runs a previous process left unfinished", async () => {
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    try {
      const sub = await submission();
      await objectStore.put(sub.contentHash, video);
      const orphan = await prisma.extractionRun.create({ data: { submissionId: sub.id, extractorVersion: "test", model: "fake", status: "running" } });

      const queue = createExtractionQueue({ prisma, objectStore, visionExtractor: new FakeVisionExtractor(), extractorVersion: "test", panoramaFps: 10 }, () => {});
      expect(await queue.recover()).toBe(1);
      await queue.drain();
      const done = await prisma.extractionRun.findUniqueOrThrow({ where: { id: orphan.id } });
      expect(done.status).toBe("succeeded");
    } finally {
      await cleanup();
    }
  });
});
