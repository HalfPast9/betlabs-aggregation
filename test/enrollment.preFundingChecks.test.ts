import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runPreFundingChecks } from "../src/enrollment/preFundingChecks.js";
import { resetDb } from "./helpers/testApp.js";

describe("runPreFundingChecks", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await resetDb(prisma);
  });
  afterEach(async () => {
    await resetDb(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("flags a registered email already used by another participant", async () => {
    await prisma.participant.create({ data: { email: "shared@example.com" } });
    const participant = await prisma.participant.create({ data: { email: "shared@example.com" } });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });

    const checks = await runPreFundingChecks(prisma, enrollment.id);
    const dup = checks.find((c) => c.code === "DUPLICATE_ENROLLMENT_EMAIL");
    expect(dup?.passed).toBe(false);
  });

  it("flags a participant already funded for the same casino", async () => {
    const participant = await prisma.participant.create({ data: {} });
    await prisma.enrollment.create({
      data: { participantId: participant.id, casino: "AcmeCasino", state: "funded" },
    });
    const newEnrollment = await prisma.enrollment.create({
      data: { participantId: participant.id, casino: "AcmeCasino" },
    });

    const checks = await runPreFundingChecks(prisma, newEnrollment.id);
    const alreadyFunded = checks.find((c) => c.code === "ALREADY_FUNDED");
    expect(alreadyFunded?.passed).toBe(false);
  });

  it("does not flag a different casino as already funded", async () => {
    const participant = await prisma.participant.create({ data: {} });
    await prisma.enrollment.create({
      data: { participantId: participant.id, casino: "OtherCasino", state: "funded" },
    });
    const newEnrollment = await prisma.enrollment.create({
      data: { participantId: participant.id, casino: "AcmeCasino" },
    });

    const checks = await runPreFundingChecks(prisma, newEnrollment.id);
    const alreadyFunded = checks.find((c) => c.code === "ALREADY_FUNDED");
    expect(alreadyFunded?.passed).toBe(true);
  });

  it("flags a signed To: that doesn't match the registered address", async () => {
    const participant = await prisma.participant.create({ data: { email: "registered@example.com" } });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });
    const mediaAsset = await prisma.mediaAsset.create({ data: { blobKey: "h1", contentHash: "h1", bytes: 1 } });
    const submission = await prisma.submission.create({
      data: { enrollmentId: enrollment.id, kind: "signup_email", channel: "email", mediaAssetId: mediaAsset.id, contentHash: "h1" },
    });
    await prisma.emailEvidence.create({
      data: {
        submissionId: submission.id,
        tier: "A",
        dkimResult: "pass",
        verifiedAt: new Date(),
        hTagCoversTo: true,
        lTagPresent: false,
        toAddr: "someone-else@example.com",
      },
    });

    const checks = await runPreFundingChecks(prisma, enrollment.id);
    const recipientMismatch = checks.find((c) => c.code === "RECIPIENT_MISMATCH");
    expect(recipientMismatch?.passed).toBe(false);
  });

  it("passes everything for a clean, well-timed enrollment", async () => {
    const participant = await prisma.participant.create({ data: { email: "clean@example.com" } });
    const enrollment = await prisma.enrollment.create({
      data: {
        participantId: participant.id,
        casino: "AcmeCasino",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const mediaAsset = await prisma.mediaAsset.create({ data: { blobKey: "h2", contentHash: "h2", bytes: 1 } });
    await prisma.submission.create({
      data: {
        enrollmentId: enrollment.id,
        kind: "signup_email",
        channel: "email",
        mediaAssetId: mediaAsset.id,
        contentHash: "h2",
        receivedAt: new Date(),
      },
    });

    const checks = await runPreFundingChecks(prisma, enrollment.id);
    expect(checks.every((c) => c.passed)).toBe(true);
  });
});
