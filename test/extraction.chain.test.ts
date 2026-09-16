import { describe, expect, it } from "vitest";
import { verifyChain, type ChainRow } from "../src/extraction/chain.js";

function r(partial: Partial<ChainRow>): ChainRow {
  return { timestamp: null, type: null, amount: null, balanceBefore: null, balanceAfter: null, ...partial };
}

describe("verifyChain", () => {
  it("accepts an intact newest-first chain and reports its endpoints", () => {
    const res = verifyChain([
      r({ timestamp: "12:03", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 }),
      r({ timestamp: "12:02", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
      r({ timestamp: "12:01", type: "deposit", amount: 100, balanceBefore: 0, balanceAfter: 100 }),
    ]);
    expect(res.complete).toBe(true);
    expect(res.newestFirst).toBe(true);
    expect(res.startBalance).toBe(0);
    expect(res.endBalance).toBe(101);
    expect(res.checkedRows).toBe(3);
  });

  it("detects an oldest-first list", () => {
    const res = verifyChain([
      r({ timestamp: "12:01", type: "deposit", amount: 100, balanceBefore: 0, balanceAfter: 100 }),
      r({ timestamp: "12:02", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
      r({ timestamp: "12:03", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 }),
    ]);
    expect(res.complete).toBe(true);
    expect(res.newestFirst).toBe(false);
    expect(res.endBalance).toBe(101);
  });

  it("reports a link break where a row is missing", () => {
    const res = verifyChain([
      r({ timestamp: "12:04", type: "bet", amount: -1, balanceBefore: 101, balanceAfter: 100 }),
      // missing: 12:03 win 99→101
      r({ timestamp: "12:02", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
      r({ timestamp: "12:01", type: "deposit", amount: 100, balanceBefore: 0, balanceAfter: 100 }),
    ]);
    expect(res.complete).toBe(false);
    expect(res.breaks).toHaveLength(1);
    expect(res.breaks[0]!.kind).toBe("link");
    expect(res.breaks[0]!.detail).toContain("99.00");
    expect(res.breaks[0]!.detail).toContain("101.00");
  });

  it("accepts rows in a same-timestamp group in any display order (the UI's own tie order isn't chronological)", () => {
    // Real BetMGM behaviour: within "1:25 PM", 99→101 was displayed above
    // 101→103 even though it happened first.
    const res = verifyChain([
      r({ timestamp: "1:26 PM", type: "bet", amount: -1, balanceBefore: 103, balanceAfter: 102 }),
      r({ timestamp: "1:25 PM", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 }),
      r({ timestamp: "1:25 PM", type: "win", amount: 2, balanceBefore: 101, balanceAfter: 103 }),
      r({ timestamp: "1:25 PM", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
      r({ timestamp: "1:24 PM", type: "bet", amount: -1, balanceBefore: 101, balanceAfter: 100 }),
    ]);
    expect(res.complete).toBe(true);
    expect(res.newestFirst).toBe(true);
  });

  it("flags a same-timestamp group that can't form a single path", () => {
    const res = verifyChain([
      r({ timestamp: "1:25 PM", type: "win", amount: 2, balanceBefore: 99, balanceAfter: 101 }),
      r({ timestamp: "1:25 PM", type: "bet", amount: -1, balanceBefore: 50, balanceAfter: 49 }), // unrelated
      r({ timestamp: "1:24 PM", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
    ]);
    expect(res.complete).toBe(false);
    expect(res.breaks.some((b) => b.kind === "group")).toBe(true);
  });

  it("handles a closed loop within a group (balance returns to where it started)", () => {
    const res = verifyChain([
      r({ timestamp: "1:26 PM", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
      r({ timestamp: "1:25 PM", type: "win", amount: 1, balanceBefore: 99, balanceAfter: 100 }),
      r({ timestamp: "1:25 PM", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
      r({ timestamp: "1:24 PM", type: "deposit", amount: 100, balanceBefore: 0, balanceAfter: 100 }),
    ]);
    expect(res.complete).toBe(true);
  });

  it("derives the missing balance on single-running-balance UIs from type and amount", () => {
    const res = verifyChain([
      r({ timestamp: "12:03", type: "win", amount: 2, balanceAfter: 101 }),
      r({ timestamp: "12:02", type: "bet", amount: 1, balanceAfter: 99 }), // unsigned amount, sign from type
      r({ timestamp: "12:01", type: "deposit", amount: 100, balanceAfter: 100 }),
    ]);
    expect(res.complete).toBe(true);
    expect(res.startBalance).toBe(0);
    expect(res.endBalance).toBe(101);
  });

  it("treats a row with no usable balance as a break, not silently skipped", () => {
    const res = verifyChain([
      r({ timestamp: "12:02", type: "bet", amount: -1, balanceBefore: 100, balanceAfter: 99 }),
      r({ timestamp: "12:01", type: "deposit", amount: null, balanceBefore: null, balanceAfter: null }),
    ]);
    expect(res.complete).toBe(false);
    expect(res.breaks.some((b) => b.kind === "unreadable")).toBe(true);
  });

  it("is not complete when nothing could be checked", () => {
    expect(verifyChain([]).complete).toBe(false);
    expect(verifyChain([r({ amount: 5 })]).complete).toBe(false);
  });
});

describe("verifyChain — session cards split into bet + win rows", () => {
  it("checks a same-timestamp group by its net amount when only one row carries the balance", () => {
    const res = verifyChain([
      r({ timestamp: "6:11 PM", type: "bet", amount: -5, balanceBefore: null, balanceAfter: null }),
      r({ timestamp: "6:11 PM", type: "win", amount: 10, balanceBefore: null, balanceAfter: 84 }),
      r({ timestamp: "6:08 PM", type: "bet", amount: -1, balanceBefore: null, balanceAfter: 79 }),
    ]);
    expect(res.complete).toBe(true);
    expect(res.newestFirst).toBe(true);
    expect(res.startBalance).toBe(80);
    expect(res.endBalance).toBe(84);
  });

  it("reports a link break when the group's net doesn't reach its balance", () => {
    const res = verifyChain([
      r({ timestamp: "6:11 PM", type: "bet", amount: -5, balanceBefore: null, balanceAfter: null }),
      r({ timestamp: "6:11 PM", type: "win", amount: 10, balanceBefore: null, balanceAfter: 90 }),
      r({ timestamp: "6:08 PM", type: "bet", amount: -1, balanceBefore: null, balanceAfter: 79 }),
    ]);
    expect(res.complete).toBe(false);
    expect(res.breaks[0]!.kind).toBe("link");
  });
});

describe("verifyChain — UIs with no balances", () => {
  it("is not checkable rather than broken when only signed changes are shown", () => {
    const res = verifyChain([
      r({ timestamp: "11:56:51 PM", type: "win", amount: 30 }),
      r({ timestamp: "11:56:32 PM", type: "bet", amount: -15 }),
    ]);
    expect(res.complete).toBe(false);
    expect(res.checkedRows).toBe(0);
    expect(res.breaks).toHaveLength(0);
  });
});
