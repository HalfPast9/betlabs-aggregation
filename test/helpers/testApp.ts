import { PrismaClient } from "@prisma/client";
import type { DNSResolver } from "mailauth";
import { buildApp } from "../../src/app.js";
import { FakeDropboxClient } from "../../src/dropbox/fakeClient.js";
import { FakeEmailSender } from "../../src/email/sender.js";
import { FakeVisionExtractor, type TileScript } from "../../src/extraction/fakeVisionExtractor.js";
import { ensureBootstrapAdmin } from "../../src/lib/auth.js";
import { createExtractionQueue } from "../../src/jobs/extractionQueue.js";
import { FakeSheetsExporter } from "../../src/sheets/fakeSheetsExporter.js";
import { createTmpObjectStore } from "./tmpObjectStore.js";

export const STAFF_TOKEN = "test-token";
export const INTAKE_ROOT = "/betlab-intake";

export interface BuildTestContextOptions {
  visionScript?: TileScript;
  dkimResolver?: DNSResolver;
  autoExtractOnIngest?: boolean;
  inboundEmailToken?: string;
}

export async function buildTestContext(opts: BuildTestContextOptions = {}) {
  const prisma = new PrismaClient();
  await ensureBootstrapAdmin(prisma, STAFF_TOKEN);
  const dropbox = new FakeDropboxClient();
  const emailSender = new FakeEmailSender();
  const visionExtractor = new FakeVisionExtractor(opts.visionScript);
  const { store: objectStore, cleanup: cleanupObjectStore } = await createTmpObjectStore();
  const extractionQueue = createExtractionQueue(
    { prisma, objectStore, visionExtractor, extractorVersion: "test", panoramaFps: 10 },
    (err, runId) => console.error(`test extraction run ${runId} failed:`, err),
  );
  const app = buildApp({
    prisma,
    dropbox,
    objectStore,
    emailSender,
    visionExtractor,
    extractionQueue,
    sheetsExporter: new FakeSheetsExporter(objectStore, "http://test.local"),
    publicBaseUrl: "http://test.local",
    staffApiToken: STAFF_TOKEN,
    intakeRoot: INTAKE_ROOT,
    dkimResolver: opts.dkimResolver,
    inboundEmailToken: opts.inboundEmailToken,
    extractorVersion: "test",
    panoramaFps: 10,
    autoExtractOnIngest: opts.autoExtractOnIngest ?? true,
    dropboxQuotaWarningThreshold: 0.9,
    logger: false,
  });
  await app.ready();

  return {
    app,
    prisma,
    dropbox,
    objectStore,
    emailSender,
    visionExtractor,
    extractionQueue,
    async cleanup() {
      await extractionQueue.drain();
      await app.close();
      await cleanupObjectStore();
      await prisma.$disconnect();
    },
  };
}

export async function resetDb(prisma: PrismaClient) {
  await prisma.auditEvent.deleteMany();
  await prisma.decision.deleteMany();
  await prisma.grant.deleteMany();
  await prisma.transactionRow.deleteMany();
  await prisma.reconciliation.deleteMany();
  await prisma.extractionRun.deleteMany();
  await prisma.integrityFlag.deleteMany();
  await prisma.emailEvidence.deleteMany();
  await prisma.submission.deleteMany();
  await prisma.mediaAsset.deleteMany();
  await prisma.fileRequest.deleteMany();
  await prisma.dkimAllowedSigner.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.participant.deleteMany();
  await prisma.dropboxCursor.deleteMany();
  await prisma.retentionSettings.deleteMany();
}

export function authHeaders(token = STAFF_TOKEN) {
  return { authorization: `Bearer ${token}` };
}
