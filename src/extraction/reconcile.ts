import type { StitchedRow } from "./stitch.js";
import type { ExtractionFlag } from "./validate.js";

// Casino UIs describe transaction types with free text we don't control
// (§6.3's whole rationale for a generalist reader over per-casino parsers),
// so "was this a wager" is a substring heuristic, not a fixed enum match.
const WAGER_TYPE_HINTS = ["bet", "wager", "stake"];

export interface ReconciliationResult {
  wageredTotal: number;
  grantedAmount: number | null;
  delta: number | null;
  arithmeticOk: boolean;
  shortfall: boolean;
}

/** PRD §6.3 step 4 / §7 WAGER_SHORTFALL — reconcile wagering activity against the amount granted. */
export function reconcile(
  rows: StitchedRow[],
  grantedAmount: number | null,
  arithmeticFlags: ExtractionFlag[],
): ReconciliationResult {
  const wageredTotal = rows
    .filter((r) => r.type && WAGER_TYPE_HINTS.some((hint) => r.type!.toLowerCase().includes(hint)))
    .reduce((sum, r) => sum + Math.abs(r.amount ?? 0), 0);

  return {
    wageredTotal,
    grantedAmount,
    delta: grantedAmount !== null ? wageredTotal - grantedAmount : null,
    arithmeticOk: arithmeticFlags.length === 0,
    shortfall: grantedAmount !== null && wageredTotal < grantedAmount,
  };
}
