import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";

/** Lets the console (and any client) discover who it's authenticated as and what they can do. */
export async function registerMeRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.get("/me", { preHandler: requireStaffAuth(deps.prisma) }, async (request, reply) => {
    reply.send(request.staffUser);
  });
}
