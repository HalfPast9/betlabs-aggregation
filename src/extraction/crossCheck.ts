import type { AssembledRow } from "./assemble.js";
import { timestampsAgree } from "./assemble.js";

export interface CrossCheckResult {
  /** Per primary row, in order: whether a second read covered it, and which fields differed. */
  perRow: Array<{ crossChecked: boolean; disagreements: string[] }>;
  disagreeingRows: number;
  uncoveredRows: number;
}

/**
 * Compare an independent second read against the primary rows, field by
 * field (docs/extraction-hardening.md §3). The balance chain already
 * adjudicates amounts and balances; this is the only check timestamps and
 * descriptions get. Rows are matched by position in the reconstructed list
 * (same segment, within a band or so), with the chain-protected fields
 * picking the counterpart when the second read is a row off.
 */
export function crossCheckRows(primary: AssembledRow[], secondary: AssembledRow[]): CrossCheckResult {
  const rowH = medianPitch(primary) ?? 80;
  const perRow = primary.map((p) => {
    // The counterpart is the nearby second-read row that agrees on the
    // chain-protected fields; a second read that dropped or added a row in
    // this tile lands its rows a band off, and matching by index would then
    // "disagree" on everything. Fall back to the nearest by position.
    const nearby = secondary.filter((s) => s.segmentIndex === p.segmentIndex && Math.abs(s.panoramaTop - p.panoramaTop) < rowH * 1.6);
    const match =
      nearby.find((s) => near(s.amount, p.amount) && near(s.balanceAfter, p.balanceAfter) && near(s.balanceBefore, p.balanceBefore)) ??
      nearby.sort((a, b) => Math.abs(a.panoramaTop - p.panoramaTop) - Math.abs(b.panoramaTop - p.panoramaTop))[0];
    if (!match) return { crossChecked: false, disagreements: [] };
    const disagreements: string[] = [];
    if (!sameTimestamp(p.timestamp, match.timestamp)) disagreements.push("timestamp");
    if (p.type !== match.type) disagreements.push("type");
    if (!sameDescription(p.description, match.description)) disagreements.push("description");
    if (!near(p.amount, match.amount)) disagreements.push("amount");
    if (!near(p.balanceBefore, match.balanceBefore)) disagreements.push("balanceBefore");
    if (!near(p.balanceAfter, match.balanceAfter)) disagreements.push("balanceAfter");
    return { crossChecked: true, disagreements };
  });
  return {
    perRow,
    disagreeingRows: perRow.filter((r) => r.disagreements.length > 0).length,
    uncoveredRows: perRow.filter((r) => !r.crossChecked).length,
  };
}

function near(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 0.011;
}

function sameTimestamp(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return timestampsAgree(a, b);
}

/** Descriptions are free text and the two reads word them differently; agreement means the same words, mostly. */
function sameDescription(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1));
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return ta.size === tb.size;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
}

function medianPitch(rows: AssembledRow[]): number | null {
  const diffs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.segmentIndex === b.segmentIndex && b.panoramaTop > a.panoramaTop) diffs.push(b.panoramaTop - a.panoramaTop);
  }
  if (diffs.length === 0) return null;
  diffs.sort((x, y) => x - y);
  return diffs[Math.floor(diffs.length / 2)]!;
}
