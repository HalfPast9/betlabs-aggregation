import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { PrismaClient } from "@prisma/client";
import type { DNSResolver } from "mailauth";
import type { DropboxClient } from "./dropbox/client.js";
import type { ObjectStore } from "./storage/objectStore.js";
import type { EmailSender } from "./email/sender.js";
import type { VisionExtractor } from "./extraction/visionExtractor.js";
import type { ExtractionQueue } from "./jobs/extractionQueue.js";
import type { SheetsExporter } from "./sheets/exporter.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerParticipantRoutes } from "./routes/participants.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerSubmissionRoutes } from "./routes/submissions.js";
import { registerEnrollmentRoutes } from "./routes/enrollments.js";
import { registerInboundEmailRoutes } from "./routes/inboundEmail.js";
import { registerExtractionRoutes } from "./routes/extraction.js";
import { registerSheetRoutes } from "./routes/sheets.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerStaffRoutes } from "./routes/staff.js";
import { registerRetentionRoutes } from "./routes/retention.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerOpsRoutes } from "./routes/ops.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export interface AppDeps {
  prisma: PrismaClient;
  dropbox: DropboxClient;
  objectStore: ObjectStore;
  emailSender: EmailSender;
  visionExtractor: VisionExtractor;
  /** Runs extraction in the background; every trigger goes through it. */
  extractionQueue: ExtractionQueue;
  sheetsExporter: SheetsExporter;
  /** How this service is reached — used for links inside exports. */
  publicBaseUrl: string;
  staffApiToken: string;
  dropboxAppSecret?: string;
  intakeRoot: string;
  inboundEmailToken?: string;
  dkimResolver?: DNSResolver;
  extractorVersion: string;
  panoramaFps: number;
  autoExtractOnIngest: boolean;
  dropboxQuotaWarningThreshold: number;
  logger?: boolean;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 64 * 1024 * 1024 });

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

  // The inbound-email route needs the exact raw MIME bytes (PRD §7.2 — "must
  // require raw MIME, not a parsed or normalized representation"), whatever
  // content type the sender used.
  app.addContentTypeParser(
    ["message/rfc822", "text/plain", "application/octet-stream"],
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      done(null, body);
    },
  );

  app.register(multipart);

  app.register(registerHealthRoutes);
  app.register(registerParticipantRoutes, { deps });
  app.register(registerWebhookRoutes, { deps });
  app.register(registerSubmissionRoutes, { deps });
  app.register(registerEnrollmentRoutes, { deps });
  app.register(registerInboundEmailRoutes, { deps });
  app.register(registerExtractionRoutes, { deps });
  app.register(registerSheetRoutes, { deps });
  app.register(registerExportRoutes, { deps });
  app.register(registerStaffRoutes, { deps });
  app.register(registerRetentionRoutes, { deps });
  app.register(registerMeRoutes, { deps });
  app.register(registerConsoleRoutes);
  app.register(registerOpsRoutes, { deps });

  return app;
}
