import type { FastifyInstance } from "fastify";
import { z } from "zod";
import sharp from "sharp";
import { renderEvidencePdf } from "../extraction/evidencePdf.js";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { sha256Hex } from "../lib/hash.js";
import { handleWagerRecordingSubmitted } from "../enrollment/wagerRecordingIngested.js";
import { handleEmailEvidenceSubmitted } from "../enrollment/emailEvidenceIngested.js";
import { checkManualIntake } from "../integrity/simpleFlags.js";
import { verifyEmailEvidence } from "../email/verifyEmailEvidence.js";

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

    // DKIM verification does real DNS I/O — run it before opening the
    // transaction, same rule as the automated inbound-email path. A runner
    // relaying a real .eml gets the exact same verification and tier as one
    // that arrived through the automated matcher (PRD §7.2) — which door it
    // came through shouldn't change how much the evidence is worth.
    const emailEvidence =
      kind === "signup_email"
        ? await verifyEmailEvidence(deps.prisma, enrollment.casino, fileBuffer, deps.dkimResolver)
        : null;

    await deps.objectStore.put(contentHash, fileBuffer);
    const { submission, advancedToWagerSubmitted } = await deps.prisma.$transaction(async (tx) => {
      const mediaAsset = await tx.mediaAsset.create({
        data: {
          blobKey: contentHash,
          contentHash,
          bytes: fileBuffer!.byteLength,
          mime: kind === "signup_email" ? "message/rfc822" : undefined,
        },
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
      } else if (kind === "signup_email" && emailEvidence) {
        await tx.emailEvidence.create({
          data: { submissionId: submission.id, verifiedAt: new Date(), ...emailEvidence },
        });
        await handleEmailEvidenceSubmitted(tx, enrollment, emailEvidence.dkimResult, emailEvidence.tier);
      }

      return { submission, advancedToWagerSubmitted };
    });

    let extractionRunId: string | null = null;
    if (advancedToWagerSubmitted && deps.autoExtractOnIngest) {
      extractionRunId = (await deps.extractionQueue.enqueue(submission.id)).runId;
    }

    reply.code(201).send({ ...submission, extractionRunId });
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
          include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true },
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

  // The stitched list an extraction run read from. Derived from the raw
  // media, so it gets the same PRD §9 access audit.
  app.get<{ Params: { id: string; runId: string } }>("/submissions/:id/extraction-runs/:runId/panorama", async (request, reply) => {
    const run = await deps.prisma.extractionRun.findFirst({
      where: { id: request.params.runId, submissionId: request.params.id },
    });
    if (!run || !run.panoramaBlobKey) {
      reply.code(404).send({ error: "no panorama for this extraction run" });
      return;
    }
    let data: Buffer;
    try {
      data = await deps.objectStore.get(run.panoramaBlobKey);
    } catch {
      reply.code(410).send({ error: "panorama no longer in the object store" });
      return;
    }
    await deps.prisma.auditEvent.create({
      data: { actor: request.staffUser?.name ?? "unknown-staff", action: "view_panorama", target: request.params.id },
    });
    reply.type("image/png").send(data);
  });

  // Self-contained evidence document: verdicts, rows, and the stitched recording.
  app.get<{ Params: { id: string; runId: string } }>("/submissions/:id/extraction-runs/:runId/evidence.pdf", async (request, reply) => {
    const submission = await deps.prisma.submission.findUnique({
      where: { id: request.params.id },
      include: { enrollment: { include: { participant: true } }, integrityFlags: true },
    });
    const run = await deps.prisma.extractionRun.findFirst({
      where: { id: request.params.runId, submissionId: request.params.id },
      include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true },
    });
    if (!submission || !run) {
      reply.code(404).send({ error: "extraction run not found" });
      return;
    }
    let panorama: Buffer | null = null;
    if (run.panoramaBlobKey) {
      try {
        panorama = await deps.objectStore.get(run.panoramaBlobKey);
      } catch {
        panorama = null;
      }
    }
    const quality = run.quality as { verdict: string; reasons: string[] } | null;
    const rec = run.reconciliation;
    const pdf = await renderEvidencePdf({
      submissionId: submission.id,
      casino: submission.enrollment.casino,
      participant: submission.enrollment.participant.contact ?? submission.enrollment.participant.email ?? submission.enrollment.participant.id,
      receivedAt: submission.receivedAt,
      run: { id: run.id, model: run.model, extractorVersion: run.extractorVersion, startedAt: run.startedAt, quality },
      reconciliation: rec
        ? {
            wageredTotal: Number(rec.wageredTotal),
            grantedAmount: rec.grantedAmount === null ? null : Number(rec.grantedAmount),
            chainComplete: rec.chainComplete,
            chainStart: rec.chainStart === null ? null : Number(rec.chainStart),
            chainEnd: rec.chainEnd === null ? null : Number(rec.chainEnd),
            chainBreaks: (rec.chainBreaks as Array<{ rowIndex: number; detail: string }> | null) ?? [],
          }
        : null,
      flags: submission.integrityFlags.map((f) => ({ code: f.code, severity: f.severity, detail: f.detail })),
      rows: run.rows.map((r) => ({
        sequence: r.sequence,
        timestamp: r.timestamp,
        type: r.type,
        description: r.description,
        amount: r.amount === null ? null : Number(r.amount),
        balanceBefore: r.balanceBefore === null ? null : Number(r.balanceBefore),
        balanceAfter: r.balanceAfter === null ? null : Number(r.balanceAfter),
        disagreements: r.disagreements,
      })),
      panorama,
    });
    await deps.prisma.auditEvent.create({
      data: { actor: request.staffUser?.name ?? "unknown-staff", action: "export_evidence_pdf", target: submission.id },
    });
    reply.type("application/pdf").header("content-disposition", `attachment; filename="evidence-${submission.id.slice(0, 8)}.pdf"`).send(pdf);
  });

  // One row's band cut from the stitched list — the exact pixels the row was
  // read from, for a reviewer to check a value without scrolling the panorama.
  app.get<{ Params: { id: string; runId: string; sequence: string } }>(
    "/submissions/:id/extraction-runs/:runId/rows/:sequence/crop.png",
    async (request, reply) => {
      const sequence = Number(request.params.sequence);
      const row = await deps.prisma.transactionRow.findFirst({
        where: { extractionRunId: request.params.runId, sequence, extractionRun: { submissionId: request.params.id } },
        include: { extractionRun: true },
      });
      if (!row || !row.extractionRun.panoramaBlobKey || row.panoramaTop === null || row.panoramaBottom === null) {
        reply.code(404).send({ error: "no crop for this row" });
        return;
      }
      let pano: Buffer;
      try {
        pano = await deps.objectStore.get(row.extractionRun.panoramaBlobKey);
      } catch {
        reply.code(410).send({ error: "panorama no longer in the object store" });
        return;
      }
      const meta = await sharp(pano).metadata();
      const top = Math.max(0, Math.floor(row.panoramaTop) - 4);
      const bottom = Math.min(meta.height!, Math.ceil(row.panoramaBottom) + 4);
      const crop = await sharp(pano).extract({ left: 0, top, width: meta.width!, height: Math.max(1, bottom - top) }).png().toBuffer();
      reply.type("image/png").send(crop);
    },
  );
}
