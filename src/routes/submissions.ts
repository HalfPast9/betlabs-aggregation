import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { sha256Hex } from "../lib/hash.js";
import { handleWagerRecordingSubmitted } from "../enrollment/wagerRecordingIngested.js";
import { checkManualIntake } from "../integrity/simpleFlags.js";
import { runExtraction } from "../extraction/runExtraction.js";

const searchQuerySchema = z.object({
  participantId: z.string().optional(),
  enrollmentId: z.string().optional(),
  casino: z.string().optional(),
  state: z.string().optional(),
  flag: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export async function registerSubmissionRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma));

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
    const { submission, advancedToWagerSubmitted } = await deps.prisma.$transaction(async (tx) => {
      const mediaAsset = await tx.mediaAsset.create({
        data: { blobKey: contentHash, contentHash, bytes: fileBuffer!.byteLength },
      });
      const submission = await tx.submission.create({
        data: {
          enrollmentId: enrollmentId!,
          kind,
          channel: "manual_upload",
          mediaAssetId: mediaAsset.id,
          contentHash,
        },
      });

      const manualIntakeFlag = checkManualIntake(submission.channel);
      if (manualIntakeFlag) {
        await tx.integrityFlag.create({
          data: {
            submissionId: submission.id,
            code: manualIntakeFlag.code,
            severity: manualIntakeFlag.severity,
            detail: manualIntakeFlag.detail,
            generatedBy: "manual-upload-route",
          },
        });
      }

      let advancedToWagerSubmitted = false;
      if (kind === "wager_recording") {
        ({ advancedToWagerSubmitted } = await handleWagerRecordingSubmitted(
          tx,
          enrollment,
          submission.id,
          "manual-upload-route",
        ));
      }

      return { submission, advancedToWagerSubmitted };
    });

    if (advancedToWagerSubmitted && deps.autoExtractOnIngest) {
      try {
        await runExtraction(
          {
            prisma: deps.prisma,
            objectStore: deps.objectStore,
            visionExtractor: deps.visionExtractor,
            extractorVersion: deps.extractorVersion,
            frameIntervalSeconds: deps.frameIntervalSeconds,
            dedupHammingThreshold: deps.dedupHammingThreshold,
          },
          submission.id,
        );
      } catch (err) {
        app.log.error(err, "auto-extraction failed after manual upload");
      }
    }

    reply.code(201).send(submission);
  });

  // PRD §6.4: "submission list with filters (participant, casino, date, flag, status)".
  app.get("/submissions", async (request, reply) => {
    const query = searchQuerySchema.parse(request.query ?? {});
    const submissions = await deps.prisma.submission.findMany({
      where: {
        enrollmentId: query.enrollmentId,
        enrollment: {
          participantId: query.participantId,
          casino: query.casino,
          state: query.state,
        },
        integrityFlags: query.flag ? { some: { code: query.flag } } : undefined,
        receivedAt: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      include: {
        mediaAsset: true,
        enrollment: { include: { participant: true } },
        integrityFlags: true,
        emailEvidence: true,
      },
      orderBy: { receivedAt: "desc" },
    });
    reply.send(submissions);
  });

  // Full detail for the side-by-side review view (PRD §6.4).
  app.get<{ Params: { id: string } }>("/submissions/:id", async (request, reply) => {
    const submission = await deps.prisma.submission.findUnique({
      where: { id: request.params.id },
      include: {
        mediaAsset: true,
        enrollment: { include: { participant: true, grant: true } },
        integrityFlags: true,
        emailEvidence: true,
        extractionRuns: {
          include: { rows: { orderBy: { sourceFrameTs: "asc" } }, reconciliation: true },
          orderBy: { startedAt: "desc" },
        },
      },
    });
    if (!submission) {
      reply.code(404).send({ error: "submission not found" });
      return;
    }
    reply.send(submission);
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
    if (submission.mediaAsset.deletedAt) {
      reply.code(410).send({ error: "raw media was purged under the retention policy", deletedAt: submission.mediaAsset.deletedAt });
      return;
    }

    const data = await deps.objectStore.get(submission.mediaAsset.blobKey);

    await deps.prisma.auditEvent.create({
      data: {
        actor: request.staffUser?.name ?? "unknown-staff",
        action: "view_raw_media",
        target: submission.id,
      },
    });

    reply
      .type(submission.mediaAsset.mime ?? "application/octet-stream")
      .send(data);
  });
}
