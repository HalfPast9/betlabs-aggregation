import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { syncDropbox } from "../src/dropbox/sync.js";
import { FakeDropboxClient } from "../src/dropbox/fakeClient.js";
import { createTmpObjectStore } from "./helpers/tmpObjectStore.js";
import { resetDb } from "./helpers/testApp.js";

const INTAKE_ROOT = "/betlab-intake";

describe("syncDropbox", () => {
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

  async function makeEnrollment() {
    const participant = await prisma.participant.create({ data: { contact: "whatsapp:123" } });
    return prisma.enrollment.create({
      data: { participantId: participant.id, casino: "TestCasino" },
    });
  }

  it("archives a new file, records the submission, and purges the Dropbox copy", async () => {
    const enrollment = await makeEnrollment();
    const dropbox = new FakeDropboxClient();
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    const path = `${INTAKE_ROOT}/${enrollment.id}/recording.mp4`;
    dropbox.seedFile(path, Buffer.from("fake screen recording bytes"));

    try {
      const result = await syncDropbox({ prisma, dropbox, objectStore, intakeRoot: INTAKE_ROOT });
      expect(result).toEqual({ ingested: 1, skipped: 0 });

      const submissions = await prisma.submission.findMany({
        where: { enrollmentId: enrollment.id },
        include: { mediaAsset: true },
      });
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.channel).toBe("dropbox");
      expect(submissions[0]?.kind).toBe("wager_recording");
      expect(await objectStore.exists(submissions[0]!.mediaAsset.blobKey)).toBe(true);

      // The Dropbox copy was purged after archiving.
      await expect(dropbox.download(path)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("does not duplicate a submission when synced twice against the same cursor progress", async () => {
    const enrollment = await makeEnrollment();
    const dropbox = new FakeDropboxClient();
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    const path = `${INTAKE_ROOT}/${enrollment.id}/recording.mp4`;
    dropbox.seedFile(path, Buffer.from("same bytes every time"));

    try {
      const first = await syncDropbox({ prisma, dropbox, objectStore, intakeRoot: INTAKE_ROOT });
      const second = await syncDropbox({ prisma, dropbox, objectStore, intakeRoot: INTAKE_ROOT });

      expect(first.ingested).toBe(1);
      expect(second.ingested).toBe(0);

      const submissions = await prisma.submission.findMany({
        where: { enrollmentId: enrollment.id },
      });
      expect(submissions).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("skips a file whose path does not resolve to a known enrollment", async () => {
    const dropbox = new FakeDropboxClient();
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    dropbox.seedFile(`${INTAKE_ROOT}/not-a-real-enrollment/recording.mp4`, Buffer.from("orphan"));

    try {
      const result = await syncDropbox({ prisma, dropbox, objectStore, intakeRoot: INTAKE_ROOT });
      expect(result).toEqual({ ingested: 0, skipped: 1 });

      const submissions = await prisma.submission.findMany();
      expect(submissions).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("dedupes identical content submitted under two different enrollments' paths", async () => {
    const enrollmentA = await makeEnrollment();
    const enrollmentB = await makeEnrollment();
    const dropbox = new FakeDropboxClient();
    const { store: objectStore, cleanup } = await createTmpObjectStore();
    const bytes = Buffer.from("identical recording reused across two enrollments");
    dropbox.seedFile(`${INTAKE_ROOT}/${enrollmentA.id}/recording.mp4`, bytes);
    dropbox.seedFile(`${INTAKE_ROOT}/${enrollmentB.id}/recording.mp4`, bytes);

    try {
      const result = await syncDropbox({ prisma, dropbox, objectStore, intakeRoot: INTAKE_ROOT });
      expect(result.ingested).toBe(1);
      expect(result.skipped).toBe(1);

      const submissions = await prisma.submission.findMany();
      expect(submissions).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
