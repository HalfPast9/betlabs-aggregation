import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { verifyDropboxSignature } from "../dropbox/webhook.js";
import { syncDropbox, buildSyncDeps } from "../dropbox/sync.js";

export async function registerWebhookRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;

  // Dropbox's webhook verification handshake: echo the challenge back verbatim.
  app.get<{ Querystring: { challenge?: string } }>("/webhooks/dropbox", async (request, reply) => {
    reply.type("text/plain").send(request.query.challenge ?? "");
  });

  app.post("/webhooks/dropbox", async (request, reply) => {
    if (deps.dropboxAppSecret) {
      const signature = request.headers["x-dropbox-signature"];
      const valid = verifyDropboxSignature(
        request.rawBody ?? Buffer.alloc(0),
        typeof signature === "string" ? signature : undefined,
        deps.dropboxAppSecret,
      );
      if (!valid) {
        reply.code(403).send({ error: "invalid signature" });
        return;
      }
    }

    // Dropbox tolerates several seconds here and retries the notification on
    // timeout; retries are safe (cursor + content-hash dedup make sync
    // idempotent), so we wait for ingest to actually finish before acking —
    // otherwise the response would claim success before anything archived.
    try {
      await syncDropbox(buildSyncDeps(deps));
      reply.code(200).send();
    } catch (err) {
      app.log.error(err, "dropbox sync failed after webhook notification");
      reply.code(200).send();
    }
  });
}
