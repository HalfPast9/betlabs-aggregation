import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { runExtraction } from "../extraction/runExtraction.js";

export async function registerExtractionRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma));

  // Manual (re-)trigger — extraction is always re-runnable against the
  // immutable original (PRD §6.2), e.g. after the extractor is upgraded.
  app.post<{ Params: { id: string } }>("/submissions/:id/extract", async (request, reply) => {
    try {
      const result = await runExtraction(
        {
          prisma: deps.prisma,
          objectStore: deps.objectStore,
          visionExtractor: deps.visionExtractor,
          extractorVersion: deps.extractorVersion,
          frameIntervalSeconds: deps.frameIntervalSeconds,
          dedupHammingThreshold: deps.dedupHammingThreshold,
        },
        request.params.id,
      );
      reply.code(201).send(result);
    } catch (err) {
      reply.code(422).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/submissions/:id/extraction-runs", async (request, reply) => {
    const runs = await deps.prisma.extractionRun.findMany({
      where: { submissionId: request.params.id },
      include: { rows: { orderBy: { sourceFrameTs: "asc" } }, reconciliation: true },
      orderBy: { startedAt: "desc" },
    });
    reply.send(runs);
  });
}
