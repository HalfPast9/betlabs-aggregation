import type { Tile } from "./panorama.js";
import type { RawExtractedRow, TileReadResult } from "./visionExtractor.js";
import { safeParseDate } from "./validate.js";

export interface AssembledRow {
  timestamp: string | null;
  type: string | null;
  description: string | null;
  amount: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
  confidence: number | null;
  /** True when no tile had the whole row (the recording started or ended mid-row). */
  partial: boolean;
  segmentIndex: number;
  /** Full-res panorama px within the segment. */
  panoramaTop: number;
  panoramaBottom: number;
  tileIndex: number;
}

export interface AssemblyResult {
  /** Display order, top of the list first. */
  rows: AssembledRow[];
  /** Same position read two ways — the higher-quality read won, but it's worth a flag. */
  conflicts: number;
  /** Rows the model returned without a ruler position, placed by interpolation. */
  unpositioned: number;
}

const AMOUNT_TOL = 0.011;

function near(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return Math.abs(a - b) <= AMOUNT_TOL;
}

/** "11/30/25 1:51 PM" and "1:51 PM 11/30/25" are the same timestamp read in a different order. */
function timestampKey(ts: string): string {
  return ts.toLowerCase().split(/[\s,]+/).filter(Boolean).sort().join(" ");
}

const hasTimeOfDay = (ts: string) => /\d{1,2}:\d{2}/.test(ts);

/**
 * Same moment, allowing for how differently two tiles can write it — and
 * for one read having dropped the time-of-day: a date-only read agrees
 * with any full timestamp on that date.
 */
export function timestampsAgree(a: string, b: string): boolean {
  const da = safeParseDate(a);
  const db = safeParseDate(b);
  if (da && db) {
    if (da.getTime() === db.getTime()) return true;
    if (!hasTimeOfDay(a) || !hasTimeOfDay(b)) return da.toDateString() === db.toDateString();
    return false;
  }
  return timestampKey(a) === timestampKey(b);
}

/** Two reads describe the same row unless a field they both have disagrees. */
export function compatible(a: RawExtractedRow, b: RawExtractedRow): boolean {
  if (!near(a.amount, b.amount)) return false;
  if (!near(a.balanceAfter, b.balanceAfter)) return false;
  if (!near(a.balanceBefore, b.balanceBefore)) return false;
  // A read cut off by a tile edge may carry a guessed or placeholder
  // timestamp ("6:1x PM"); only two full reads can disagree on time.
  if (a.fullyVisible && b.fullyVisible && a.timestamp && b.timestamp && !timestampsAgree(a.timestamp, b.timestamp)) return false;
  return true;
}

function quality(r: RawExtractedRow): number {
  const fields = [r.timestamp, r.type, r.amount, r.balanceBefore, r.balanceAfter].filter((v) => v !== null).length;
  const fullTimestamp = r.timestamp !== null && hasTimeOfDay(r.timestamp) ? 5 : 0;
  return (r.fullyVisible ? 100 : 0) + fields * 10 + fullTimestamp + (r.confidence ?? 0);
}

interface Placed {
  row: RawExtractedRow;
  y: number;
  bottom: number | null;
  segmentIndex: number;
  tileIndex: number;
  /** "segment:band:sub" when the row sits on a detected band — the dedup key across tiles. */
  bandKey: string | null;
}

/**
 * Place each tile's rows on the panorama (ruler reading × scale), then merge
 * overlapping tiles by aligning their reads as *ordered sequences* — the
 * tail of what's been placed against the head of the new tile — rather
 * than matching rows one at a time by coordinate. Ruler readings are
 * quantized (labels every 100px, rows ~90px apart), so a single row's
 * position is only good to about half a row, but the *order* of rows in a
 * tile is exact. Sequence alignment uses both: consecutive rows must all be
 * content-compatible and within a row-and-a-half of each other. Identical
 * looking distinct transactions therefore stay distinct, and the same row
 * read twice collapses once.
 */
