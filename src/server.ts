import { loadConfig } from "./config.js";
import { getPrisma } from "./db/client.js";
import { createObjectStore } from "./storage/objectStore.js";
import { createDropboxClient } from "./dropbox/client.js";
import { createEmailSender } from "./email/factory.js";
import { createCrossCheckExtractor, createVisionExtractor } from "./extraction/factory.js";
import { createExtractionQueue } from "./jobs/extractionQueue.js";
import { createSheetsExporter } from "./sheets/factory.js";
import { buildApp, type AppDeps } from "./app.js";
import { buildSyncDeps } from "./dropbox/sync.js";
import { startDropboxPolling } from "./jobs/pollDropbox.js";
import { startRetentionSchedule } from "./jobs/scheduleRetention.js";
import { startDropboxQuotaMonitor } from "./jobs/monitorDropboxQuota.js";
import { ensureBootstrapAdmin } from "./lib/auth.js";

const RETENTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // twice-daily is plenty for a day-granularity policy

async function main() {
  const config = loadConfig();
  const prisma = getPrisma();
  const objectStore = createObjectStore(config);
  const dropbox = createDropboxClient(config);
  const emailSender = createEmailSender(config);
  const visionExtractor = createVisionExtractor(config);
  const crossCheckExtractor = createCrossCheckExtractor(config);

  await ensureBootstrapAdmin(prisma, config.STAFF_API_TOKEN);

  const extractionQueue = createExtractionQueue(
    { prisma, objectStore, visionExtractor, crossCheckExtractor, extractorVersion: config.EXTRACTOR_VERSION, panoramaFps: config.PANORAMA_FPS },
    (err, runId) => console.error(`extraction run ${runId} failed:`, err),
  );

  const deps: AppDeps = {
    prisma,
    dropbox,
    objectStore,
    emailSender,
    visionExtractor,
    extractionQueue,
    sheetsExporter: createSheetsExporter(config, objectStore),
    publicBaseUrl: config.PUBLIC_BASE_URL,
    staffApiToken: config.STAFF_API_TOKEN,
    dropboxAppSecret: config.DROPBOX_APP_SECRET,
    intakeRoot: config.DROPBOX_INTAKE_ROOT,
    inboundEmailToken: config.INBOUND_EMAIL_TOKEN,
    extractorVersion: config.EXTRACTOR_VERSION,
    panoramaFps: config.PANORAMA_FPS,
    autoExtractOnIngest: config.AUTO_EXTRACT_ON_INGEST,
    dropboxQuotaWarningThreshold: config.DROPBOX_QUOTA_WARNING_THRESHOLD,
  };

  const app = buildApp(deps);

  const recovered = await extractionQueue.recover();
  if (recovered > 0) app.log.info(`re-queued ${recovered} extraction run(s) left unfinished by a previous process`);

  startDropboxPolling(buildSyncDeps(deps), config.DROPBOX_POLL_INTERVAL_MS, (err) =>
    app.log.error(err, "dropbox polling failed"),
  );
  startRetentionSchedule(prisma, objectStore, RETENTION_CHECK_INTERVAL_MS, (err) =>
    app.log.error(err, "retention job failed"),
  );
  startDropboxQuotaMonitor(
    prisma,
    dropbox,
    config.DROPBOX_QUOTA_WARNING_THRESHOLD,
    config.DROPBOX_QUOTA_CHECK_INTERVAL_MS,
    (err) => app.log.error(err, "dropbox quota check failed"),
  );

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
