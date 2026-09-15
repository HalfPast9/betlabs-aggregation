import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { verifyDropboxSignature } from "../dropbox/webhook.js";
import { syncDropbox } from "../dropbox/sync.js";

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

    // Ack immediately; Dropbox expects a fast response and will retry on timeout.
    reply.code(200).send();

    try {
      await syncDropbox({
        prisma: deps.prisma,
        dropbox: deps.dropbox,
        objectStore: deps.objectStore,
        intakeRoot: deps.intakeRoot,
      });
    } catch (err) {
      app.log.error(err, "dropbox sync failed after webhook notification");
    }
  });
}
