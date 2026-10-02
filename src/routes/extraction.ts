import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";

export async function registerExtractionRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma));

  // Manual (re-)trigger — extraction is always re-runnable against the
  // immutable original (PRD §6.2), e.g. after the extractor is upgraded.
  // Queued, not awaited: extraction is tens of seconds of CPU plus model
  // calls. Poll GET /extraction-runs/:runId (or the submission) for status.
  // `?force=true` reads a recording the quality assessment rejected.
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>("/submissions/:id/extract", async (request, reply) => {
    try {
      const submission = await deps.prisma.submission.findUnique({ where: { id: request.params.id } });
      if (!submission) {
        reply.code(404).send({ error: "submission not found" });
        return;
      }
      const { runId } = await deps.extractionQueue.enqueue(submission.id, { force: request.query.force === "true" });
      reply.code(202).send({ extractionRunId: runId, status: "pending" });
    } catch (err) {
      reply.code(422).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { runId: string } }>("/extraction-runs/:runId", async (request, reply) => {
    const run = await deps.prisma.extractionRun.findUnique({
      where: { id: request.params.runId },
      include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true, integrityFlags: true },
    });
    if (!run) {
      reply.code(404).send({ error: "extraction run not found" });
      return;
    }
    reply.send(run);
  });

  app.get<{ Params: { id: string } }>("/submissions/:id/extraction-runs", async (request, reply) => {
    const runs = await deps.prisma.extractionRun.findMany({
      where: { submissionId: request.params.id },
      include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true },
      orderBy: { startedAt: "desc" },
    });
    reply.send(runs);
  });
}
