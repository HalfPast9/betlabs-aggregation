import type { PrismaClient } from "@prisma/client";
import type { DropboxClient } from "./types.js";

export interface CreateFileRequestForEnrollmentDeps {
  prisma: PrismaClient;
  dropbox: DropboxClient;
  intakeRoot: string;
}

/**
 * Creates a Dropbox File Request scoped to one enrollment (PRD §6.1) and
 * records it. The returned URL is handed back for a runner to paste to the
 * participant by hand (PRD D8 — no automated distribution in v1).
 */
export async function createFileRequestForEnrollment(
  deps: CreateFileRequestForEnrollmentDeps,
  enrollmentId: string,
) {
  const { prisma, dropbox, intakeRoot } = deps;

  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
  if (!enrollment) {
    throw new Error(`No enrollment ${enrollmentId}`);
  }

  const destinationPath = `${intakeRoot.replace(/\/$/, "")}/${enrollmentId}`;
  const result = await dropbox.createFileRequest(
    destinationPath,
    `Betlab verification evidence — ${enrollment.casino}`,
  );

  return prisma.fileRequest.create({
    data: {
      enrollmentId,
      dropboxRequestId: result.id,
      url: result.url,
      destinationPath,
    },
  });
}
