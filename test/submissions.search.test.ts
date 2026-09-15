import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb, authHeaders, INTAKE_ROOT } from "./helpers/testApp.js";

describe("submission archive routes", () => {
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

  it("rejects unauthenticated requests", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/submissions" });
    expect(res.statusCode).toBe(401);
  });

  it("full flow: participant -> enrollment -> file request -> Dropbox notification -> search -> media fetch", async () => {
    const participantRes = await ctx.app.inject({
      method: "POST",
      url: "/participants",
      headers: authHeaders(),
      payload: { contact: "whatsapp:+15550001111", email: "runner-submits@example.com" },
    });
    expect(participantRes.statusCode).toBe(201);
    const participant = participantRes.json();

    const enrollmentRes = await ctx.app.inject({
      method: "POST",
      url: `/participants/${participant.id}/enrollments`,
      headers: authHeaders(),
      payload: { casino: "AcmeCasino" },
    });
    expect(enrollmentRes.statusCode).toBe(201);
    const enrollment = enrollmentRes.json();

    const fileRequestRes = await ctx.app.inject({
      method: "POST",
      url: `/enrollments/${enrollment.id}/file-requests`,
      headers: authHeaders(),
    });
    expect(fileRequestRes.statusCode).toBe(201);
    const fileRequest = fileRequestRes.json();
    expect(fileRequest.destinationPath).toBe(`${INTAKE_ROOT}/${enrollment.id}`);
    expect(fileRequest.url).toContain("dropbox.com");

    // Simulate a participant upload landing in the intake folder, then Dropbox
    // notifying our webhook that something changed.
    ctx.dropbox.seedFile(
      `${fileRequest.destinationPath}/transaction-history.mp4`,
      Buffer.from("scrolling transaction list bytes"),
    );

    const webhookRes = await ctx.app.inject({
      method: "POST",
      url: "/webhooks/dropbox",
      payload: {},
    });
    expect(webhookRes.statusCode).toBe(200);

    const searchRes = await ctx.app.inject({
      method: "GET",
      url: `/submissions?participantId=${participant.id}`,
      headers: authHeaders(),
    });
    expect(searchRes.statusCode).toBe(200);
    const submissions = searchRes.json();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].channel).toBe("dropbox");
    expect(submissions[0].enrollment.participant.id).toBe(participant.id);

    const staffRes = await ctx.app.inject({
      method: "POST",
      url: "/staff-users",
      headers: authHeaders(),
      payload: { name: "ops@betlab.example", role: "ops" },
    });
    expect(staffRes.statusCode).toBe(201);
    const opsToken = staffRes.json().token as string;

    const mediaRes = await ctx.app.inject({
      method: "GET",
      url: `/submissions/${submissions[0].id}/media`,
      headers: authHeaders(opsToken),
    });
    expect(mediaRes.statusCode).toBe(200);
    expect(mediaRes.body).toBe("scrolling transaction list bytes");

    const auditEvents = await ctx.prisma.auditEvent.findMany({
      where: { target: submissions[0].id },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.actor).toBe("ops@betlab.example");
    expect(auditEvents[0]?.action).toBe("view_raw_media");
  });

  it("accepts a manual upload and rejects a duplicate by content hash", async () => {
    const participantRes = await ctx.app.inject({
      method: "POST",
      url: "/participants",
      headers: authHeaders(),
      payload: {},
    });
    const enrollmentRes = await ctx.app.inject({
      method: "POST",
      url: `/participants/${participantRes.json().id}/enrollments`,
      headers: authHeaders(),
      payload: { casino: "AcmeCasino" },
    });
    const enrollmentId = enrollmentRes.json().id;

    function buildMultipart(fieldValue: string) {
      const boundary = "----betlabtestboundary";
      const parts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="enrollmentId"\r\n\r\n${enrollmentId}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${fieldValue}\r\n`,
        `--${boundary}--\r\n`,
      ];
      return { body: Buffer.from(parts.join("")), boundary };
    }

    const { body, boundary } = buildMultipart("manual upload bytes");

    const uploadRes = await ctx.app.inject({
      method: "POST",
      url: "/submissions/manual",
      headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(201);
    expect(uploadRes.json().channel).toBe("manual_upload");

    const dupeRes = await ctx.app.inject({
      method: "POST",
      url: "/submissions/manual",
      headers: { ...authHeaders(), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(dupeRes.statusCode).toBe(409);
  });
});
