import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { toCsv } from "../exports/csv.js";

const querySchema = z.object({
  participantId: z.string().optional(),
  enrollmentId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** PRD §6.4 "export to CSV". */
export async function registerExportRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma));

  app.get("/exports/submissions.csv", async (request, reply) => {
    const query = querySchema.parse(request.query ?? {});
    const submissions = await deps.prisma.submission.findMany({
      where: {
        enrollmentId: query.enrollmentId,
        enrollment: query.participantId ? { participantId: query.participantId } : undefined,
        receivedAt: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      include: {
        mediaAsset: true,
        emailEvidence: true,
        integrityFlags: true,
        enrollment: { include: { participant: true } },
      },
      orderBy: { receivedAt: "desc" },
    });

    const csv = toCsv(
      [
        "submission_id",
        "participant_id",
        "participant_contact",
        "enrollment_id",
        "casino",
        "enrollment_state",
        "kind",
        "channel",
        "received_at",
        "content_hash",
        "email_tier",
        "email_dkim_result",
        "flags",
      ],
      submissions.map((s) => [
        s.id,
        s.enrollment.participant.id,
        s.enrollment.participant.contact,
        s.enrollment.id,
        s.enrollment.casino,
        s.enrollment.state,
        s.kind,
        s.channel,
        s.receivedAt.toISOString(),
        s.contentHash,
        s.emailEvidence?.tier ?? null,
        s.emailEvidence?.dkimResult ?? null,
        s.integrityFlags.map((f) => f.code).join(";"),
      ]),
    );

    reply.type("text/csv").header("content-disposition", 'attachment; filename="submissions.csv"').send(csv);
  });

  app.get("/exports/decisions.csv", async (request, reply) => {
    const query = z.object({ enrollmentId: z.string().optional() }).parse(request.query ?? {});
    const decisions = await deps.prisma.decision.findMany({
      where: { enrollmentId: query.enrollmentId },
      orderBy: { at: "asc" },
    });

    const csv = toCsv(
      ["decision_id", "enrollment_id", "actor", "from_state", "to_state", "at", "note", "hash", "prev_hash"],
      decisions.map((d) => [d.id, d.enrollmentId, d.actor, d.fromState, d.toState, d.at.toISOString(), d.note, d.hash, d.prevHash]),
    );

    reply.type("text/csv").header("content-disposition", 'attachment; filename="decisions.csv"').send(csv);
  });
}
