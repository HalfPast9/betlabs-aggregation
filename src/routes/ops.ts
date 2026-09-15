import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { checkDropboxQuota } from "../jobs/monitorDropboxQuota.js";

/** Operational health checks — currently just the Dropbox quota (PRD §12 risk). */
export async function registerOpsRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma, { role: "admin" }));

  app.get("/dropbox-quota", async (_request, reply) => {
    const usage = await checkDropboxQuota(deps.prisma, deps.dropbox, deps.dropboxQuotaWarningThreshold);
    reply.send(usage);
  });
}
