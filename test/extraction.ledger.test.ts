import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildLedger } from "../src/extraction/ledger.js";
import { resetDb } from "./helpers/testApp.js";

describe("buildLedger", () => {
  const prisma = new PrismaClient();
  beforeAll(async () => resetDb(prisma));
  afterEach(async () => resetDb(prisma));
  afterAll(async () => prisma.$disconnect());

  async function clip(enrollmentId: string, receivedAt: Date, rows: Array<{ ts: string; type: string; amount: number; before: number; after: number }>, chain: { start: number; end: number; complete: boolean }) {
    const contentHash = "h-" + Math.random().toString(36).slice(2);
    const media = await prisma.mediaAsset.create({ data: { blobKey: contentHash, contentHash, bytes: 1 } });
    const sub = await prisma.submission.create({ data: { enrollmentId, kind: "wager_recording", channel: "manual_upload", mediaAssetId: media.id, contentHash, receivedAt } });
    const run = await prisma.extractionRun.create({ data: { submissionId: sub.id, extractorVersion: "t", model: "fake", status: "succeeded" } });
    for (const [i, r] of rows.entries()) {
      await prisma.transactionRow.create({ data: { extractionRunId: run.id, sequence: i, rowKey: `k${i}`, timestamp: new Date(r.ts), type: r.type, amount: r.amount, balanceBefore: r.before, balanceAfter: r.after, segmentIndex: 0, panoramaTop: i * 100, panoramaBottom: i * 100 + 90 } });
    }
    await prisma.reconciliation.create({ data: { extractionRunId: run.id, wageredTotal: 0, arithmeticOk: true, chainComplete: chain.complete, chainStart: chain.start, chainEnd: chain.end, newestFirst: true, chainBreaks: [] } });
    return sub;
  }

  it("orders clips by chain linkage (not arrival), folds the overlap, and verifies the whole", async () => {
    const participant = await prisma.participant.create({ data: {} });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "Acme", state: "wager_submitted" } });

    // Later clip (newer transactions) arrived FIRST; it starts where the earlier one ends (100) and re-shows its top two rows.
    await clip(enrollment.id, new Date("2026-01-01T10:00:00Z"), [
      { ts: "2026-01-01T09:05:00Z", type: "bet", amount: -1, before: 101, after: 100 },
      { ts: "2026-01-01T09:04:00Z", type: "win", amount: 2, before: 99, after: 101 },
      { ts: "2026-01-01T09:03:00Z", type: "bet", amount: -1, before: 100, after: 99 },
      { ts: "2026-01-01T09:02:00Z", type: "win", amount: 1, before: 99, after: 100 },
    ], { start: 99, end: 100, complete: true });
    await clip(enrollment.id, new Date("2026-01-01T11:00:00Z"), [
      { ts: "2026-01-01T09:03:00Z", type: "bet", amount: -1, before: 100, after: 99 },
      { ts: "2026-01-01T09:02:00Z", type: "win", amount: 1, before: 99, after: 100 },
      { ts: "2026-01-01T09:01:00Z", type: "bet", amount: -1, before: 100, after: 99 },
      { ts: "2026-01-01T09:00:00Z", type: "deposit", amount: 100, before: 0, after: 100 },
    ], { start: 0, end: 99, complete: true });

    const ledger = await buildLedger(prisma, enrollment.id);
    expect(ledger.clips).toHaveLength(2);
    expect(ledger.rows).toHaveLength(6);
    expect(ledger.rows.map((r) => r.timestampIso!.slice(11, 16))).toEqual(["09:05", "09:04", "09:03", "09:02", "09:01", "09:00"]);
    expect(ledger.chain.complete).toBe(true);
    expect(ledger.chain.startBalance).toBe(0);
    expect(ledger.chain.endBalance).toBe(100);
    expect(ledger.wageredTotal).toBe(3);
    expect(ledger.betweenClips).toBe(0);
  });

  it("reports a break between clips that don't connect", async () => {
    const participant = await prisma.participant.create({ data: {} });
    const enrollment = await prisma.enrollment.create({ data: { participantId: participant.id, casino: "Acme", state: "wager_submitted" } });
    await clip(enrollment.id, new Date("2026-01-01T10:00:00Z"), [
      { ts: "2026-01-01T09:01:00Z", type: "bet", amount: -1, before: 100, after: 99 },
      { ts: "2026-01-01T09:00:00Z", type: "deposit", amount: 100, before: 0, after: 100 },
    ], { start: 0, end: 99, complete: true });
    await clip(enrollment.id, new Date("2026-01-01T11:00:00Z"), [
      { ts: "2026-01-01T09:09:00Z", type: "bet", amount: -1, before: 50, after: 49 },
      { ts: "2026-01-01T09:08:00Z", type: "bet", amount: -1, before: 51, after: 50 },
    ], { start: 51, end: 49, complete: true });

    const ledger = await buildLedger(prisma, enrollment.id);
    expect(ledger.rows).toHaveLength(4);
    expect(ledger.chain.complete).toBe(false);
    expect(ledger.betweenClips).toBe(1);
  });
});
