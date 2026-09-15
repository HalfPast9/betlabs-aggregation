import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb, authHeaders } from "./helpers/testApp.js";

describe("staff RBAC", () => {
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

  it("lets an admin create a staff user and issues a usable token exactly once", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/staff-users",
      headers: authHeaders(),
      payload: { name: "reviewer@betlab.example", role: "ops" },
    });
    expect(res.statusCode).toBe(201);
    const { token } = res.json();
    expect(typeof token).toBe("string");

    const searchRes = await ctx.app.inject({ method: "GET", url: "/submissions", headers: authHeaders(token) });
    expect(searchRes.statusCode).toBe(200);
  });

  it("rejects an unknown token", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/submissions", headers: authHeaders("not-a-real-token") });
    expect(res.statusCode).toBe(401);
  });

  it("forbids an ops-role token from admin-only routes", async () => {
    const staffRes = await ctx.app.inject({
      method: "POST",
      url: "/staff-users",
      headers: authHeaders(),
      payload: { name: "reviewer2@betlab.example", role: "ops" },
    });
    const opsToken = staffRes.json().token as string;

    const forbidden = await ctx.app.inject({
      method: "POST",
      url: "/staff-users",
      headers: authHeaders(opsToken),
      payload: { name: "should-not-work@betlab.example", role: "ops" },
    });
    expect(forbidden.statusCode).toBe(403);

    const retentionForbidden = await ctx.app.inject({
      method: "GET",
      url: "/retention-settings",
      headers: authHeaders(opsToken),
    });
    expect(retentionForbidden.statusCode).toBe(403);

    const dkimForbidden = await ctx.app.inject({
      method: "POST",
      url: "/dkim-allowlist",
      headers: authHeaders(opsToken),
      payload: { casino: "AcmeCasino", domain: "x.example" },
    });
    expect(dkimForbidden.statusCode).toBe(403);
  });

  it("removing a staff user revokes their token", async () => {
    const staffRes = await ctx.app.inject({
      method: "POST",
      url: "/staff-users",
      headers: authHeaders(),
      payload: { name: "temp@betlab.example", role: "ops" },
    });
    const { id, token } = staffRes.json();

    const del = await ctx.app.inject({ method: "DELETE", url: `/staff-users/${id}`, headers: authHeaders() });
    expect(del.statusCode).toBe(204);

    const res = await ctx.app.inject({ method: "GET", url: "/submissions", headers: authHeaders(token) });
    expect(res.statusCode).toBe(401);
  });
});

describe("retention", () => {
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

  it("lets an admin read and update retention settings", async () => {
    const getRes = await ctx.app.inject({ method: "GET", url: "/retention-settings", headers: authHeaders() });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().rawMediaRetentionDays).toBe(90);

    const putRes = await ctx.app.inject({
      method: "PUT",
      url: "/retention-settings",
      headers: authHeaders(),
      payload: { rawMediaRetentionDays: 30 },
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().rawMediaRetentionDays).toBe(30);
  });

  it("purges raw bytes for media past the retention window but keeps the row and submission", async () => {
    await ctx.app.inject({
      method: "PUT",
      url: "/retention-settings",
      headers: authHeaders(),
      payload: { rawMediaRetentionDays: 1 },
    });

    const participant = await ctx.prisma.participant.create({ data: {} });
    const enrollment = await ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });
    const mediaAsset = await ctx.prisma.mediaAsset.create({
      data: {
        blobKey: "retention-hash",
        contentHash: "retention-hash",
        bytes: 5,
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    });
    const submission = await ctx.prisma.submission.create({
      data: { enrollmentId: enrollment.id, kind: "wager_recording", channel: "dropbox", mediaAssetId: mediaAsset.id, contentHash: "retention-hash" },
    });
    await ctx.objectStore.put("retention-hash", Buffer.from("old evidence bytes"));

    const runRes = await ctx.app.inject({ method: "POST", url: "/retention/run", headers: authHeaders() });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.json().deleted).toBeGreaterThanOrEqual(1);

    const reloaded = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaAsset.id } });
    expect(reloaded.deletedAt).not.toBeNull();
    expect(await ctx.objectStore.exists("retention-hash")).toBe(false);

    // The submission itself, and its link to the (now-purged) media asset, survive.
    const stillThere = await ctx.prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stillThere.mediaAssetId).toBe(mediaAsset.id);

    const mediaRes = await ctx.app.inject({
      method: "GET",
      url: `/submissions/${submission.id}/media`,
      headers: authHeaders(),
    });
    expect(mediaRes.statusCode).toBe(410);
  });

  it("keeps signup email evidence for a funded enrollment past the general raw-media window", async () => {
    await ctx.app.inject({
      method: "PUT",
      url: "/retention-settings",
      headers: authHeaders(),
      payload: { rawMediaRetentionDays: 1, fundedEmailEvidenceRetentionDays: 365 },
    });

    const participant = await ctx.prisma.participant.create({ data: {} });
    const enrollment = await ctx.prisma.enrollment.create({
      data: { participantId: participant.id, casino: "AcmeCasino", state: "funded" },
    });
    const mediaAsset = await ctx.prisma.mediaAsset.create({
      data: {
        blobKey: "funded-email-hash",
        contentHash: "funded-email-hash",
        bytes: 5,
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    });
    await ctx.prisma.submission.create({
      data: { enrollmentId: enrollment.id, kind: "signup_email", channel: "email", mediaAssetId: mediaAsset.id, contentHash: "funded-email-hash" },
    });
    await ctx.objectStore.put("funded-email-hash", Buffer.from("signup confirmation bytes"));

    await ctx.app.inject({ method: "POST", url: "/retention/run", headers: authHeaders() });

    const reloaded = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaAsset.id } });
    expect(reloaded.deletedAt).toBeNull();
    expect(await ctx.objectStore.exists("funded-email-hash")).toBe(true);
  });
});
