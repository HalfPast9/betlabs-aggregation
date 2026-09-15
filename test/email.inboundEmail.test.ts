import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { handleInboundEmail } from "../src/email/inboundEmail.js";
import { FakeEmailSender } from "../src/email/sender.js";
import { createDkimFixture, buildRawEmail } from "./helpers/dkimFixture.js";
import { createTmpObjectStore } from "./helpers/tmpObjectStore.js";
import { resetDb } from "./helpers/testApp.js";

function buildForwardWithAttachment(args: { runnerFrom: string; innerEml: string }): string {
  const boundary = "outer-boundary";
  return [
    `From: ${args.runnerFrom}`,
    `To: intake@betlab.example`,
    `Subject: Fwd: Welcome to AcmeCasino`,
    `Date: Tue, 15 Sep 2026 12:05:00 +0000`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain`,
    ``,
    `See attached.`,
    ``,
    `--${boundary}`,
    `Content-Type: message/rfc822; name="original.eml"`,
    `Content-Disposition: attachment; filename="original.eml"`,
    ``,
    args.innerEml,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

describe("handleInboundEmail", () => {
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

  it("Tier A: attached original, DKIM valid, allowlisted signer, To: signed -> email_verified", async () => {
    const participant = await prisma.participant.create({ data: { email: "runner@gmail.com" } });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });
    await prisma.dkimAllowedSigner.create({ data: { casino: "AcmeCasino", domain: "casino-esp.example" } });

    const fixture = createDkimFixture("casino-esp.example", "sel1");
    const inner = buildRawEmail({
      from: "no-reply@casino-esp.example",
      to: "runner@gmail.com",
      subject: "Welcome to AcmeCasino",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
    });
    const signedInner = await fixture.sign(inner);
    const outer = buildForwardWithAttachment({ runnerFrom: "runner@gmail.com", innerEml: signedInner });

    const { store: objectStore, cleanup } = await createTmpObjectStore();
    const emailSender = new FakeEmailSender();
    try {
      const outcome = await handleInboundEmail(
        { prisma, objectStore, emailSender, dkimResolver: fixture.resolver },
        Buffer.from(outer),
      );

      expect(outcome.status).toBe("verified");
      if (outcome.status !== "verified") throw new Error("unreachable");
      expect(outcome.tier).toBe("A");
      expect(outcome.dkimResult).toBe("pass");

      const reloaded = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
      expect(reloaded.state).toBe("email_verified");

      const submissions = await prisma.submission.findMany({ where: { enrollmentId: enrollment.id } });
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.kind).toBe("signup_email");
      expect(submissions[0]?.channel).toBe("email");

      const decisions = await prisma.decision.findMany({ where: { enrollmentId: enrollment.id }, orderBy: { at: "asc" } });
      expect(decisions.map((d) => d.toState)).toEqual(["email_submitted", "email_verified"]);
    } finally {
      await cleanup();
    }
  });

  it("Tier B: valid signature but signer not on the casino's allowlist", async () => {
    const participant = await prisma.participant.create({ data: { email: "runner2@gmail.com" } });
    await prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });
    // No dkimAllowedSigner entry created — signer is unrecognized for this casino.

    const fixture = createDkimFixture("some-esp.example", "sel1");
    const inner = buildRawEmail({
      from: "no-reply@some-esp.example",
      to: "runner2@gmail.com",
      subject: "Welcome to AcmeCasino",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
    });
    const signedInner = await fixture.sign(inner);
    const outer = buildForwardWithAttachment({ runnerFrom: "runner2@gmail.com", innerEml: signedInner });

    const { store: objectStore, cleanup } = await createTmpObjectStore();
    const emailSender = new FakeEmailSender();
    try {
      const outcome = await handleInboundEmail(
        { prisma, objectStore, emailSender, dkimResolver: fixture.resolver },
        Buffer.from(outer),
      );
      expect(outcome.status).toBe("verified");
      if (outcome.status !== "verified") throw new Error("unreachable");
      expect(outcome.tier).toBe("B");
      expect(outcome.dkimResult).toBe("pass");
    } finally {
      await cleanup();
    }
  });

  it("sends an auto-reply and stays at email_submitted when there's no attached original", async () => {
    const participant = await prisma.participant.create({ data: { email: "runner3@gmail.com" } });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });

    const outer = [
      "From: runner3@gmail.com",
      "To: intake@betlab.example",
      "Subject: Fwd: Welcome to AcmeCasino",
      "Date: Tue, 15 Sep 2026 12:05:00 +0000",
      "Content-Type: text/plain",
      "",
      "Welcome to AcmeCasino! (pasted as plain text, not attached)",
    ].join("\r\n");

    const { store: objectStore, cleanup } = await createTmpObjectStore();
    const emailSender = new FakeEmailSender();
    try {
      const outcome = await handleInboundEmail({ prisma, objectStore, emailSender }, Buffer.from(outer));
      expect(outcome.status).toBe("auto_replied");

      expect(emailSender.sent).toHaveLength(1);
      expect(emailSender.sent[0]?.to).toBe("runner3@gmail.com");

      const reloaded = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
      expect(reloaded.state).toBe("email_submitted");

      const submissions = await prisma.submission.findMany({ where: { enrollmentId: enrollment.id } });
      expect(submissions).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("is unmatched when the sender has no pending enrollment", async () => {
    const outer = buildForwardWithAttachment({
      runnerFrom: "unknown@gmail.com",
      innerEml: buildRawEmail({
        from: "no-reply@casino-esp.example",
        to: "unknown@gmail.com",
        subject: "Welcome",
        date: "Tue, 15 Sep 2026 12:00:00 +0000",
      }),
    });

    const { store: objectStore, cleanup } = await createTmpObjectStore();
    const emailSender = new FakeEmailSender();
    try {
      const outcome = await handleInboundEmail({ prisma, objectStore, emailSender }, Buffer.from(outer));
      expect(outcome.status).toBe("unmatched");
      if (outcome.status !== "unmatched") throw new Error("unreachable");
      expect(outcome.reason).toBe("no_participant");

      const auditEvents = await prisma.auditEvent.findMany({ where: { target: "unknown@gmail.com" } });
      expect(auditEvents).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
