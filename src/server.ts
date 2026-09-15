import { loadConfig } from "./config.js";
import { getPrisma } from "./db/client.js";
import { createObjectStore } from "./storage/objectStore.js";
import { createDropboxClient } from "./dropbox/client.js";
import { buildApp } from "./app.js";
import { startDropboxPolling } from "./jobs/pollDropbox.js";

async function main() {
  const config = loadConfig();
  const prisma = getPrisma();
  const objectStore = createObjectStore(config);
  const dropbox = createDropboxClient(config);

  const app = buildApp({
    prisma,
    dropbox,
    objectStore,
    staffApiToken: config.STAFF_API_TOKEN,
    dropboxAppSecret: config.DROPBOX_APP_SECRET,
    intakeRoot: config.DROPBOX_INTAKE_ROOT,
  });

  startDropboxPolling(
    { prisma, dropbox, objectStore, intakeRoot: config.DROPBOX_INTAKE_ROOT },
    config.DROPBOX_POLL_INTERVAL_MS,
    (err) => app.log.error(err, "dropbox polling failed"),
  );

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
