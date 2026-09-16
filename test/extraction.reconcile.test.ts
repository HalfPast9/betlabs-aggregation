import { describe, expect, it } from "vitest";
import { reconcile } from "../src/extraction/reconcile.js";
import type { ValidatableRow } from "../src/extraction/validate.js";

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

describe("reconcile", () => {
  it("sums only rows typed exactly 'bet', regardless of description wording", () => {
    const rows = [
      row({ type: "bet", amount: 10, description: "Taken to Detroit Lions Blackjack" }),
      row({ type: "bet", amount: 5, description: "Wager on Roulette" }),
      row({ type: "win", amount: 45, description: "Taken from Detroit Lions Blackjack" }),
      row({ type: "deposit", amount: 100, description: null }),
      row({ type: "other", amount: 3, description: "Fee" }),
    ];
    const result = reconcile(rows, null, []);
    expect(result.wageredTotal).toBe(15);
  });

  it("flags a shortfall against the granted amount", () => {
    const rows = [row({ type: "bet", amount: 10 })];
    const result = reconcile(rows, 100, []);
    expect(result.shortfall).toBe(true);
    expect(result.delta).toBe(-90);
  });

  it("does not shortfall when wagered meets or exceeds the grant", () => {
    const rows = [row({ type: "bet", amount: 150 })];
    const result = reconcile(rows, 100, []);
    expect(result.shortfall).toBe(false);
  });
});
