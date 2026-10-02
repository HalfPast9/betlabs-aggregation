import { describe, expect, it } from "vitest";
import { assembleRows, foldSegments } from "../src/extraction/assemble.js";
import type { Tile } from "../src/extraction/panorama.js";
import type { RawExtractedRow } from "../src/extraction/visionExtractor.js";

function tile(index: number, top: number, bottom: number, segmentIndex = 0): Tile {
  return { index, segmentIndex, jpegBuffer: Buffer.alloc(0), top, bottom, scale: 1, rulerTickEvery: 100, bands: null, firstBandIndex: 0 };
}

function row(partial: Partial<RawExtractedRow>): RawExtractedRow {
  return { timestamp: null, type: "bet", description: null, amount: -1, balanceBefore: null, balanceAfter: null, confidence: 0.9, fullyVisible: true, yTop: null, ...partial };
}

describe("assembleRows", () => {
  it("merges a row read by two overlapping tiles at the same position, keeping the fully-visible read", () => {
    const tiles = [tile(0, 0, 1400), tile(1, 1080, 2480)];
    const reads = [
      {
        tileIndex: 0,
        rows: [
          row({ yTop: 100, amount: -1, balanceAfter: 99 }),
          row({ yTop: 1200, amount: 2, balanceAfter: 101 }),
          row({ yTop: 1300, amount: -1, balanceAfter: 100, fullyVisible: false, timestamp: null }), // cut by tile 0's bottom edge
        ],
      },
      {
        tileIndex: 1,
        rows: [
          row({ yTop: 1200, amount: 2, balanceAfter: 101 }),
          row({ yTop: 1300, amount: -1, balanceAfter: 100, timestamp: "12:03" }),
          row({ yTop: 1400, amount: -1, balanceAfter: 99 }),
        ],
      },
    ];
    const result = assembleRows(tiles, reads, false);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.map((r) => r.panoramaTop)).toEqual([100, 1200, 1300, 1400]);
    expect(result.rows[2]!.timestamp).toBe("12:03");
    expect(result.rows[2]!.partial).toBe(false);
    expect(result.conflicts).toBe(0);
  });

  it("keeps content-identical rows at different positions distinct", () => {
    const reads = [{ tileIndex: 0, rows: [100, 200, 300, 400].map((y) => row({ yTop: y, amount: -1, balanceBefore: 100, balanceAfter: 99 })) }];
    expect(assembleRows([tile(0, 0, 1400)], reads, false).rows).toHaveLength(4);
  });

  it("counts a conflict when two tiles read the same position differently", () => {
    const tiles = [tile(0, 0, 1400), tile(1, 1080, 2480)];
    const reads = [
      { tileIndex: 0, rows: [row({ yTop: 1200, amount: 2, balanceAfter: 101, confidence: 0.5 })] },
      { tileIndex: 1, rows: [row({ yTop: 1200, amount: 5, balanceAfter: 101, confidence: 0.9 })] },
    ];
    const result = assembleRows(tiles, reads, false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.amount).toBe(5);
    expect(result.conflicts).toBe(1);
  });

  it("interpolates a position the model didn't give from its neighbours", () => {
    const reads = [{ tileIndex: 0, rows: [row({ yTop: 100 }), row({ yTop: null }), row({ yTop: 300 })] }];
    const result = assembleRows([tile(0, 0, 1400)], reads, false);
    expect(result.rows.map((r) => r.panoramaTop)).toEqual([100, 200, 300]);
    expect(result.unpositioned).toBe(1);
  });

  it("orders segments by scroll direction: later segments come first when the participant scrolled toward the top", () => {
    const tiles = [tile(0, 0, 500, 0), tile(1, 0, 500, 1)];
    const reads = [
      { tileIndex: 0, rows: [row({ yTop: 10, description: "older" })] },
      { tileIndex: 1, rows: [row({ yTop: 10, description: "newer" })] },
    ];
    expect(assembleRows(tiles, reads, true).rows.map((r) => r.description)).toEqual(["newer", "older"]);
    expect(assembleRows(tiles, reads, false).rows.map((r) => r.description)).toEqual(["older", "newer"]);
  });
});

describe("assembleRows — segments that overlap in content", () => {
  it("folds a later segment that re-shows rows already captured, keeping only its new rows", () => {
    const tiles = [tile(0, 0, 500, 0), tile(1, 0, 500, 1)];
    const reads = [
      {
        tileIndex: 0,
        rows: [
          row({ yTop: 10, timestamp: "6:20 PM", amount: -5, balanceAfter: 50 }),
          row({ yTop: 110, timestamp: "6:19 PM", amount: -5, balanceAfter: 55 }),
          row({ yTop: 210, timestamp: "6:18 PM", amount: -5, balanceAfter: 60 }),
        ],
      },
      {
        tileIndex: 1,
        rows: [
          row({ yTop: 10, timestamp: "6:19 PM", amount: -5, balanceAfter: 55 }),
          row({ yTop: 110, timestamp: "6:18 PM", amount: -5, balanceAfter: 60 }),
          row({ yTop: 210, timestamp: "6:17 PM", amount: -10, balanceAfter: 65 }),
        ],
      },
    ];
    const rows = foldSegments(assembleRows(tiles, reads, false).rows);
    expect(rows.map((r) => r.timestamp)).toEqual(["6:20 PM", "6:19 PM", "6:18 PM", "6:17 PM"]);
  });

  it("does not glue segments together on a single identical-looking row", () => {
    const tiles = [tile(0, 0, 500, 0), tile(1, 0, 500, 1)];
    const reads = [
      { tileIndex: 0, rows: [row({ yTop: 10, timestamp: "6:20 PM", amount: -5, balanceAfter: 50 }), row({ yTop: 110, timestamp: "6:19 PM", amount: -5, balanceAfter: 55 })] },
      { tileIndex: 1, rows: [row({ yTop: 10, timestamp: "6:19 PM", amount: -5, balanceAfter: 55 }), row({ yTop: 110, timestamp: "6:10 PM", amount: -1, balanceAfter: 99 })] },
    ];
    // Only one row matches ("6:19 PM"); that's not enough to claim overlap.
    expect(foldSegments(assembleRows(tiles, reads, false).rows)).toHaveLength(4);
  });
});
