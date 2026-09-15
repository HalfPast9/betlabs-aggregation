import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb } from "./helpers/testApp.js";
import { buildRawEmail } from "./helpers/dkimFixture.js";

function buildForwardWithAttachment(runnerFrom: string, innerEml: string): string {
  const boundary = "outer-boundary";
  return [
    `From: ${runnerFrom}`,
    `To: intake@betlab.example`,
    `Subject: Fwd: Welcome`,
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
    innerEml,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

describe("POST /inbound/email", () => {
  let ctx: Awaited<ReturnType<typeof buildTestContext>>;

  beforeAll(async () => {
    ctx = await buildTestContext();
  });
  afterEach(async () => {
    await resetDb(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  it("accepts raw MIME bytes as the request body and processes an unsigned attachment as Tier B", async () => {
    const participant = await ctx.prisma.participant.create({ data: { email: "runner@gmail.com" } });
    const enrollment = await ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });

    const inner = buildRawEmail({
      from: "no-reply@casino.example",
      to: "runner@gmail.com",
      subject: "Welcome",
      date: "Tue, 15 Sep 2026 12:00:00 +0000",
    });
    const outer = buildForwardWithAttachment("runner@gmail.com", inner);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/inbound/email",
      headers: { "content-type": "message/rfc822" },
      payload: outer,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("verified");
    expect(body.tier).toBe("B"); // unsigned original -> dkim no_signature -> Tier B

    const reloaded = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(reloaded.state).toBe("email_verified");
  });

  it("rejects when a configured shared-secret token doesn't match, and accepts when it does", async () => {
    const { app, cleanup } = await buildTestContext({ inboundEmailToken: "secret123" });
    try {
      const wrongToken = await app.inject({
        method: "POST",
        url: "/inbound/email?token=wrong",
        headers: { "content-type": "message/rfc822" },
        payload: "irrelevant, should be rejected before parsing",
      });
      expect(wrongToken.statusCode).toBe(401);

      const noToken = await app.inject({
        method: "POST",
        url: "/inbound/email",
        headers: { "content-type": "message/rfc822" },
        payload: "irrelevant, should be rejected before parsing",
      });
      expect(noToken.statusCode).toBe(401);

      const rightToken = await app.inject({
        method: "POST",
        url: "/inbound/email?token=secret123",
        headers: { "content-type": "message/rfc822" },
        payload: "From: nobody@example.com\r\nTo: intake@betlab.example\r\nSubject: x\r\nDate: Tue, 15 Sep 2026 12:00:00 +0000\r\n\r\nbody",
      });
      expect(rightToken.statusCode).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it("400s when the request has no email content", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/inbound/email",
      headers: { "content-type": "message/rfc822" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
  });
});
