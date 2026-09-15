import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { PrismaClient } from "@prisma/client";
import type { DropboxClient } from "./dropbox/client.js";
import type { ObjectStore } from "./storage/objectStore.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerParticipantRoutes } from "./routes/participants.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerSubmissionRoutes } from "./routes/submissions.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface AppDeps {
  prisma: PrismaClient;
  dropbox: DropboxClient;
  objectStore: ObjectStore;
  staffApiToken: string;
  dropboxAppSecret?: string;
  intakeRoot: string;
  logger?: boolean;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  // Capture the raw body alongside JSON parsing so the Dropbox webhook route
  // can verify X-Dropbox-Signature against the exact bytes Dropbox sent.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.register(multipart);

  app.register(registerHealthRoutes);
  app.register(registerParticipantRoutes, { deps });
  app.register(registerWebhookRoutes, { deps });
  app.register(registerSubmissionRoutes, { deps });

  return app;
}
