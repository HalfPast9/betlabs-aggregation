import type { StitchedRow } from "./stitch.js";

export interface ExtractionFlag {
  code: string;
  severity: "info" | "warning" | "high";
  detail: string;
}

const AMOUNT_TOLERANCE = 0.01;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** PRD §7 ARITHMETIC_MISMATCH — row amounts don't reconcile against the displayed running balance. */
export function validateArithmetic(rows: StitchedRow[]): ExtractionFlag[] {
  const flags: ExtractionFlag[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    if (prev.balanceAfter === null || cur.balanceAfter === null || cur.amount === null) continue;

    const actualDelta = Math.abs(cur.balanceAfter - prev.balanceAfter);
    const expectedDelta = Math.abs(cur.amount);
    if (Math.abs(actualDelta - expectedDelta) > AMOUNT_TOLERANCE) {
      flags.push({
        code: "ARITHMETIC_MISMATCH",
        severity: "high",
        detail: `Row ${cur.rowKey.slice(0, 12)}: balance moved by ${actualDelta.toFixed(2)} but the row amount was ${expectedDelta.toFixed(2)}`,
      });
    }
  }
  return flags;
}

/** PRD §7 TIMESTAMP_ANOMALY — rows out of order, dated in the future, or with implausible gaps. */
export function validateTimestamps(rows: StitchedRow[]): ExtractionFlag[] {
  const flags: ExtractionFlag[] = [];
  const parsed = rows
    .map((row, i) => ({ i, row, date: row.timestamp ? new Date(row.timestamp) : null }))
    .filter((p): p is { i: number; row: StitchedRow; date: Date } => !!p.date && !Number.isNaN(p.date.getTime()));

  const now = Date.now();
  for (const p of parsed) {
    if (p.date.getTime() > now + FUTURE_TOLERANCE_MS) {
      flags.push({
        code: "TIMESTAMP_ANOMALY",
        severity: "high",
        detail: `Row ${p.row.rowKey.slice(0, 12)} is timestamped in the future: ${p.date.toISOString()}`,
      });
    }
  }

  if (parsed.length >= 3) {
    let increasing = 0;
    let decreasing = 0;
    for (let i = 1; i < parsed.length; i++) {
      const diff = parsed[i]!.date.getTime() - parsed[i - 1]!.date.getTime();
      if (diff > 0) increasing++;
      else if (diff < 0) decreasing++;
    }
    const total = increasing + decreasing;
    // A real scroll capture should read monotonically one direction or the
    // other; a mix of both suggests spliced or misread frames.
    if (total > 0 && Math.min(increasing, decreasing) / total > 0.2) {
      flags.push({
        code: "TIMESTAMP_ANOMALY",
        severity: "warning",
        detail: `Row timestamps are not consistently ordered (${increasing} increasing steps, ${decreasing} decreasing steps)`,
      });
    }
  }

  return flags;
}

export function safeParseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
