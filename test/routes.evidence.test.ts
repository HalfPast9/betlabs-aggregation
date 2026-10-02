import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestContext, resetDb, authHeaders } from "./helpers/testApp.js";
import { makeScrollVideo } from "./helpers/scrollVideo.js";
import { sha256Hex } from "../src/lib/hash.js";
import type { RawExtractedRow, TileInput } from "../src/extraction/visionExtractor.js";

const list: Array<Partial<RawExtractedRow>> = [
  { timestamp: "2026-09-15 12:02", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 },
  { timestamp: "2026-09-15 12:01", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 },
  { timestamp: "2026-09-15 12:00", type: "deposit", amount: 100, balanceBefore: 0, balanceAfter: 100 },
];
const reader = (tile: TileInput): RawExtractedRow[] =>
  list
    .map((r, i) => ({ r, top: i * 90 + 10 }))
    .filter(({ top }) => top >= tile.top && top + 72 <= tile.bottom)
    .map(({ r, top }) => ({ timestamp: null, type: "bet", description: null, amount: null, balanceBefore: null, balanceAfter: null, confidence: 0.9, fullyVisible: true, yTop: top / tile.scale, ...r }) as RawExtractedRow);

describe("evidence routes", () => {
  let ctx: Awaited<ReturnType<typeof buildTestContext>>;
  let video: Buffer;

  beforeAll(async () => {
    ctx = await buildTestContext({ visionScript: reader });
    video = (await makeScrollVideo({ rowCount: 8, speed: 400 })).buffer;
  });
  afterEach(async () => resetDb(ctx.prisma));
  afterAll(async () => ctx.cleanup());

  async function extracted() {
    const participant = await ctx.prisma.participant.create({ data: {} });
    const enrollment = await ctx.prisma.enrollment.create({ data: { participantId: participant.id, casino: "Acme", state: "funded" } });
    const contentHash = sha256Hex(video);
    const media = await ctx.prisma.mediaAsset.create({ data: { blobKey: contentHash, contentHash, bytes: video.byteLength, mime: "video/mp4" } });
    const sub = await ctx.prisma.submission.create({ data: { enrollmentId: enrollment.id, kind: "wager_recording", channel: "dropbox", mediaAssetId: media.id, contentHash } });
    await ctx.objectStore.put(contentHash, video);
    const res = await ctx.app.inject({ method: "POST", url: `/submissions/${sub.id}/extract`, headers: authHeaders() });
    expect(res.statusCode).toBe(202);
    const { extractionRunId } = res.json();
    await ctx.extractionQueue.drain();
    return { sub, runId: extractionRunId as string };
  }

  it("queues extraction and exposes the run for polling", async () => {
    const { runId } = await extracted();
    const res = await ctx.app.inject({ method: "GET", url: `/extraction-runs/${runId}`, headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("succeeded");
    expect(res.json().rows).toHaveLength(3);
    expect(["ok", "warn"]).toContain(res.json().quality.verdict);
  });

  it("serves a row crop and an evidence PDF, audit-logged", async () => {
    const { sub, runId } = await extracted();
    const crop = await ctx.app.inject({ method: "GET", url: `/submissions/${sub.id}/extraction-runs/${runId}/rows/1/crop.png`, headers: authHeaders() });
    expect(crop.statusCode).toBe(200);
    expect(crop.headers["content-type"]).toContain("image/png");
    expect(crop.rawPayload.byteLength).toBeGreaterThan(100);

    const pdf = await ctx.app.inject({ method: "GET", url: `/submissions/${sub.id}/extraction-runs/${runId}/evidence.pdf`, headers: authHeaders() });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    const audit = await ctx.prisma.auditEvent.findMany({ where: { action: "export_evidence_pdf", target: sub.id } });
    expect(audit).toHaveLength(1);
  });
});
