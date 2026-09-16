import { describe, expect, it } from "vitest";
import { validateArithmetic, validateTimestamps, type ValidatableRow } from "../src/extraction/validate.js";

function row(partial: Partial<ValidatableRow>): ValidatableRow {
  return {
    timestamp: null,
    type: null,
    description: null,
    amount: null,
    balanceBefore: null,
    balanceAfter: null,
    ...partial,
  };
}

describe("validateArithmetic", () => {
  it("passes a self-contained row whose own before/after balance matches its amount", () => {
    const flags = validateArithmetic([row({ amount: 10, balanceBefore: 100, balanceAfter: 90 })]);
    expect(flags).toHaveLength(0);
  });

  it("flags a self-contained row whose own before/after balance doesn't match its amount", () => {
    // This is the real BetMGM-shaped case: two distinct balances on one row.
    const flags = validateArithmetic([row({ amount: 100, balanceBefore: 100, balanceAfter: 99 })]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe("ARITHMETIC_MISMATCH");
    expect(flags[0]?.detail).toContain("its own before/after balance");
  });

  it("never compares across rows — row-to-row consistency is the balance chain's job", () => {
    // Display order doesn't reflect chronology within a same-minute group,
    // so a self-contained row must not be flagged because its neighbour in
    // the list has an unrelated balance.
    const flags = validateArithmetic([
      row({ amount: 5, balanceBefore: 200, balanceAfter: 195 }),
      row({ amount: 10, balanceBefore: 50, balanceAfter: 40 }),
      row({ amount: 10, balanceAfter: 100 }),
      row({ amount: 10, balanceAfter: 50 }),
    ]);
    expect(flags).toHaveLength(0);
  });

  it("skips a row missing its own before/after pair", () => {
    expect(validateArithmetic([row({ amount: 10 })])).toHaveLength(0);
    expect(validateArithmetic([row({ amount: 10, balanceAfter: 90 })])).toHaveLength(0);
  });
});

describe("validateTimestamps", () => {
  function tsRow(iso: string) {
    return row({ timestamp: iso });
  }

  it("does not flag ties from minute-precision, no-date timestamps repeated across distinct rows", () => {
    // Same displayed "time" for several genuinely different transactions —
    // normal on UIs like BetMGM's ("1:23 PM" with no seconds or date).
    const flags = validateTimestamps([
      tsRow("2026-01-01T13:23:00Z"),
      tsRow("2026-01-01T13:23:00Z"),
      tsRow("2026-01-01T13:23:00Z"),
      tsRow("2026-01-01T13:23:00Z"),
    ]);
    expect(flags.filter((f) => f.detail.includes("not consistently ordered"))).toHaveLength(0);
  });

  it("does not flag a single isolated reversal amongst an otherwise-consistent sequence", () => {
    const flags = validateTimestamps([
      tsRow("2026-01-01T13:20:00Z"),
      tsRow("2026-01-01T13:21:00Z"),
      tsRow("2026-01-01T13:22:00Z"),
      tsRow("2026-01-01T13:19:00Z"), // one out-of-place read
      tsRow("2026-01-01T13:23:00Z"),
    ]);
    expect(flags.filter((f) => f.detail.includes("not consistently ordered"))).toHaveLength(0);
  });

  it("still flags a genuinely inconsistent sequence", () => {
    const flags = validateTimestamps([
      tsRow("2026-01-01T13:20:00Z"),
      tsRow("2026-01-01T13:10:00Z"),
      tsRow("2026-01-01T13:25:00Z"),
      tsRow("2026-01-01T13:05:00Z"),
      tsRow("2026-01-01T13:30:00Z"),
    ]);
    expect(flags.some((f) => f.detail.includes("not consistently ordered"))).toBe(true);
  });

  it("still flags a future-dated row", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const flags = validateTimestamps([tsRow(future)]);
    expect(flags.some((f) => f.detail.includes("future"))).toBe(true);
  });
});
