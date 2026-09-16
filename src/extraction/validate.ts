export interface ValidatableRow {
  timestamp: string | null;
  type: string | null;
  description?: string | null;
  amount: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
}

export interface ExtractionFlag {
  code: string;
  severity: "info" | "warning" | "high";
  detail: string;
}

const AMOUNT_TOLERANCE = 0.01;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * PRD §7 ARITHMETIC_MISMATCH — a row whose own before/after balance doesn't
 * move by its own amount. Only rows that carry both balances can be checked
 * this way; row-to-row consistency (including single-balance UIs) is the
 * balance chain's job (extraction/chain.ts), which is where "did we read
 * everything" is decided.
 */
export function validateArithmetic(rows: ValidatableRow[]): ExtractionFlag[] {
  const flags: ExtractionFlag[] = [];
  rows.forEach((row, i) => {
    if (row.balanceBefore === null || row.balanceAfter === null || row.amount === null) return;
    const actualDelta = Math.abs(row.balanceAfter - row.balanceBefore);
    const expectedDelta = Math.abs(row.amount);
    if (Math.abs(actualDelta - expectedDelta) > AMOUNT_TOLERANCE) {
      flags.push({
        code: "ARITHMETIC_MISMATCH",
        severity: "high",
        detail: `Row ${i}: its own before/after balance moved by ${actualDelta.toFixed(2)} but the row amount was ${expectedDelta.toFixed(2)}`,
      });
    }
  });
  return flags;
}

/** PRD §7 TIMESTAMP_ANOMALY — rows out of order, dated in the future, or with implausible gaps. */
export function validateTimestamps(rows: ValidatableRow[]): ExtractionFlag[] {
  const flags: ExtractionFlag[] = [];
  const parsed = rows
    .map((row, i) => ({ i, row, date: row.timestamp ? new Date(row.timestamp) : null }))
    .filter((p): p is { i: number; row: ValidatableRow; date: Date } => !!p.date && !Number.isNaN(p.date.getTime()));

  const now = Date.now();
  for (const p of parsed) {
    if (p.date.getTime() > now + FUTURE_TOLERANCE_MS) {
      flags.push({
        code: "TIMESTAMP_ANOMALY",
        severity: "high",
        detail: `Row ${p.i} is timestamped in the future: ${p.date.toISOString()}`,
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
      // Ties (same displayed minute — many casino UIs don't show seconds
      // or a date, e.g. "1:23 PM" repeated across several distinct
      // transactions) are neither, and deliberately don't count either way.
    }
    const total = increasing + decreasing;
    // A real scroll capture should read monotonically one direction or the
    // other; a mix of both suggests spliced or misread frames. The
    // threshold is deliberately lenient (not just "any reversal") because
    // coarse timestamps make an occasional tie-breaking reversal expected
    // noise, not a signal — this should only fire on a genuinely
    // inconsistent sequence.
    if (total >= 4 && Math.min(increasing, decreasing) / total > 0.3) {
      flags.push({
        code: "TIMESTAMP_ANOMALY",
        severity: "warning",
        detail: `Row timestamps are not consistently ordered (${increasing} increasing steps, ${decreasing} decreasing steps)`,
      });
    }
  }

  return flags;
}

/**
 * Parse a timestamp the way a casino UI wrote it. Beyond what `Date` takes
 * on its own: "6:50pm" without a space, a trailing zone abbreviation
 * ("11:56:51 PM ET"), a session range ("6:27:16 PM – 6:28:00 PM EST" —
 * the start is the transaction time), and "1:23 PM 11/30/25" written
 * time-first. Wall-clock local, like the display; no zone conversion.
 */
export function safeParseDate(value: string | null): Date | null {
  if (!value) return null;
  let s = value.trim();
  // A range: keep the start.
  s = s.replace(/\s*[-–—]\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\b.*$/i, "");
  // Zone abbreviations and stray words the parser doesn't know.
  s = s.replace(/\b(?:E|C|M|P|A|H)(?:S|D)?T\b|\bUTC\b|\bGMT\b/g, "").trim();
  // "6:50pm" → "6:50 pm"; "6:50 p.m." → "6:50 pm".
  s = s.replace(/(\d)\s*([ap])\.?m\.?\b/i, "$1 $2m");
  s = s.replace(/\s{2,}/g, " ").replace(/\s*,\s*/g, ", ").trim();
  const date = new Date(s);
  return Number.isNaN(date.getTime()) ? null : date;
}