export function assembleRows(tiles: Tile[], reads: TileReadResult[], scrollsTowardTop: boolean): AssemblyResult {
  const readByTile = new Map(reads.map((r) => [r.tileIndex, r.rows]));
  const placed: Placed[] = [];
  let conflicts = 0;
  let unpositioned = 0;

  const allDiffs: number[] = [];
  for (const tile of tiles) {
    const rows = readByTile.get(tile.index) ?? [];
    const ys = rows.map((r) => (r.yTop === null ? null : r.yTop * tile.scale));
    for (let i = 1; i < ys.length; i++) {
      const a = ys[i - 1] ?? null;
      const b = ys[i] ?? null;
      if (a !== null && b !== null && b > a) allDiffs.push(b - a);
    }
  }
  const rowH = median(allDiffs) ?? 100;

  let prevTile: Tile | null = null;
  const byBandKey = new Map<string, Placed>();
  for (const tile of tiles) {
    const rows = readByTile.get(tile.index) ?? [];
    const ys = interpolatePositions(
      rows.map((r) => (r.yTop === null ? null : r.yTop * tile.scale)),
      tile.top,
      tile.bottom,
      rowH,
    );
    unpositioned += rows.filter((r) => r.yTop === null).length;

    if (tile.bands) {
      // Exact geometry: map the model's ordered rows onto detected bands and
      // dedupe by band. Same band read by two tiles → one row.
      for (const p of placeOnBands(rows, ys, tile)) {
        const existing = byBandKey.get(p.bandKey!);
        if (!existing) {
          byBandKey.set(p.bandKey!, p);
          placed.push(p);
          continue;
        }
        if (!compatible(existing.row, p.row)) conflicts++;
        if (quality(p.row) > quality(existing.row)) {
          existing.row = p.row;
          existing.tileIndex = p.tileIndex;
        }
      }
      prevTile = tile;
      continue;
    }

    const incoming: Placed[] = rows.map((row, i) => ({ row, y: ys[i]!, bottom: null, segmentIndex: tile.segmentIndex, tileIndex: tile.index, bandKey: null }));
    const sameSegment = prevTile !== null && prevTile.segmentIndex === tile.segmentIndex && prevTile.bands === null;
    if (!sameSegment) {
      placed.push(...incoming);
      prevTile = tile;
      continue;
    }

    // Fallback (no band structure): align the overlap as ordered sequences.
    const a = placed.filter((p) => p.segmentIndex === tile.segmentIndex && p.bandKey === null && p.y >= tile.top - 3 * rowH).sort((x, y) => x.y - y.y);
    const b = incoming.filter((p) => p.y <= prevTile!.bottom + 3 * rowH);
    const rest = incoming.filter((p) => p.y > prevTile!.bottom + 3 * rowH);

    const alignment = alignSequences(a, b, rowH);
    if (!alignment) {
      placed.push(...b, ...rest);
      prevTile = tile;
      continue;
    }
    conflicts += alignment.conflicts;
    const pairedB = new Set<Placed>();
    for (const [pa, pb] of alignment.pairs) {
      pairedB.add(pb);
      if (quality(pb.row) > quality(pa.row)) {
        pa.row = pb.row;
        pa.tileIndex = pb.tileIndex;
      }
    }
    for (const p of [...b.filter((x) => !pairedB.has(x)), ...rest]) {
      placed.push({ ...p, y: p.y + alignment.offset });
    }
    prevTile = tile;
  }

  // Display order: within a segment, by panorama y. Across segments, by the
  // direction the participant scrolled — later segments sit above earlier
  // ones if they were scrolling toward the top of the list.
  placed.sort((x, y) => {
    if (x.segmentIndex !== y.segmentIndex) {
      return scrollsTowardTop ? y.segmentIndex - x.segmentIndex : x.segmentIndex - y.segmentIndex;
    }
    return x.y - y.y;
  });

  // A tile whose row count didn't match its band count maps rows by
  // estimated position, and the same row can then land on the band next to
  // the one another tile put it on. Two adjacent rows from different tiles
  // that agree on everything *and* both carry a balance can't be distinct —
  // a real ledger would need a compensating movement between them.
  for (let i = placed.length - 2; i >= 0; i--) {
    const a = placed[i]!;
    const b = placed[i + 1]!;
    if (a.segmentIndex !== b.segmentIndex || a.tileIndex === b.tileIndex) continue;
    if (a.row.balanceAfter === null || b.row.balanceAfter === null) continue;
    if (!compatible(a.row, b.row) || !(a.row.timestamp && b.row.timestamp)) continue;
    if (quality(b.row) > quality(a.row)) {
      a.row = b.row;
      a.tileIndex = b.tileIndex;
    }
    placed.splice(i + 1, 1);
  }

  // Segments separated by a gap can still overlap in content — the recording
  // glitched or the participant scrolled back and the same rows were
  // captured twice. Fold each segment into what's been merged so far by
  // ordered content match; only its unmatched rows are new.
  const merged = mergeSegments(placed);
  conflicts += merged.conflicts;
  const ordered = merged.rows;

  const rows: AssembledRow[] = ordered.map((p, i) => {
    const next = ordered[i + 1];
    const bottom = p.bottom ?? (next && next.segmentIndex === p.segmentIndex && next.y > p.y ? next.y : p.y + rowH);
    return {
      timestamp: p.row.timestamp,
      type: p.row.type,
      description: p.row.description,
      amount: p.row.amount,
      balanceBefore: p.row.balanceBefore,
      balanceAfter: p.row.balanceAfter,
      confidence: p.row.confidence,
      partial: !p.row.fullyVisible,
      segmentIndex: p.segmentIndex,
      panoramaTop: p.y,
      panoramaBottom: bottom,
      tileIndex: p.tileIndex,
    };
  });

  return { rows, conflicts, unpositioned };
}

