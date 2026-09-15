import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireStaffAuth, hashToken } from "../lib/auth.js";

const createStaffSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["ops", "admin"]),
});

/** PRD §5 "Betlab admin: manage staff access" / §9 role-based access. */
export async function registerStaffRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma, { role: "admin" }));

  app.get("/staff-users", async (_request, reply) => {
    const staff = await deps.prisma.staffUser.findMany({
      select: { id: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    reply.send(staff);
  });

  // Returns the plaintext token exactly once — only the hash is stored.
  app.post("/staff-users", async (request, reply) => {
    const body = createStaffSchema.parse(request.body ?? {});
    const token = randomBytes(24).toString("base64url");
    const staff = await deps.prisma.staffUser.create({
      data: { name: body.name, role: body.role, tokenHash: hashToken(token) },
    });
    reply.code(201).send({ id: staff.id, name: staff.name, role: staff.role, token });
  });

  app.delete<{ Params: { id: string } }>("/staff-users/:id", async (request, reply) => {
    await deps.prisma.staffUser.delete({ where: { id: request.params.id } });
    reply.code(204).send();
  });
}
