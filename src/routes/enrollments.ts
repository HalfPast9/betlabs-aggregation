import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { buildLedger } from "../extraction/ledger.js";
import { requireStaffAuth } from "../lib/auth.js";
import { recordTransition } from "../enrollment/decisions.js";
import { runPreFundingChecks } from "../enrollment/preFundingChecks.js";

function actorFrom(request: FastifyRequest): string {
  return request.staffUser?.name ?? "unknown-staff";
}

const noteSchema = z.object({ note: z.string().optional() });
const grantSchema = z.object({
  amount: z.number().positive(),
  sentAt: z.string().datetime(),
  method: z.string().optional(),
});
const fundSchema = noteSchema.extend({ grant: grantSchema.optional() });
const dkimAllowlistSchema = z.object({ casino: z.string().min(1), domain: z.string().min(1) });

export async function registerEnrollmentRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma));

  app.get<{ Params: { id: string } }>("/enrollments/:id", async (request, reply) => {
    const enrollment = await deps.prisma.enrollment.findUnique({
      where: { id: request.params.id },
      include: {
        participant: true,
        grant: true,
        submissions: { include: { mediaAsset: true, emailEvidence: true }, orderBy: { receivedAt: "asc" } },
        decisions: { orderBy: { at: "asc" } },
      },
    });
    if (!enrollment) {
      reply.code(404).send({ error: "enrollment not found" });
      return;
    }
    reply.send(enrollment);
  });

  // PRD §6.5 — the funding queue: enrollments where the one consequential
  // human decision (email_verified -> funded) is pending, with the
  // pre-funding checks that "carry more weight than anything post-funding".
  app.get("/enrollments/funding-queue", async (_request, reply) => {
    const enrollments = await deps.prisma.enrollment.findMany({
      where: { state: "email_verified" },
      include: { participant: true, submissions: { include: { emailEvidence: true } } },
      orderBy: { createdAt: "asc" },
    });
    const withChecks = await Promise.all(
      enrollments.map(async (e) => ({
        ...e,
        preFundingChecks: await runPreFundingChecks(deps.prisma, e.id),
      })),
    );
    reply.send(withChecks);
  });

  app.post<{ Params: { id: string } }>("/enrollments/:id/fund", async (request, reply) => {
    const body = fundSchema.parse(request.body ?? {});
    const actor = actorFrom(request);
    try {
      const enrollment = await deps.prisma.$transaction(async (tx) => {
        const result = await recordTransition(tx, {
          enrollmentId: request.params.id,
          toState: "funded",
          actor,
          note: body.note,
        });
        if (body.grant) {
          await tx.grant.upsert({
            where: { enrollmentId: request.params.id },
            create: {
              enrollmentId: request.params.id,
              amount: body.grant.amount,
              sentAt: new Date(body.grant.sentAt),
              method: body.grant.method,
            },
            update: {
              amount: body.grant.amount,
              sentAt: new Date(body.grant.sentAt),
              method: body.grant.method,
            },
          });
        }
        return result;
      });
      reply.send(enrollment);
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/enrollments/:id/grant", async (request, reply) => {
    const body = grantSchema.parse(request.body ?? {});
    const enrollment = await deps.prisma.enrollment.findUnique({ where: { id: request.params.id } });
    if (!enrollment) {
      reply.code(404).send({ error: "enrollment not found" });
      return;
    }
    const grant = await deps.prisma.grant.upsert({
      where: { enrollmentId: request.params.id },
      create: {
        enrollmentId: request.params.id,
        amount: body.amount,
        sentAt: new Date(body.sentAt),
        method: body.method,
      },
      update: { amount: body.amount, sentAt: new Date(body.sentAt), method: body.method },
    });
    reply.code(201).send(grant);
  });

  // PRD §6.5 — the wager-verification queue.
  app.get("/enrollments/wager-queue", async (_request, reply) => {
    const enrollments = await deps.prisma.enrollment.findMany({
      where: { state: "wager_submitted" },
      include: {
        participant: true,
        grant: true,
        submissions: {
          where: { kind: "wager_recording" },
          include: { mediaAsset: true, extractionRuns: { include: { reconciliation: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    reply.send(enrollments);
  });

  app.post<{ Params: { id: string } }>("/enrollments/:id/verify-wager", async (request, reply) => {
    const body = noteSchema.parse(request.body ?? {});
    try {
      const enrollment = await deps.prisma.$transaction((tx) =>
        recordTransition(tx, {
          enrollmentId: request.params.id,
          toState: "wager_verified",
          actor: actorFrom(request),
          note: body.note,
        }),
      );
      reply.send(enrollment);
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/enrollments/:id/close", async (request, reply) => {
    const body = noteSchema.parse(request.body ?? {});
    try {
      const enrollment = await deps.prisma.$transaction((tx) =>
        recordTransition(tx, {
          enrollmentId: request.params.id,
          toState: "closed",
          actor: actorFrom(request),
          note: body.note,
        }),
      );
      reply.send(enrollment);
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
    }
  });

  for (const toState of ["rejected", "abandoned"] as const) {
    app.post<{ Params: { id: string } }>(`/enrollments/:id/${toState}`, async (request, reply) => {
      const body = noteSchema.parse(request.body ?? {});
      try {
        const enrollment = await deps.prisma.$transaction((tx) =>
          recordTransition(tx, {
            enrollmentId: request.params.id,
            toState,
            actor: actorFrom(request),
            note: body.note,
          }),
        );
        reply.send(enrollment);
      } catch (err) {
        reply.code(409).send({ error: (err as Error).message });
      }
    });
  }

  // Every clip the participant sent, as one chain-verified ledger.
  app.get<{ Params: { id: string } }>("/enrollments/:id/ledger", async (request, reply) => {
    const enrollment = await deps.prisma.enrollment.findUnique({ where: { id: request.params.id } });
    if (!enrollment) {
      reply.code(404).send({ error: "enrollment not found" });
      return;
    }
    reply.send(await buildLedger(deps.prisma, enrollment.id));
  });

  app.get<{ Params: { id: string } }>("/enrollments/:id/decisions", async (request, reply) => {
    const decisions = await deps.prisma.decision.findMany({
      where: { enrollmentId: request.params.id },
      orderBy: { at: "asc" },
    });
    reply.send(decisions);
  });

  app.get("/dkim-allowlist", async (_request, reply) => {
    reply.send(await deps.prisma.dkimAllowedSigner.findMany({ orderBy: { casino: "asc" } }));
  });

  app.post("/dkim-allowlist", async (request, reply) => {
    if (request.staffUser?.role !== "admin") {
      reply.code(403).send({ error: "forbidden: admin role required" });
      return;
    }
    const body = dkimAllowlistSchema.parse(request.body ?? {});
    const entry = await deps.prisma.dkimAllowedSigner.upsert({
      where: { casino_domain: { casino: body.casino, domain: body.domain } },
      create: body,
      update: {},
    });
    reply.code(201).send(entry);
  });
}
