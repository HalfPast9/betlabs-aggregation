import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb, authHeaders } from "./helpers/testApp.js";
import { createDkimFixture, buildRawEmail } from "./helpers/dkimFixture.js";

function buildMultipart(fields: Record<string, string>, fileFieldName: string, fileContent: Buffer, filename: string) {
  const boundary = "----betlab-manual-email-test";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"\r\nContent-Type: message/rfc822\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([Buffer.from(parts.join("")), head, fileContent, tail]);
  return { body, boundary };
}

// One fixture/domain shared by the whole file — buildTestContext wires its
// fake DNS resolver in once at context-build time, so every test here signs
// with the same domain (Tier B is exercised by simply not allowlisting it,
// not by needing a second domain).
const fixture = createDkimFixture("casino-esp.example", "sel1");

describe("manual upload of signup-email evidence (runner-relayed)", () => {
  let ctx: Awaited<ReturnType<typeof buildTestContext>>;

  beforeAll(async () => {
    ctx = await buildTestContext({ dkimResolver: fixture.resolver });
  });
  afterEach(async () => {
    await resetDb(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  async function makeEnrollment(email: string, state = "invited") {
    const participant = await ctx.prisma.participant.create({ data: { email } });
    return ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino", state } });
  }

  async function signedEml(toAddr: string) {
    const raw = buildRawEmail({
      from: "no-reply@casino-esp.example",
      to: toAddr,
      subject: "Welcome to AcmeCasino",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
    });
    return Buffer.from(await fixture.sign(raw));
  }

  it("runs real DKIM verification on a runner-uploaded .eml and reaches Tier A when the signer is allowlisted", async () => {
    const enrollment = await makeEnrollment("runner-relayed@example.com");
    await ctx.prisma.dkimAllowedSigner.create({ data: { casino: "AcmeCasino", domain: "casino-esp.example" } });

    const signed = await signedEml("runner-relayed@example.com");
    const { body, boundary } = buildMultipart(
      { enrollmentId: enrollment.id, kind: "signup_email" },
      "file",
      signed,
      "original.eml",
    );

    const res = await ctx.app.inject({
      method: "POST",
      url: "/submissions/manual",
      headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().kind).toBe("signup_email");
    expect(res.json().channel).toBe("manual_upload");

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/submissions/${res.json().id}`,
      headers: authHeaders(),
    });
    const submission = detail.json();
    expect(submission.emailEvidence).toBeTruthy();
    expect(submission.emailEvidence.dkimResult).toBe("pass");
    expect(submission.emailEvidence.tier).toBe("A");
    // Still flagged as out-of-band provenance, same as any manual upload.
    expect(submission.integrityFlags.some((f: { code: string }) => f.code === "MANUAL_INTAKE")).toBe(true);

    const reloaded = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(reloaded.state).toBe("email_verified");
  });

  it("still archives and tiers a runner-relayed .eml even without an allowlisted signer (Tier B, not rejected)", async () => {
    const enrollment = await makeEnrollment("runner-relayed-2@example.com");
    // No dkimAllowedSigner entry — the signature is real, the signer just isn't recognized for this casino.

    const signed = await signedEml("runner-relayed-2@example.com");
    const { body, boundary } = buildMultipart(
      { enrollmentId: enrollment.id, kind: "signup_email" },
      "file",
      signed,
      "original.eml",
    );

    const res = await ctx.app.inject({
      method: "POST",
      url: "/submissions/manual",
      headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);

    const detail = await ctx.app.inject({
      method: "GET",
      url: `/submissions/${res.json().id}`,
      headers: authHeaders(),
    });
    expect(detail.json().emailEvidence.dkimResult).toBe("pass");
    expect(detail.json().emailEvidence.tier).toBe("B");
  });

  it("does not force an enrollment transition when the enrollment is already past email_submitted", async () => {
    const enrollment = await makeEnrollment("already-funded@example.com", "funded");
    await ctx.prisma.dkimAllowedSigner.create({ data: { casino: "AcmeCasino", domain: "casino-esp.example" } });

    const signed = await signedEml("already-funded@example.com");
    const { body, boundary } = buildMultipart(
      { enrollmentId: enrollment.id, kind: "signup_email" },
      "file",
      signed,
      "original.eml",
    );

    const res = await ctx.app.inject({
      method: "POST",
      url: "/submissions/manual",
      headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(201);

    // Evidence archived and tiered, but the enrollment stays exactly where it was.
    const detail = await ctx.app.inject({
      method: "GET",
      url: `/submissions/${res.json().id}`,
      headers: authHeaders(),
    });
    expect(detail.json().emailEvidence.tier).toBe("A");

    const reloaded = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(reloaded.state).toBe("funded");
  });
});
