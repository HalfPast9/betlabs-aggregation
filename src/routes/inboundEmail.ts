import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { handleInboundEmail } from "../email/inboundEmail.js";

/**
 * PRD D12 — no inbound-parse provider is chosen yet. This accepts either:
 *  - the raw MIME bytes directly as the request body (any content type not
 *    otherwise handled — what our own tests use, and what a provider or
 *    SMTP relay that forwards bytes untouched would send), or
 *  - a `multipart/form-data` POST with the raw MIME in a form field (the
 *    shape SendGrid Inbound Parse uses when configured to "POST the raw,
 *    full MIME message").
 * Whichever provider Betlab ends up with, the requirement is unchanged
 * (PRD §7.2): it must deliver raw, unmodified MIME.
 */
export async function registerInboundEmailRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;

  app.post<{ Querystring: { token?: string } }>("/inbound/email", async (request, reply) => {
    if (deps.inboundEmailToken && request.query.token !== deps.inboundEmailToken) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const raw = await extractRawMime(request);
    if (!raw || raw.length === 0) {
      reply.code(400).send({ error: "no email content found in request" });
      return;
    }

    const outcome = await handleInboundEmail(
      {
        prisma: deps.prisma,
        objectStore: deps.objectStore,
        emailSender: deps.emailSender,
        dkimResolver: deps.dkimResolver,
      },
      raw,
    );

    reply.code(200).send(outcome);
  });
}

async function extractRawMime(request: FastifyRequest): Promise<Buffer | null> {
  const contentType = request.headers["content-type"] ?? "";

  if (contentType.includes("multipart/form-data")) {
    for await (const part of request.parts()) {
      if (part.fieldname !== "email") continue;
      if (part.type === "file") return part.toBuffer();
      return Buffer.from(String(part.value), "utf8");
    }
    return null;
  }

  return request.rawBody ?? null;
}
