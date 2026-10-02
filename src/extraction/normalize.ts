import type { AssembledRow } from "./assemble.js";

/**
 * Deterministic clean-up of assembled rows for the rules a model may not
 * follow (docs/extraction-hardening.md §1). The prompt describes these; the
 * code guarantees them, so a cheaper model that reads every number right but
 * ignores an edge-case instruction still yields the same rows.
 */
export function normalizeRows(rows: AssembledRow[]): AssembledRow[] {
  return stripDeltaBalances(mergeZeroWinRows(stripPlaceholderTimestamps(rows)));
}

/** "6:1x PM" — a digit the model couldn't see at a tile edge. Not a timestamp. */
function stripPlaceholderTimestamps(rows: AssembledRow[]): AssembledRow[] {
  return rows.map((r) => (r.timestamp && /[xX?_]/.test(r.timestamp) ? { ...r, timestamp: null } : r));
}

/**
 * A session card ("Bets $5 / Wins $0 / Balance after $45") read as a bet row
 * with no balance followed by a zero-amount row carrying the balance: the
 * balance belongs to the bet, the zero row is nothing.
 */
function mergeZeroWinRows(rows: AssembledRow[]): AssembledRow[] {
  const out: AssembledRow[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    const isZero = row.amount !== null && Math.abs(row.amount) < 0.005;
    if (prev && isZero && prev.amount !== null && sameGroup(prev, row)) {
      // The zero row carries the card's balance if the bet row didn't already.
      const balanceAfter = prev.balanceAfter ?? row.balanceAfter;
      const balanceBefore = prev.balanceBefore ?? row.balanceBefore;
      out[out.length - 1] = { ...prev, balanceAfter, balanceBefore, panoramaBottom: row.panoramaBottom };
      continue;
    }
    out.push(row);
  }
  return out;
}

function sameGroup(a: AssembledRow, b: AssembledRow): boolean {
  if (a.segmentIndex !== b.segmentIndex) return false;
  if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return false;
  const da = (a.description ?? "").toLowerCase();
  const db = (b.description ?? "").toLowerCase();
  return da === db || da.startsWith(db) || db.startsWith(da);
}

/**
 * A "balance" that equals the row's own signed change on every row that has
 * one is the change copied into the wrong field ("My Balance +$30.00" is a
 * delta). A real running balance never tracks the amount like that.
 */
function stripDeltaBalances(rows: AssembledRow[]): AssembledRow[] {
  const withBalance = rows.filter((r) => r.balanceAfter !== null && r.amount !== null);
  if (withBalance.length < 3) return rows;
  const allCopies = withBalance.every((r) => Math.abs(r.balanceAfter! - r.amount!) < 0.005 && r.balanceBefore === null);
  if (!allCopies) return rows;
  return rows.map((r) => (r.balanceAfter !== null ? { ...r, balanceAfter: null } : r));
}
