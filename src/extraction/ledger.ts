import type { PrismaClient } from "@prisma/client";
import { foldSegments, type AssembledRow } from "./assemble.js";
import { verifyChain, type ChainResult } from "./chain.js";

export interface LedgerClip {
  submissionId: string;
  extractionRunId: string;
  receivedAt: Date;
  rows: number;
  chainStart: number | null;
  chainEnd: number | null;
  chainComplete: boolean | null;
}

export interface LedgerRow extends AssembledRow {
  submissionId: string;
  /** Sequence within its own extraction run — for linking back to the crop/highlight. */
  sourceSequence: number;
  timestampIso: string | null;
}

export interface Ledger {
  enrollmentId: string;
  /** In display order (newest first), as the combined list reads. */
  clips: LedgerClip[];
  rows: LedgerRow[];
  chain: ChainResult;
  wageredTotal: number;
  /** Breaks that fall exactly where one clip ends and the next begins — the clips don't connect. */
  betweenClips: number;
}

/**
 * One ledger per enrollment from every clip the participant sent
 * (docs/extraction-hardening.md §9). Clips are ordered by their chain
 * endpoints — a clip whose start balance is another's end balance follows
 * it — with arrival time as the fallback; overlapping rows are folded the
 * same way overlapping segments of one recording are; then the whole thing
 * is chain-verified as one list.
 */
export async function buildLedger(prisma: PrismaClient, enrollmentId: string): Promise<Ledger> {
  const submissions = await prisma.submission.findMany({
    where: { enrollmentId, kind: "wager_recording" },
    include: {
      extractionRuns: {
        where: { status: "succeeded" },
        orderBy: { startedAt: "desc" },
        take: 1,
        include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true },
      },
    },
    orderBy: { receivedAt: "asc" },
  });

  const clipsRaw = submissions
    .filter((s) => s.extractionRuns[0] && s.extractionRuns[0].rows.length > 0)
    .map((s) => {
      const run = s.extractionRuns[0]!;
      const rec = run.reconciliation;
      return {
        submissionId: s.id,
        receivedAt: s.receivedAt,
        run,
        chainStart: rec?.chainStart === null || rec?.chainStart === undefined ? null : Number(rec.chainStart),
        chainEnd: rec?.chainEnd === null || rec?.chainEnd === undefined ? null : Number(rec.chainEnd),
        chainComplete: rec?.chainComplete ?? null,
        newestFirst: rec?.newestFirst ?? true,
      };
    });

  // Chronological order by chain linkage, arrival time as the tie-breaker.
  const ordered: typeof clipsRaw = [];
  const remaining = [...clipsRaw];
  const cents = (v: number | null) => (v === null ? null : Math.round(v * 100));
  while (remaining.length > 0) {
    let next = remaining.findIndex((c) => !remaining.some((o) => o !== c && cents(o.chainEnd) !== null && cents(o.chainEnd) === cents(c.chainStart)));
    if (next < 0) next = 0;
    const clip = remaining.splice(next, 1)[0]!;
    ordered.push(clip);
    // Pull along whatever continues from it, greedily.
    let tail = clip;
    for (;;) {
      const k = remaining.findIndex((c) => cents(c.chainStart) !== null && cents(c.chainStart) === cents(tail.chainEnd));
      if (k < 0) break;
      tail = remaining.splice(k, 1)[0]!;
      ordered.push(tail);
    }
  }

  // Display order = newest first: later clips on top, each clip's rows as it displays them.
  const displayClips = [...ordered].reverse();
  const rowsBySegment: LedgerRow[] = [];
  displayClips.forEach((clip, segmentIndex) => {
    const rows = clip.newestFirst ? clip.run.rows : [...clip.run.rows].reverse();
    for (const r of rows) {
      rowsBySegment.push({
        submissionId: clip.submissionId,
        sourceSequence: r.sequence,
        timestampIso: r.timestamp ? r.timestamp.toISOString() : null,
        timestamp: r.timestamp ? r.timestamp.toISOString() : null,
        type: r.type,
        description: r.description,
        amount: r.amount === null ? null : Number(r.amount),
        balanceBefore: r.balanceBefore === null ? null : Number(r.balanceBefore),
        balanceAfter: r.balanceAfter === null ? null : Number(r.balanceAfter),
        confidence: r.confidence,
        partial: r.partial,
        segmentIndex,
        panoramaTop: r.panoramaTop ?? 0,
        panoramaBottom: r.panoramaBottom ?? 0,
        tileIndex: 0,
      });
    }
  });

  const folded = foldSegments(rowsBySegment) as LedgerRow[];
  const chain = verifyChain(folded);
  const boundaries = new Set<number>();
  for (let i = 1; i < folded.length; i++) if (folded[i]!.segmentIndex !== folded[i - 1]!.segmentIndex) boundaries.add(i);
  const betweenClips = chain.breaks.filter((b) => boundaries.has(b.rowIndex) || boundaries.has(b.rowIndex + 1)).length;

  return {
    enrollmentId,
    clips: displayClips.map((c) => ({
      submissionId: c.submissionId,
      extractionRunId: c.run.id,
      receivedAt: c.receivedAt,
      rows: c.run.rows.length,
      chainStart: c.chainStart,
      chainEnd: c.chainEnd,
      chainComplete: c.chainComplete,
    })),
    rows: folded,
    chain,
    wageredTotal: folded.filter((r) => r.type === "bet").reduce((a, r) => a + Math.abs(r.amount ?? 0), 0),
    betweenClips,
  };
}
