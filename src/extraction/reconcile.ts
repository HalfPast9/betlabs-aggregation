import type { ExtractionFlag, ValidatableRow } from "./validate.js";

export interface ReconciliationResult {
  wageredTotal: number;
  grantedAmount: number | null;
  delta: number | null;
  arithmeticOk: boolean;
  shortfall: boolean;
}

/** PRD §6.3 step 4 / §7 WAGER_SHORTFALL — reconcile wagering activity against the amount granted. */
export function reconcile(
  rows: ValidatableRow[],
  grantedAmount: number | null,
  arithmeticFlags: ExtractionFlag[],
): ReconciliationResult {
  // `type` is now a constrained vocabulary the extractor normalizes to
  // (visionExtractor.ts's TransactionType) regardless of how a given UI
  // words it — an exact match here, not a substring guess.
  const wageredTotal = rows
    .filter((r) => r.type === "bet")
    .reduce((sum, r) => sum + Math.abs(r.amount ?? 0), 0);

  return {
    wageredTotal,
    grantedAmount,
    delta: grantedAmount !== null ? wageredTotal - grantedAmount : null,
    arithmeticOk: arithmeticFlags.length === 0,
    shortfall: grantedAmount !== null && wageredTotal < grantedAmount,
  };
}
