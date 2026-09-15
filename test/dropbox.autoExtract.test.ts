import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildTestContext, resetDb, INTAKE_ROOT } from "./helpers/testApp.js";

const execFileAsync = promisify(execFile);

async function makeTestVideo(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "betlab-autoextract-"));
  try {
    const outPath = join(dir, "out.mp4");
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=2", outPath]);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Dropbox ingest auto-triggers extraction end to end", () => {
  let ctx: Awaited<ReturnType<typeof buildTestContext>>;

  beforeAll(async () => {
    ctx = await buildTestContext({
      autoExtractOnIngest: true,
      visionScript: (frame) => [
        { timestamp: `2026-09-15T12:0${frame.index}:00Z`, type: "bet", amount: 10, balanceAfter: null, confidence: 0.9 },
      ],
    });
  });
  afterEach(async () => {
    await resetDb(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  it("funds -> Dropbox wager recording arrives -> state advances -> extraction runs automatically", async () => {
    const participant = await ctx.prisma.participant.create({ data: {} });
    const enrollment = await ctx.prisma.enrollment.create({
      data: { participantId: participant.id, casino: "AcmeCasino", state: "funded" },
    });
    await ctx.prisma.grant.create({ data: { enrollmentId: enrollment.id, amount: 50, sentAt: new Date() } });

    const video = await makeTestVideo();
    ctx.dropbox.seedFile(`${INTAKE_ROOT}/${enrollment.id}/recording.mp4`, video);

    const res = await ctx.app.inject({ method: "POST", url: "/webhooks/dropbox", payload: {} });
    expect(res.statusCode).toBe(200);

    const reloaded = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(reloaded.state).toBe("wager_submitted");

    const submission = await ctx.prisma.submission.findFirstOrThrow({ where: { enrollmentId: enrollment.id } });
    const run = await ctx.prisma.extractionRun.findFirstOrThrow({
      where: { submissionId: submission.id },
      include: { rows: true, reconciliation: true },
    });
    expect(run.status).toBe("succeeded");
    expect(run.rows.length).toBeGreaterThan(0);
    expect(run.reconciliation).not.toBeNull();
  });

  it("archives but does not advance state, and flags OUT_OF_SEQUENCE, when the enrollment was never funded", async () => {
    const participant = await ctx.prisma.participant.create({ data: {} });
    const enrollment = await ctx.prisma.enrollment.create({
      data: { participantId: participant.id, casino: "AcmeCasino", state: "invited" },
    });

    const video = await makeTestVideo();
    ctx.dropbox.seedFile(`${INTAKE_ROOT}/${enrollment.id}/recording.mp4`, video);

    await ctx.app.inject({ method: "POST", url: "/webhooks/dropbox", payload: {} });

    const reloaded = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(reloaded.state).toBe("invited");

    const submission = await ctx.prisma.submission.findFirstOrThrow({ where: { enrollmentId: enrollment.id } });
    const flags = await ctx.prisma.integrityFlag.findMany({ where: { submissionId: submission.id } });
    expect(flags.some((f) => f.code === "OUT_OF_SEQUENCE")).toBe(true);

    const runs = await ctx.prisma.extractionRun.findMany({ where: { submissionId: submission.id } });
    expect(runs).toHaveLength(0);
  });
});
