import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { requireStaffAuth } from "../lib/auth.js";
import { createFileRequestForEnrollment } from "../dropbox/fileRequests.js";

const createParticipantSchema = z.object({
  contact: z.string().optional(),
  email: z.string().email().optional(),
});

const createEnrollmentSchema = z.object({
  casino: z.string().min(1),
});

export async function registerParticipantRoutes(app: FastifyInstance, opts: { deps: AppDeps }) {
  const { deps } = opts;
  app.addHook("preHandler", requireStaffAuth(deps.prisma));

  app.post("/participants", async (request, reply) => {
    const body = createParticipantSchema.parse(request.body ?? {});
    const participant = await deps.prisma.participant.create({ data: body });
    reply.code(201).send(participant);
  });

  app.get("/participants", async (request, reply) => {
    const query = z.object({ email: z.string().optional(), contact: z.string().optional() }).parse(request.query ?? {});
    const participants = await deps.prisma.participant.findMany({
      where: { email: query.email, contact: query.contact },
      orderBy: { createdAt: "desc" },
    });
    reply.send(participants);
  });

  // PRD §6.4 — "a participant detail view aggregating their submission history".
  app.get<{ Params: { id: string } }>("/participants/:id", async (request, reply) => {
    const participant = await deps.prisma.participant.findUnique({
      where: { id: request.params.id },
      include: {
        enrollments: {
          include: {
            grant: true,
            submissions: { include: { mediaAsset: true, integrityFlags: true }, orderBy: { receivedAt: "desc" } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!participant) {
      reply.code(404).send({ error: "participant not found" });
      return;
    }
    reply.send(participant);
  });

  app.post<{ Params: { id: string } }>("/participants/:id/enrollments", async (request, reply) => {
    const body = createEnrollmentSchema.parse(request.body ?? {});
    const participant = await deps.prisma.participant.findUnique({
      where: { id: request.params.id },
    });
    if (!participant) {
      reply.code(404).send({ error: "participant not found" });
      return;
    }
    const enrollment = await deps.prisma.enrollment.create({
      data: { participantId: participant.id, casino: body.casino },
    });
    reply.code(201).send(enrollment);
  });

  app.post<{ Params: { id: string } }>("/enrollments/:id/file-requests", async (request, reply) => {
    try {
      const fileRequest = await createFileRequestForEnrollment(
        { prisma: deps.prisma, dropbox: deps.dropbox, intakeRoot: deps.intakeRoot },
        request.params.id,
      );
      reply.code(201).send(fileRequest);
    } catch (err) {
      reply.code(404).send({ error: (err as Error).message });
    }
  });
}
