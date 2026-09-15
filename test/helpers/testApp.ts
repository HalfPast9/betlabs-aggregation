import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { FakeDropboxClient } from "../../src/dropbox/fakeClient.js";
import { createTmpObjectStore } from "./tmpObjectStore.js";

export const STAFF_TOKEN = "test-token";
export const INTAKE_ROOT = "/betlab-intake";

export async function buildTestContext() {
  const prisma = new PrismaClient();
  const dropbox = new FakeDropboxClient();
  const { store: objectStore, cleanup: cleanupObjectStore } = await createTmpObjectStore();
  const app = buildApp({
    prisma,
    dropbox,
    objectStore,
    staffApiToken: STAFF_TOKEN,
    intakeRoot: INTAKE_ROOT,
    logger: false,
  });
  await app.ready();

  return {
    app,
    prisma,
    dropbox,
    objectStore,
    async cleanup() {
      await app.close();
      await cleanupObjectStore();
      await prisma.$disconnect();
    },
  };
}

export async function resetDb(prisma: PrismaClient) {
  await prisma.auditEvent.deleteMany();
  await prisma.submission.deleteMany();
  await prisma.mediaAsset.deleteMany();
  await prisma.fileRequest.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.participant.deleteMany();
  await prisma.dropboxCursor.deleteMany();
}

export function authHeaders(token = STAFF_TOKEN) {
  return { authorization: `Bearer ${token}` };
}
