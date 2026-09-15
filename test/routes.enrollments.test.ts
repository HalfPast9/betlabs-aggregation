import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb, authHeaders } from "./helpers/testApp.js";

describe("enrollment lifecycle routes", () => {
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

  async function makeEnrollmentAtState(state: string) {
    const participant = await ctx.prisma.participant.create({ data: { email: `p-${Date.now()}-${Math.random()}@example.com` } });
    return ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino", state } });
  }

  it("lists an email_verified enrollment in the funding queue with pre-funding checks attached", async () => {
    const enrollment = await makeEnrollmentAtState("email_verified");

    const res = await ctx.app.inject({ method: "GET", url: "/enrollments/funding-queue", headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const entry = body.find((e: { id: string }) => e.id === enrollment.id);
    expect(entry).toBeDefined();
    expect(Array.isArray(entry.preFundingChecks)).toBe(true);
  });

  it("funds an enrollment, optionally recording a grant, and rejects an illegal fund from the wrong state", async () => {
    const enrollment = await makeEnrollmentAtState("email_verified");

    const staffRes = await ctx.app.inject({
      method: "POST",
      url: "/staff-users",
      headers: authHeaders(),
      payload: { name: "ops@betlab.example", role: "ops" },
    });
    const opsToken = staffRes.json().token as string;

    const res = await ctx.app.inject({
      method: "POST",
      url: `/enrollments/${enrollment.id}/fund`,
      headers: authHeaders(opsToken),
      payload: { note: "checks look clean", grant: { amount: 250, sentAt: new Date().toISOString(), method: "e-transfer" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("funded");

    const grant = await ctx.prisma.grant.findUnique({ where: { enrollmentId: enrollment.id } });
    expect(Number(grant?.amount)).toBe(250);

    const decisions = await ctx.prisma.decision.findMany({ where: { enrollmentId: enrollment.id } });
    expect(decisions[0]?.actor).toBe("ops@betlab.example");

    // Already funded — a second fund attempt must fail.
    const again = await ctx.app.inject({
      method: "POST",
      url: `/enrollments/${enrollment.id}/fund`,
      headers: authHeaders(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it("verifies a wager and closes the enrollment", async () => {
    const enrollment = await makeEnrollmentAtState("wager_submitted");

    const verifyRes = await ctx.app.inject({
      method: "POST",
      url: `/enrollments/${enrollment.id}/verify-wager`,
      headers: authHeaders(),
      payload: {},
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().state).toBe("wager_verified");

    const closeRes = await ctx.app.inject({
      method: "POST",
      url: `/enrollments/${enrollment.id}/close`,
      headers: authHeaders(),
      payload: {},
    });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.json().state).toBe("closed");
  });

  it("rejects an enrollment from any non-terminal state, including after funding", async () => {
    const enrollment = await makeEnrollmentAtState("funded");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/enrollments/${enrollment.id}/rejected`,
      headers: authHeaders(),
      payload: { note: "evidence later found fabricated" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("rejected");
  });

  it("manages the DKIM allowlist", async () => {
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/dkim-allowlist",
      headers: authHeaders(),
      payload: { casino: "AcmeCasino", domain: "casino-esp.example" },
    });
    expect(createRes.statusCode).toBe(201);

    const listRes = await ctx.app.inject({ method: "GET", url: "/dkim-allowlist", headers: authHeaders() });
    expect(listRes.json().some((e: { domain: string }) => e.domain === "casino-esp.example")).toBe(true);
  });
});
