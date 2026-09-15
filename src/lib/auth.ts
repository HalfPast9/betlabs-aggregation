import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";

export type StaffRole = "ops" | "admin";

export interface StaffIdentity {
  id: string;
  name: string;
  role: StaffRole;
}

declare module "fastify" {
  interface FastifyRequest {
    staffUser?: StaffIdentity;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * PRD §5/§9 — role-based staff access, backed by `StaffUser`. Attaches
 * `request.staffUser` for handlers and audit logging to use as the actual
 * authenticated actor (replacing the earlier single-shared-token / spoofable
 * X-Staff-Actor header placeholder). Pass `{ role: "admin" }` to gate an
 * admin-only route.
 */
export function requireStaffAuth(prisma: PrismaClient, opts?: { role?: StaffRole }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const staff = await prisma.staffUser.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!staff) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (opts?.role === "admin" && staff.role !== "admin") {
      reply.code(403).send({ error: "forbidden: admin role required" });
      return;
    }

    request.staffUser = { id: staff.id, name: staff.name, role: staff.role as StaffRole };
  };
}

/**
 * Seeds the first admin account from STAFF_API_TOKEN so the system is usable
 * before any staff have been created through the API. A no-op once at least
 * one StaffUser exists.
 */
export async function ensureBootstrapAdmin(prisma: PrismaClient, bootstrapToken: string): Promise<void> {
  const existing = await prisma.staffUser.findFirst();
  if (existing) return;
  await prisma.staffUser.create({
    data: { name: "bootstrap-admin", tokenHash: hashToken(bootstrapToken), role: "admin" },
  });
}
