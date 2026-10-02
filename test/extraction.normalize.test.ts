import { describe, expect, it } from "vitest";
import { normalizeRows } from "../src/extraction/normalize.js";
import type { AssembledRow } from "../src/extraction/assemble.js";

function row(p: Partial<AssembledRow>): AssembledRow {
  return { timestamp: null, type: "bet", description: null, amount: -1, balanceBefore: null, balanceAfter: null, confidence: 0.9, partial: false, segmentIndex: 0, panoramaTop: 0, panoramaBottom: 90, tileIndex: 0, ...p };
}

describe("normalizeRows", () => {
  it("folds a zero-amount 'win' row carrying a session card's balance into the bet row", () => {
    const out = normalizeRows([
      row({ timestamp: "6:27 PM", description: "Blackjack Classic 75", amount: -5 }),
      row({ timestamp: "6:27 PM", description: "Blackjack Classic 75 - Wins", type: "other", amount: 0, balanceAfter: 45 }),
      row({ timestamp: "6:20 PM", description: "Free Bet Blackjack", amount: -5 }),
      row({ timestamp: "6:20 PM", description: "Free Bet Blackjack", type: "win", amount: 0, balanceAfter: 50 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.balanceAfter)).toEqual([45, 50]);
    expect(out.map((r) => r.type)).toEqual(["bet", "bet"]);
  });

  it("keeps a real win row (non-zero) after a bet row", () => {
    const out = normalizeRows([
      row({ timestamp: "6:12 PM", description: "Free Bet Blackjack", amount: -5 }),
      row({ timestamp: "6:12 PM", description: "Free Bet Blackjack", type: "win", amount: 10, balanceAfter: 85 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("nulls balances that are just the signed change copied over", () => {
    const out = normalizeRows([
      row({ type: "win", amount: 30, balanceAfter: 30 }),
      row({ type: "bet", amount: -15, balanceAfter: -15 }),
      row({ type: "win", amount: 10, balanceAfter: 10 }),
      row({ type: "deposit", amount: 93, balanceAfter: 93 }),
    ]);
    expect(out.every((r) => r.balanceAfter === null)).toBe(true);
  });

  it("leaves a genuine running balance alone even when one row happens to equal its amount", () => {
    const out = normalizeRows([
      row({ type: "deposit", amount: 100, balanceAfter: 100 }),
      row({ type: "bet", amount: -1, balanceAfter: 99 }),
      row({ type: "win", amount: 2, balanceAfter: 101 }),
    ]);
    expect(out.map((r) => r.balanceAfter)).toEqual([100, 99, 101]);
  });

  it("drops placeholder timestamps the model invented for cut-off digits", () => {
    const out = normalizeRows([row({ timestamp: "12/24/2025 6:1x PM" }), row({ timestamp: "12/24/2025 6:12 PM" })]);
    expect(out.map((r) => r.timestamp)).toEqual([null, "12/24/2025 6:12 PM"]);
  });
});
