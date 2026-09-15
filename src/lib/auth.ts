import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Minimal staff auth for M0: a single shared bearer token (PRD §9 requires
 * role-based access; full RBAC is M4 — this is a placeholder gate so raw
 * media and manual intake aren't left unauthenticated in the meantime).
 */
export function requireStaffAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token || token !== expectedToken) {
      reply.code(401).send({ error: "unauthorized" });
    }
  };
}
