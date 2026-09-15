import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { getRetentionSettings, setRetentionSettings, runRetentionJob } from "../retention/retentionJob.js";

const settingsSchema = z.object({
  rawMediaRetentionDays: z.number().int().positive().optional(),
  fundedEmailEvidenceRetentionDays: z.number().int().positive().optional(),
});

/** PRD §9 — "Betlab admin: configure retention". */
export async function registerRetentionRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma, { role: "admin" }));

  app.get("/retention-settings", async (_request, reply) => {
    reply.send(await getRetentionSettings(deps.prisma));
  });

  app.put("/retention-settings", async (request, reply) => {
    const body = settingsSchema.parse(request.body ?? {});
    reply.send(await setRetentionSettings(deps.prisma, body));
  });

  app.post("/retention/run", async (_request, reply) => {
    reply.send(await runRetentionJob(deps.prisma, deps.objectStore));
  });
}
