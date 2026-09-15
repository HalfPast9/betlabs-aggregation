import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { recordTransition } from "../src/enrollment/decisions.js";
import { resetDb } from "./helpers/testApp.js";

describe("recordTransition", () => {
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

  async function makeEnrollment() {
    const participant = await prisma.participant.create({ data: {} });
    return prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });
  }

  it("advances state and writes a decision row", async () => {
    const enrollment = await makeEnrollment();

    const updated = await prisma.$transaction((tx) =>
      recordTransition(tx, { enrollmentId: enrollment.id, toState: "email_submitted", actor: "system" }),
    );
    expect(updated.state).toBe("email_submitted");

    const decisions = await prisma.decision.findMany({ where: { enrollmentId: enrollment.id } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.fromState).toBe("invited");
    expect(decisions[0]?.toState).toBe("email_submitted");
    expect(decisions[0]?.prevHash).toBeNull();
    expect(decisions[0]?.hash).toBeTruthy();
  });

  it("rejects an illegal transition", async () => {
    const enrollment = await makeEnrollment();
    await expect(
      prisma.$transaction((tx) => recordTransition(tx, { enrollmentId: enrollment.id, toState: "funded", actor: "system" })),
    ).rejects.toThrow(/Illegal transition/);
  });

  it("chains decision hashes across multiple transitions", async () => {
    const enrollment = await makeEnrollment();
    await prisma.$transaction((tx) => recordTransition(tx, { enrollmentId: enrollment.id, toState: "email_submitted", actor: "system" }));
    await prisma.$transaction((tx) => recordTransition(tx, { enrollmentId: enrollment.id, toState: "email_verified", actor: "system" }));

    const decisions = await prisma.decision.findMany({
      where: { enrollmentId: enrollment.id },
      orderBy: { at: "asc" },
    });
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.prevHash).toBeNull();
    expect(decisions[1]?.prevHash).toBe(decisions[0]?.hash);
    expect(decisions[1]?.hash).not.toBe(decisions[0]?.hash);
  });

  it("allows rejected from a non-terminal state but not from an already-terminal one", async () => {
    const enrollment = await makeEnrollment();
    await prisma.$transaction((tx) => recordTransition(tx, { enrollmentId: enrollment.id, toState: "rejected", actor: "staff@betlab", note: "fraud suspected" }));

    const reloaded = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(reloaded.state).toBe("rejected");

    await expect(
      prisma.$transaction((tx) => recordTransition(tx, { enrollmentId: enrollment.id, toState: "abandoned", actor: "staff@betlab" })),
    ).rejects.toThrow(/already terminal/);
  });

  it("captures artifact content hashes in the evidence snapshot", async () => {
    const enrollment = await makeEnrollment();
    const mediaAsset = await prisma.mediaAsset.create({
      data: { blobKey: "abc123", contentHash: "abc123", bytes: 10 },
    });
    await prisma.submission.create({
      data: {
        enrollmentId: enrollment.id,
        kind: "signup_email",
        channel: "email",
        mediaAssetId: mediaAsset.id,
        contentHash: "abc123",
      },
    });

    await prisma.$transaction((tx) => recordTransition(tx, { enrollmentId: enrollment.id, toState: "email_submitted", actor: "system" }));

    const decision = await prisma.decision.findFirstOrThrow({ where: { enrollmentId: enrollment.id } });
    const snapshot = decision.evidenceSnapshot as { artifacts: Array<{ contentHash: string }> };
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0]?.contentHash).toBe("abc123");
  });
});
