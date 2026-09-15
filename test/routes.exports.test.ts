import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb, authHeaders } from "./helpers/testApp.js";
import { recordTransition } from "../src/enrollment/decisions.js";

describe("export routes", () => {
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

  it("exports submissions as CSV with headers and one row per submission", async () => {
    const participant = await ctx.prisma.participant.create({ data: { contact: "whatsapp:+1555", email: "csv@example.com" } });
    const enrollment = await ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });
    const mediaAsset = await ctx.prisma.mediaAsset.create({ data: { blobKey: "csvhash", contentHash: "csvhash", bytes: 5 } });
    await ctx.prisma.submission.create({
      data: {
        enrollmentId: enrollment.id,
        kind: "wager_recording",
        channel: "dropbox",
        mediaAssetId: mediaAsset.id,
        contentHash: "csvhash",
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/exports/submissions.csv?participantId=${participant.id}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toContain("submission_id");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("csvhash");
    expect(lines[1]).toContain("AcmeCasino");
  });

  it("exports the decision chain as CSV", async () => {
    const participant = await ctx.prisma.participant.create({ data: {} });
    const enrollment = await ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "AcmeCasino" } });
    await ctx.prisma.$transaction((tx) =>
      recordTransition(tx, { enrollmentId: enrollment.id, toState: "email_submitted", actor: "system" }),
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: `/exports/decisions.csv?enrollmentId=${enrollment.id}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("email_submitted");
  });
});