/**
 * Fold segments (already in display order) into one list. A segment whose
 * rows, in order, content-match a contiguous run of the list so far is the
 * same content seen again: pair the matches, keep only the rest. Needs at
 * least two matched rows so a single identical-looking transaction can't
 * glue two genuinely different stretches together.
 */
function mergeSegments(placed: Placed[]): { rows: Placed[]; conflicts: number } {
  const segmentOrder: number[] = [];
  for (const p of placed) if (!segmentOrder.includes(p.segmentIndex)) segmentOrder.push(p.segmentIndex);
  if (segmentOrder.length < 2) return { rows: placed, conflicts: 0 };

  let list = placed.filter((p) => p.segmentIndex === segmentOrder[0]);
  let conflicts = 0;
  for (const seg of segmentOrder.slice(1)) {
    const b = placed.filter((p) => p.segmentIndex === seg);
    let best: { o: number; pairs: number } | null = null;
    for (let o = -(b.length - 1); o < list.length; o++) {
      let pairs = 0;
      let informative = 0;
      let ok = true;
      for (let j = 0; j < b.length; j++) {
        const i = j + o;
        if (i < 0 || i >= list.length) continue;
        const pa = list[i]!.row;
        const pb = b[j]!.row;
        if (!compatible(pa, pb)) {
          ok = false;
          break;
        }
        pairs++;
        // Identity needs real content agreeing on both sides somewhere, not just nulls matching nulls.
        if ((pa.timestamp !== null && pb.timestamp !== null) || (pa.balanceAfter !== null && pb.balanceAfter !== null)) informative++;
      }
      if (ok && informative >= 2 && (!best || pairs > best.pairs)) best = { o, pairs };
    }
    if (!best) {
      list = [...list, ...b];
      continue;
    }
    const before: Placed[] = [];
    const after: Placed[] = [];
    for (let j = 0; j < b.length; j++) {
      const i = j + best.o;
      if (i < 0) before.push(b[j]!);
      else if (i >= list.length) after.push(b[j]!);
      else if (quality(b[j]!.row) > quality(list[i]!.row)) {
        list[i]!.row = b[j]!.row;
        list[i]!.tileIndex = b[j]!.tileIndex;
      }
    }
    list = [...before, ...list, ...after];
  }
  return { rows: list, conflicts };
}

/**
 * Map a tile's ordered model rows onto its detected bands. When the counts
 * match — the normal case — it's 1:1 in order and the model's position
 * estimate isn't needed at all. Otherwise (band detection merged two rows,
 * or split one) rows are assigned to the band nearest their estimated
 * position, monotonically, and rows sharing a band split it evenly.
 */
