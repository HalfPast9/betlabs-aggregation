import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { sha256Hex } from "../lib/hash.js";

const searchQuerySchema = z.object({
  participantId: z.string().optional(),
  enrollmentId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function registerSubmissionRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.staffApiToken));

  app.post("/submissions/manual", async (request, reply) => {
    const parts = request.parts();
    let enrollmentId: string | undefined;
    let kind: string = "wager_recording";
    let fileBuffer: Buffer | undefined;

    for await (const part of parts) {
      if (part.type === "file") {
        fileBuffer = await part.toBuffer();
      } else if (part.fieldname === "enrollmentId") {
        enrollmentId = part.value as string;
      } else if (part.fieldname === "kind") {
        kind = part.value as string;
      }
    }

    if (!enrollmentId || !fileBuffer) {
      reply.code(400).send({ error: "enrollmentId and file are required" });
      return;
    }

    const enrollment = await deps.prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment) {
      reply.code(404).send({ error: "enrollment not found" });
      return;
    }

    const contentHash = sha256Hex(fileBuffer);
    const existing = await deps.prisma.mediaAsset.findUnique({ where: { contentHash } });
    if (existing) {
      reply.code(409).send({ error: "duplicate media", contentHash });
      return;
    }

    await deps.objectStore.put(contentHash, fileBuffer);
    const submission = await deps.prisma.$transaction(async (tx) => {
      const mediaAsset = await tx.mediaAsset.create({
        data: { blobKey: contentHash, contentHash, bytes: fileBuffer!.byteLength },
      });
      return tx.submission.create({
        data: {
          enrollmentId: enrollmentId!,
          kind,
          channel: "manual_upload",
          mediaAssetId: mediaAsset.id,
          contentHash,
        },
      });
    });

    reply.code(201).send(submission);
  });

  app.get("/submissions", async (request, reply) => {
    const query = searchQuerySchema.parse(request.query ?? {});
    const submissions = await deps.prisma.submission.findMany({
      where: {
        enrollmentId: query.enrollmentId,
        enrollment: query.participantId ? { participantId: query.participantId } : undefined,
        receivedAt: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      include: { mediaAsset: true, enrollment: { include: { participant: true } } },
      orderBy: { receivedAt: "desc" },
    });
    reply.send(submissions);
  });

  app.get<{ Params: { id: string } }>("/submissions/:id/media", async (request, reply) => {
    const submission = await deps.prisma.submission.findUnique({
      where: { id: request.params.id },
      include: { mediaAsset: true },
    });
    if (!submission) {
      reply.code(404).send({ error: "submission not found" });
      return;
    }

    const data = await deps.objectStore.get(submission.mediaAsset.blobKey);

    await deps.prisma.auditEvent.create({
      data: {
        actor: (request.headers["x-staff-actor"] as string | undefined) ?? "unknown-staff",
        action: "view_raw_media",
        target: submission.id,
      },
    });

    reply
      .type(submission.mediaAsset.mime ?? "application/octet-stream")
      .send(data);
  });
}
