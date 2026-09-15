import { sha256Hex } from "../lib/hash.js";
import type { RawExtractedRow } from "./visionExtractor.js";

export interface StitchedRow {
  rowKey: string;
  timestamp: string | null;
  type: string | null;
  amount: number | null;
  balanceAfter: number | null;
  sourceFrameTs: number;
  confidence: number | null;
}

export interface FrameRowSource {
  rows: RawExtractedRow[];
  timestampSeconds: number;
}

/**
 * PRD §6.3 step 3: the same row appears across many frames at different
 * scroll offsets, so dedupe by a stable key and reassemble one ordered list.
 * Order is by first-seen frame timestamp — the order rows actually appeared
 * while scrolling, which is the only ordering the capture itself guarantees.
 */
export function stitchRows(frames: FrameRowSource[]): StitchedRow[] {
  const byKey = new Map<string, StitchedRow>();

  for (const frame of frames) {
    for (const row of frame.rows) {
      // A row needs at least a timestamp or an amount to be worth keeping —
      // an all-null read is extraction noise, not a transaction.
      if (row.timestamp === null && row.amount === null) continue;

      const key = rowKey(row);
      const existing = byKey.get(key);
      if (existing) {
        if ((row.confidence ?? 0) > (existing.confidence ?? 0)) {
          existing.confidence = row.confidence;
        }
        continue;
      }

      byKey.set(key, {
        rowKey: key,
        timestamp: row.timestamp,
        type: row.type,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
        sourceFrameTs: frame.timestampSeconds,
        confidence: row.confidence,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.sourceFrameTs - b.sourceFrameTs);
}

function rowKey(row: RawExtractedRow): string {
  const canonical = `${row.timestamp ?? ""}|${row.type ?? ""}|${row.amount ?? ""}|${row.balanceAfter ?? ""}`;
  return sha256Hex(Buffer.from(canonical, "utf8"));
}