function placeOnBands(rows: RawExtractedRow[], ys: number[], tile: Tile): Placed[] {
  const bands = tile.bands!;
  if (rows.length === 0 || bands.length === 0) return [];
  const assignment: number[] = new Array(rows.length);
  if (rows.length === bands.length) {
    for (let i = 0; i < rows.length; i++) assignment[i] = i;
  } else {
    // Monotone assignment minimizing total distance from each row's estimated
    // position to its band (rows in order, bands non-decreasing, bands may be
    // skipped — e.g. a list header — or shared — e.g. two rows one band).
    const n = rows.length;
    const m = bands.length;
    const dist = (i: number, b: number) => {
      const y = ys[i]!;
      const band = bands[b]!;
      return y < band.outerTop ? band.outerTop - y : y > band.outerBottom ? y - band.outerBottom : 0;
    };
    const cost: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(Number.POSITIVE_INFINITY));
    const back: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));
    for (let b = 0; b < m; b++) cost[0]![b] = dist(0, b);
    for (let i = 1; i < n; i++) {
      let bestPrev = 0;
      for (let b = 0; b < m; b++) {
        if (cost[i - 1]![b]! < cost[i - 1]![bestPrev]!) bestPrev = b;
        cost[i]![b] = cost[i - 1]![bestPrev]! + dist(i, b);
        back[i]![b] = bestPrev;
      }
    }
    let b = 0;
    for (let k = 1; k < m; k++) if (cost[n - 1]![k]! < cost[n - 1]![b]!) b = k;
    for (let i = n - 1; i >= 0; i--) {
      assignment[i] = b;
      b = back[i]![b]!;
    }
  }

  const perBand = new Map<number, number[]>();
  assignment.forEach((b, i) => {
    if (!perBand.has(b)) perBand.set(b, []);
    perBand.get(b)!.push(i);
  });

  const out: Placed[] = [];
  for (const [b, idxs] of perBand) {
    const band = bands[b]!;
    const n = idxs.length;
    const h = (band.outerBottom - band.outerTop) / n;
    idxs.forEach((i, k) => {
      out.push({
        row: rows[i]!,
        y: band.outerTop + k * h,
        bottom: band.outerTop + (k + 1) * h,
        segmentIndex: tile.segmentIndex,
        tileIndex: tile.index,
        bandKey: `${tile.segmentIndex}:${tile.firstBandIndex + b}:${n === 1 ? 0 : k}`,
      });
    });
  }
  return out;
}

interface SequenceAlignment {
  pairs: Array<[Placed, Placed]>;
  /** Mean (placed.y − incoming.y) over the pairs: the new tile's registration error. */
  offset: number;
  conflicts: number;
}

/**
 * Best offset (in rows) between two ordered lists covering the same stretch
 * of panorama. Content and order carry the alignment: a clean offset is one
 * where every overlapping pair is content-compatible, and the clean offset
 * pairing the most rows wins. Position is only a sanity bound (three rows)
 * and a tie-breaker — ruler readings are quantized and the new tile's frame
 * can be registered a row off, which is exactly what this corrects. A
 * conflicting alignment is accepted only when no clean one exists.
 */
function alignSequences(a: Placed[], b: Placed[], rowH: number): SequenceAlignment | null {
  if (a.length === 0 || b.length === 0) return null;
  const maxDy = rowH * 3;
  let best: SequenceAlignment | null = null;
  let bestKey: [number, number, number] = [-1, -1, Number.POSITIVE_INFINITY];

  for (let o = -(b.length - 1); o < a.length; o++) {
    const pairs: Array<[Placed, Placed]> = [];
    let conflicts = 0;
    let dySum = 0;
    let ok = true;
    for (let j = 0; j < b.length; j++) {
      const i = j + o;
      if (i < 0 || i >= a.length) continue;
      const pa = a[i]!;
      const pb = b[j]!;
      if (Math.abs(pa.y - pb.y) > maxDy) {
        ok = false;
        break;
      }
      if (!compatible(pa.row, pb.row)) conflicts++;
      pairs.push([pa, pb]);
      dySum += pa.y - pb.y;
    }
    if (!ok || pairs.length === 0) continue;
    const meanDy = dySum / pairs.length;
    // Clean alignments (no conflicts) always beat conflicting ones; among
    // equals, more pairs, then smaller positional error.
    const key: [number, number, number] = [conflicts === 0 ? 1 : 0, pairs.length - 2 * conflicts, Math.abs(meanDy)];
    if (
      key[0] > bestKey[0] ||
      (key[0] === bestKey[0] && key[1] > bestKey[1]) ||
      (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] < bestKey[2])
    ) {
      bestKey = key;
      best = { pairs, offset: meanDy, conflicts };
    }
  }
  return best;
}

/** Fill null positions from neighbours (linear), or spread evenly across the tile if nothing is known. */
function interpolatePositions(ys: Array<number | null>, top: number, bottom: number, rowH: number): number[] {
  const out = ys.slice();
  const known = out.map((y, i) => (y === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) {
    const n = out.length;
    return out.map((_, i) => top + ((i + 0.5) / n) * (bottom - top));
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    const prev = [...known].reverse().find((k) => k < i);
    const next = known.find((k) => k > i);
    if (prev !== undefined && next !== undefined) {
      const t = (i - prev) / (next - prev);
      out[i] = out[prev]! + t * (out[next]! - out[prev]!);
    } else if (prev !== undefined) {
      out[i] = out[prev]! + (i - prev) * rowH;
    } else {
      out[i] = out[next!]! - (next! - i) * rowH;
    }
  }
  return out as number[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
