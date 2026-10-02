import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

/**
 * Scroll reconstruction (PRD §6.3 step 1, redesigned).
 *
 * A screen recording of a scrolling list is a panorama photographed one
 * viewport at a time. Rather than reading independent frames and trying to
 * dedupe rows by content afterwards — which both loses rows (frames dropped
 * as "near-duplicates" that actually showed different transactions) and
 * double-counts them (the same row re-read slightly differently) — we
 * recover the scroll offset between every consecutive frame, composite the
 * frames into one tall image of the whole list, and read *that*. Row
 * identity becomes position in the panorama, which is what it actually is.
 */

export interface DenseFrames {
  dir: string;
  files: string[];
  fps: number;
  width: number;
  height: number;
  cleanup: () => Promise<void>;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (c) => stderr.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`));
      else resolve();
    });
  });
}

/** Decode the video to JPEG frames at `fps`. Caller must `cleanup()`. */
export async function sampleDenseFrames(videoBuffer: Buffer, fps: number): Promise<DenseFrames> {
  const dir = await mkdtemp(join(tmpdir(), "betlab-pano-"));
  const inputPath = join(dir, "input.mp4");
  await writeFile(inputPath, videoBuffer);
  await runFfmpeg(["-y", "-i", inputPath, "-vf", `fps=${fps}`, "-q:v", "2", join(dir, "f_%05d.jpg")]);
  const files = (await readdir(dir)).filter((f) => f.startsWith("f_")).sort().map((f) => join(dir, f));
  if (files.length === 0) throw new Error("ffmpeg produced no frames");
  const meta = await sharp(files[0]!).metadata();
  return {
    dir,
    files,
    fps,
    width: meta.width!,
    height: meta.height!,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

async function loadGray(file: string, width: number): Promise<Gray> {
  const { data, info } = await sharp(file).resize({ width, kernel: "lanczos3" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/**
 * Which pixel rows scroll? Header/status bar/bottom nav stay put while the
 * list moves. Measured on *motion*: over the frame pairs where something
 * changed at all, a row that almost never changes is chrome. (Plain
 * temporal variance over the whole clip fails when a page transition or a
 * loading state changes the chrome once — then everything looks dynamic and
 * the static chrome dominates alignment, pinning every shift to zero.)
 * Returns [top, bottom) in the given frames' coordinates.
 */
export function detectScrollRegion(frames: Gray[], opts: { rowChangeThreshold?: number; staticFrac?: number } = {}): { top: number; bottom: number } {
  const rowChangeThreshold = opts.rowChangeThreshold ?? 4;
  const staticFrac = opts.staticFrac ?? 0.15;
  const { width, height } = frames[0]!;
  const changedCount = new Float64Array(height);
  let activePairs = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!.data;
    const b = frames[i]!.data;
    const rowDiff = new Float64Array(height);
    let total = 0;
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let x = 0; x < width; x++) acc += Math.abs(a[y * width + x]! - b[y * width + x]!);
      rowDiff[y] = acc / width;
      total += rowDiff[y]!;
    }
    if (total / height < 1.5) continue;
    activePairs++;
    for (let y = 0; y < height; y++) if (rowDiff[y]! > rowChangeThreshold) changedCount[y]!++;
  }
  // Too little motion to vote row by row (a three-frame flick): fall back to
  // whole-clip variance — any row that ever changed is part of the list.
  let scrollingRow: (y: number) => boolean;
  if (activePairs >= 3) {
    scrollingRow = (y) => changedCount[y]! / activePairs >= staticFrac;
  } else {
    const rowStd = new Float64Array(height);
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let sumSq = 0;
        for (const f of frames) {
          const v = f.data[y * width + x]!;
          sum += v;
          sumSq += v * v;
        }
        const mean = sum / frames.length;
        acc += Math.sqrt(Math.max(0, sumSq / frames.length - mean * mean));
      }
      rowStd[y] = acc / width;
    }
    scrollingRow = (y) => rowStd[y]! > 3;
  }

  let best = { top: 0, bottom: height, len: 0 };
  let runStart = -1;
  for (let y = 0; y <= height; y++) {
    const scrolling = y < height && scrollingRow(y);
    if (scrolling && runStart < 0) runStart = y;
    if (!scrolling && runStart >= 0) {
      if (y - runStart > best.len) best = { top: runStart, bottom: y, len: y - runStart };
      runStart = -1;
    }
  }
  if (best.len === 0) return { top: 0, bottom: height };
  return { top: best.top, bottom: best.bottom };
}

/**
 * Difference between A shifted and B over their overlap, where A[y] is
 * compared to B[y + shift]. Lower is better. With `inkOnly`, only pixels
 * where either image has ink count — on a list UI the background is 90%+
 * of the area and averaging over it drowns out the digits that distinguish
 * one near-identical row from the next.
 */
function overlapDiff(a: Gray, b: Gray, shift: number, minOverlap: number, inkOnly: boolean): number | null {
  const { width, height } = a;
  const yStart = Math.max(0, -shift);
  const yEnd = Math.min(height, height - shift);
  if (yEnd - yStart < minOverlap) return null;
  let acc = 0;
  let count = 0;
  const INK = 160;
  for (let y = yStart; y < yEnd; y++) {
    const rowA = y * width;
    const rowB = (y + shift) * width;
    for (let x = 0; x < width; x++) {
      const va = a.data[rowA + x]!;
      const vb = b.data[rowB + x]!;
      if (inkOnly && va > INK && vb > INK) continue;
      acc += Math.abs(va - vb);
      count++;
    }
  }
  if (count === 0) return null;
  return acc / count;
}

export interface ShiftCandidate {
  /** Pixels (in the fine frames' coordinates) that content moved down between A and B. */
  shift: number;
  /** Ink-weighted mean abs diff over the overlap; lower is better. */
  score: number;
}

/**
 * Candidate vertical shifts between two consecutive frames of the scroll
 * region. Lists of near-identical rows alias at multiples of the row height
 * (only a few digits differ), so a single global minimum isn't trustworthy —
 * and a motion-blurred frame can't even rank the true shift above an alias.
 * So this returns every plausible candidate (local minima of a coarse
 * search, each refined at full resolution with ink-weighted scoring),
 * best first; `planReconstruction` decides which frames to trust.
 */
export function shiftCandidates(
  coarseA: Gray,
  coarseB: Gray,
  fineA: Gray,
  fineB: Gray,
  opts: { minOverlapFrac?: number; maxCandidates?: number } = {},
): ShiftCandidate[] {
  const minOverlapFrac = opts.minOverlapFrac ?? 0.2;
  const maxCandidates = opts.maxCandidates ?? 8;

  const hc = coarseA.height;
  const minOverlapC = Math.max(4, Math.floor(hc * minOverlapFrac));
  const range = hc - minOverlapC;
  const scores = new Map<number, number>();
  for (let s = -range; s <= range; s++) {
    const d = overlapDiff(coarseA, coarseB, s, minOverlapC, false);
    if (d !== null) scores.set(s, d);
  }
  const localMinima: number[] = [];
  for (const [s, d] of scores) {
    const l = scores.get(s - 1) ?? Number.POSITIVE_INFINITY;
    const r = scores.get(s + 1) ?? Number.POSITIVE_INFINITY;
    if (d <= l && d <= r) localMinima.push(s);
  }
  localMinima.sort((x, y) => scores.get(x)! - scores.get(y)!);
  const scale = fineA.height / hc;
  const centers = new Set<number>(localMinima.slice(0, maxCandidates).map((s) => Math.round(s * scale)));
  centers.add(0);

  const hf = fineA.height;
  const window = Math.ceil(scale) + 2;
  const minOverlapF = Math.max(8, Math.floor(hf * minOverlapFrac));
  const out: ShiftCandidate[] = [];
  for (const center of centers) {
    let best: ShiftCandidate | null = null;
    for (let s = center - window; s <= center + window; s++) {
      const d = overlapDiff(fineA, fineB, s, minOverlapF, true);
      if (d === null) continue;
      if (!best || d < best.score) best = { shift: s, score: d };
    }
    if (best && !out.some((c) => c.shift === best!.shift)) out.push(best);
  }
  return out.sort((x, y) => x.score - y.score);
}

export interface FramePlacement {
  frameIndex: number;
  timestampSeconds: number;
  /** Panorama y (full-res px) of this frame's scroll-region top. */
  top: number;
  /** Ink-weighted diff against the frame it was placed from; lower is a cleaner frame. 0 for a segment's first frame. */
  alignScore: number;
}

export interface Segment {
  placements: FramePlacement[];
  /** Panorama canvas height, full-res px. */
  height: number;
}

export interface ScrollGap {
  timestampSeconds: number;
  score: number;
}

export interface ReconstructionPlan {
  scrollRegion: { top: number; bottom: number };
  segments: Segment[];
  gaps: ScrollGap[];
  /** Frames the path skipped (heavy compression, partial re-render): tracked for position, never composited. */
  rejectedFrames: number[];
  /** This recording's noise floor and the thresholds derived from it. */
  calibration: { noiseFloor: number; scale: number; thresholds: Thresholds };
}

const COARSE_WIDTH = 64;
/**
 * The fine level must not resample by a non-integer factor: small text
 * resized by e.g. 0.72 lands on a different sub-pixel phase in every frame,
 * and identical content stops matching (the true shift scored 5× worse than
 * an alias on a 444px recording resized to 320). Full resolution up to this
 * width; an integer divisor above it.
 */
const FINE_MAX_WIDTH = 640;

/** Align every consecutive frame pair and place each frame on a panorama canvas. */
export async function planReconstruction(
  frames: DenseFrames,
  onAlign?: (info: AlignDebug) => void,
): Promise<ReconstructionPlan> {
  const coarseFull = await Promise.all(frames.files.map((f) => loadGray(f, COARSE_WIDTH)));
  const regionC = detectScrollRegion(coarseFull);
  const cScale = frames.width / COARSE_WIDTH;
  const scrollRegion = {
    top: Math.min(frames.height - 1, Math.ceil(regionC.top * cScale) + 2),
    bottom: Math.max(1, Math.floor(regionC.bottom * cScale) - 2),
  };
  if (scrollRegion.bottom - scrollRegion.top < 32) {
    scrollRegion.top = 0;
    scrollRegion.bottom = frames.height;
  }

  const fineDivisor = Math.ceil(frames.width / FINE_MAX_WIDTH);
  const fineWidth = Math.floor(frames.width / fineDivisor);
  const cropGray = async (file: string, width: number): Promise<Gray> => {
    let pipeline = sharp(file).extract({ left: 0, top: scrollRegion.top, width: frames.width, height: scrollRegion.bottom - scrollRegion.top });
    if (width !== frames.width) pipeline = pipeline.resize({ width, kernel: "lanczos3" });
    const { data, info } = await pipeline.grayscale().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
  };

  const fineScale = frames.width / fineWidth;
  const coarse: Gray[] = [];
  const fine: Gray[] = [];
  for (const f of frames.files) {
    coarse.push(await cropGray(f, COARSE_WIDTH));
    fine.push(await cropGray(f, fineWidth));
  }

  // Shortest path over frames. An edge j→i (i−j ≤ MAX_SKIP) costs the
  // alignment score of that pair plus a velocity-change penalty and a small
  // charge per skipped frame. Frames on the path are trusted (composited);
  // frames the path skips — heavy compression on a motion frame, a partial
  // re-render — are placed tentatively for position only. Consecutive edges
  // win when every frame is mildly blurry (a flick: skipping doesn't help);
  // skip edges win when a bad frame sits between two clean ones.
  const n = frames.files.length;
  const H = fine[0]!.height;
  const rawEdgeCache = new Map<string, ShiftCandidate[]>();
  const rawEdge = (j: number, i: number): ShiftCandidate[] => {
    const key = `${j}:${i}`;
    let c = rawEdgeCache.get(key);
    if (!c) {
      c = shiftCandidates(coarse[j]!, coarse[i]!, fine[j]!, fine[i]!);
      rawEdgeCache.set(key, c);
    }
    return c;
  };

  // Calibrate the score thresholds to this recording (docs/extraction-hardening.md
  // §6). The best consecutive-pair scores' lower quantile is the noise floor —
  // what "identical" frames differ by here, given this recording's compression
  // and text size. Thresholds tuned on clean recordings scale up with it.
  // Only pairs that didn't move measure noise; a clip scrolled continuously
  // has few of them, so fall back to the cleanest pairs overall.
  const staticScores: number[] = [];
  const allBest: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = rawEdge(i - 1, i)[0];
    if (!c) continue;
    allBest.push(c.score);
    if (Math.abs(c.shift) <= 1) staticScores.push(c.score);
  }
  const pool = staticScores.length >= 5 ? staticScores : allBest;
  pool.sort((a, b) => a - b);
  const noiseFloor = pool.length ? pool[Math.floor(pool.length / 2)]! : 0;
  const scale = Math.max(1, noiseFloor / REFERENCE_NOISE_FLOOR);
  const thresholds: Thresholds = { good: GOOD_SCORE * scale, maxPair: MAX_PAIR_SCORE * scale, cleanSource: CLEAN_SOURCE_SCORE * scale };
  const calibration = { noiseFloor, scale, thresholds };

  const edge = (j: number, i: number): ShiftCandidate[] => rawEdge(j, i).filter((x) => x.score <= thresholds.maxPair);

  interface State {
    cost: number;
    from: number;
    fromState: number;
    /** Fine px per frame along the incoming edge. */
    velocity: number;
    shift: number;
    score: number;
  }
  const root = (): State => ({ cost: 0, from: -1, fromState: -1, velocity: 0, shift: 0, score: 0 });
  const states: State[][] = Array.from({ length: n }, () => []);
  states[0] = [root()];
  const segmentRoot: number[] = new Array(n).fill(0);

  let lastPoorEdge = -Infinity;
  for (let i = 1; i < n; i++) {
    const consecutive = edge(i - 1, i);
    // Skip edges are only worth computing near a poor consecutive edge —
    // including the few frames *after* one, so the path can route around
    // a bad frame that its successor happens to align to cleanly.
    if (!(consecutive.length > 0 && consecutive[0]!.score <= thresholds.good)) lastPoorEdge = i;
    const maxBack = i - lastPoorEdge <= MAX_SKIP ? MAX_SKIP : 1;
    for (let j = i - 1; j >= Math.max(0, i - maxBack); j--) {
      if (states[j]!.length === 0 || segmentRoot[j] !== segmentRoot[i - 1]) continue;
      for (const cand of edge(j, i)) {
        const v = cand.shift / (i - j);
        let best: State | null = null;
        for (let sj = 0; sj < states[j]!.length; sj++) {
          const prev = states[j]![sj]!;
          // An edge spanning m frames is charged m× its score, so skipping
          // frames only pays when the jump is genuinely cleaner than the
          // frames it skips — not merely because it's fewer edges.
          const cost = prev.cost + cand.score * (i - j) + VELOCITY_WEIGHT * (Math.abs(v - prev.velocity) / H) + SKIP_PENALTY * (i - j - 1);
          if (!best || cost < best.cost) best = { cost, from: j, fromState: sj, velocity: v, shift: cand.shift, score: cand.score };
        }
        if (best) states[i]!.push(best);
      }
    }
    if (states[i]!.length === 0) {
      // Unreachable from anything within range: a scene change, or a flick
      // past a whole screen. New segment.
      states[i] = [root()];
      segmentRoot[i] = i;
    } else {
      states[i]!.sort((a, b) => a.cost - b.cost);
      states[i] = states[i]!.slice(0, MAX_STATES);
      segmentRoot[i] = segmentRoot[i - 1]!;
    }
  }

  // Backtrack each segment from its last frame; frames off the path are tentative.
  const segments: Segment[] = [];
  const gaps: ScrollGap[] = [];
  const rejected: number[] = [];
  const mk = (i: number, top: number, alignScore: number): FramePlacement => ({ frameIndex: i, timestampSeconds: i / frames.fps, top, alignScore });

  let segStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && segmentRoot[i] === segStart) continue;
    const segEnd = i - 1;
    const top = new Map<number, number>();
    const scoreOf = new Map<number, number>();
    const edgeFrom = new Map<number, { from: number; shift: number }>();
    let f = segEnd;
    let st = states[segEnd]![0]!;
    top.set(f, 0);
    scoreOf.set(f, st.score);
    while (st.from >= 0) {
      // Content moved down by `shift` from predecessor to f ⇒ predecessor sits lower.
      const prevTop = top.get(f)! + Math.round(st.shift * fineScale);
      edgeFrom.set(f, { from: st.from, shift: st.shift });
      f = st.from;
      st = states[f]![st.fromState]!;
      top.set(f, prevTop);
      scoreOf.set(f, st.score);
    }
    const placements: FramePlacement[] = [];
    for (let k = segStart; k <= segEnd; k++) {
      if (top.has(k)) {
        placements.push(mk(k, top.get(k)!, scoreOf.get(k)!));
        const e = edgeFrom.get(k);
        if (e) onAlign?.({ frameIndex: k, timestampSeconds: k / frames.fps, shift: e.shift, score: scoreOf.get(k)!, ref: e.from, onPath: true });
        continue;
      }
      // Tentative: relative to the nearest earlier frame on the path.
      let ref = k - 1;
      while (ref > segStart && !top.has(ref)) ref--;
      const cand = edge(ref, k)[0];
      rejected.push(k);
      placements.push(mk(k, cand ? top.get(ref)! - Math.round(cand.shift * fineScale) : top.get(ref)!, Number.POSITIVE_INFINITY));
      onAlign?.({ frameIndex: k, timestampSeconds: k / frames.fps, shift: cand?.shift ?? 0, score: cand?.score ?? Number.POSITIVE_INFINITY, ref, onPath: false });
    }
    segments.push(finishSegment(placements, scrollRegion));
    if (i < n) {
      gaps.push({ timestampSeconds: i / frames.fps, score: Number.POSITIVE_INFINITY });
      segStart = i;
    }
  }
  return { scrollRegion, segments, gaps, rejectedFrames: rejected, calibration };
}

export interface Thresholds {
  good: number;
  maxPair: number;
  cleanSource: number;
}

/** Noise floor (ink-weighted diff of near-identical consecutive frames) on a clean iOS recording. */
const REFERENCE_NOISE_FLOOR = 3;
/** A pair aligning at or under this ink-weighted diff is clean enough that skip edges aren't worth computing. */
const GOOD_SCORE = 20;
/** Ink-weighted diff above this means the two frames don't overlap at all (scene change, or a flick past a whole screen). */
const MAX_PAIR_SCORE = 65;
/** How many frames an edge may span (skipping the ones between). */
const MAX_SKIP = 4;
/** Cost of a velocity change of one full viewport height per frame. */
const VELOCITY_WEIGHT = 40;
/** Cost per skipped frame — skipping must buy a clearly better alignment. */
const SKIP_PENALTY = 6;
const MAX_STATES = 6;

export interface AlignDebug {
  frameIndex: number;
  timestampSeconds: number;
  shift: number;
  score: number;
  /** The frame this one was placed from. */
  ref: number;
  /** Whether the frame is on the trusted path (composited) or only tentatively placed. */
  onPath: boolean;
}

/** Rejected (untrusted) frames are tracked for position but never define the canvas or supply pixels. */
export function isTrusted(p: FramePlacement): boolean {
  return Number.isFinite(p.alignScore);
}

function finishSegment(placements: FramePlacement[], region: { top: number; bottom: number }): Segment {
  const regionH = region.bottom - region.top;
  const trusted = placements.filter(isTrusted);
  const minTop = Math.min(...trusted.map((p) => p.top));
  const shifted = placements.map((p) => ({ ...p, top: p.top - minTop }));
  const height = Math.max(...shifted.filter(isTrusted).map((p) => p.top)) + regionH;
  return { placements: shifted, height };
}

export interface PanoramaImage {
  /** PNG, full source resolution, width = scroll-region width. */
  png: Buffer;
  width: number;
  height: number;
  segment: Segment;
}

/**
 * Composite a segment's frames into one tall image. Each panorama row is
 * taken from a sharp frame in which it's far from the viewport edge —
 * motion-blurred frames are unreadable, and edges are where partially
 * rendered rows and scroll-bounce artifacts live.
 */
export async function compositeSegment(frames: DenseFrames, plan: ReconstructionPlan, segment: Segment): Promise<PanoramaImage> {
  const regionTop = plan.scrollRegion.top;
  const regionH = plan.scrollRegion.bottom - regionTop;
  const width = frames.width;
  const height = segment.height;

  // For each panorama row, a few trusted frames covering it, and the pixels
  // are the per-channel median across them. Anything that isn't the list
  // itself — an app's floating button, the iOS scroll indicator, a
  // compression smear — sits at a fixed *screen* position or in a few
  // frames only, so it lands on a given row only while that row is at that
  // screen height. Choosing frames where the row sat at *different* screen
  // heights (far from the viewport edge, clean alignment) makes such
  // artifacts a minority the median discards. Five copies of one static
  // pause would not.
  const trusted = segment.placements.filter(isTrusted);
  const candidatesByRow: number[][] = new Array(height);
  const minSpread = Math.max(8, Math.round(regionH * 0.1));
  for (let y = 0; y < height; y++) {
    const covering: Array<{ pi: number; dist: number; score: number }> = [];
    for (let pi = 0; pi < trusted.length; pi++) {
      const p = trusted[pi]!;
      const fy = y - p.top;
      if (fy < 0 || fy >= regionH) continue;
      covering.push({ pi, dist: Math.min(fy, regionH - 1 - fy), score: p.alignScore });
    }
    const clean = covering.filter((c) => c.score <= plan.calibration.thresholds.cleanSource);
    const pool = clean.length >= 3 ? clean : covering;
    pool.sort((a, b) => b.dist - a.dist || a.score - b.score);
    const picked: typeof pool = [];
    for (const c of pool) {
      if (picked.length >= MEDIAN_FRAMES) break;
      if (picked.some((q) => Math.abs(trusted[q.pi]!.top - trusted[c.pi]!.top) < minSpread)) continue;
      picked.push(c);
    }
    // Not enough distinct positions (a short pause is all there is): fill up regardless.
    for (const c of pool) {
      if (picked.length >= MEDIAN_FRAMES) break;
      if (!picked.includes(c)) picked.push(c);
    }
    candidatesByRow[y] = picked.map((c) => c.pi);
  }

  const cache = new Map<number, Buffer>();
  const loadRegion = async (frameIndex: number): Promise<Buffer> => {
    let buf = cache.get(frameIndex);
    if (!buf) {
      buf = await sharp(frames.files[frameIndex]!).extract({ left: 0, top: regionTop, width, height: regionH }).removeAlpha().raw().toBuffer();
      cache.set(frameIndex, buf);
      if (cache.size > FRAME_CACHE) cache.delete(cache.keys().next().value!);
    }
    return buf;
  };

  const out = Buffer.alloc(width * height * 3, 255);
  const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const scratch = new Uint8Array(MEDIAN_FRAMES);
  let runStart = 0;
  for (let y = 1; y <= height; y++) {
    if (y < height && sameSet(candidatesByRow[y]!, candidatesByRow[runStart]!)) continue;
    const cands = candidatesByRow[runStart]!;
    if (cands.length > 0) {
      const sources = await Promise.all(cands.map((pi) => loadRegion(trusted[pi]!.frameIndex)));
      const tops = cands.map((pi) => trusted[pi]!.top);
      const n = sources.length;
      for (let py = runStart; py < y; py++) {
        const outRow = py * width * 3;
        for (let x = 0; x < width * 3; x++) {
          for (let k = 0; k < n; k++) scratch[k] = sources[k]![(py - tops[k]!) * width * 3 + x]!;
          out[outRow + x] = medianOf(scratch, n);
        }
      }
    }
    runStart = y;
  }

  const png = await sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return { png, width, height, segment };
}

/** Frames per row that vote in the median composite. Odd, so there's a true median. */
const MEDIAN_FRAMES = 5;
/** Alignment score under which a frame is a preferred pixel source. */
const CLEAN_SOURCE_SCORE = 25;
const FRAME_CACHE = 64;

function medianOf(values: Uint8Array, n: number): number {
  if (n === 1) return values[0]!;
  // Tiny n: insertion sort in place.
  for (let i = 1; i < n; i++) {
    const v = values[i]!;
    let j = i - 1;
    while (j >= 0 && values[j]! > v) {
      values[j + 1] = values[j]!;
      j--;
    }
    values[j + 1] = v;
  }
  return n % 2 === 1 ? values[(n - 1) / 2]! : Math.round((values[n / 2 - 1]! + values[n / 2]!) / 2);
}

export interface RowBand {
  /** Ink extent of the row, full-res panorama px. */
  top: number;
  bottom: number;
  /** Extent including half of the whitespace on either side — what a highlight should cover. */
  outerTop: number;
  outerBottom: number;
}

/**
 * Where are the rows? List UIs separate rows with more whitespace than
 * they put between the lines *inside* a row, so the heights of blank
 * horizontal bands fall into two clusters. A 2-means split on gap height
 * picks the row separators; everything between two separators is a row.
 * Positions from this are exact, which is what makes cross-tile merging
 * and click-to-highlight geometry rather than guesswork. Returns [] when
 * the image has no usable whitespace structure (dense table, no gaps).
 */
export async function detectRowBands(png: Buffer): Promise<RowBand[]> {
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const INK = 170;
  const BLANK_FRAC = 0.01;
  // Ignore the outer margins: scrollbar indicators, iOS scroll chevrons and
  // edge artifacts live there and would otherwise make a separator gap look
  // inked. Real rows always have ink well inside the margins.
  const x0 = Math.round(W * 0.1);
  const x1 = Math.round(W * 0.9);
  const blank = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    const row = y * W;
    for (let x = x0; x < x1; x++) if (data[row + x]! < INK) c++;
    blank[y] = c / (x1 - x0) < BLANK_FRAC ? 1 : 0;
  }
  const gaps: Array<{ top: number; bottom: number }> = [];
  let run = -1;
  for (let y = 0; y <= H; y++) {
    const b = y < H && blank[y] === 1;
    if (b && run < 0) run = y;
    if (!b && run >= 0) {
      gaps.push({ top: run, bottom: y });
      run = -1;
    }
  }
  // Interior gaps only — the panorama's own top/bottom margins aren't separators.
  const interior = gaps.filter((g) => g.top > 0 && g.bottom < H);
  if (interior.length < 2) return [];

  const heights = interior.map((g) => g.bottom - g.top);
  const threshold = otsuThreshold(heights);
  const separators = threshold === null ? interior : interior.filter((g) => g.bottom - g.top >= threshold);
  if (separators.length === 0) return [];

  const bands: RowBand[] = [];
  let prevGap = { top: 0, bottom: 0 };
  for (const gap of [...separators, { top: H, bottom: H }]) {
    const top = prevGap.bottom;
    const bottom = gap.top;
    if (bottom - top >= 8) {
      bands.push({
        top,
        bottom,
        outerTop: Math.round((prevGap.top + prevGap.bottom) / 2),
        outerBottom: Math.round((gap.top + gap.bottom) / 2),
      });
    }
    prevGap = gap;
  }
  return bands;
}

/**
 * Split point between two clusters of gap heights (Otsu: maximize
 * between-class variance), or null if the heights don't separate — a
 * single cluster means every gap is a row separator.
 */
function otsuThreshold(values: number[]): number | null {
  const max = Math.max(...values);
  const hist = new Float64Array(max + 1);
  for (const v of values) hist[v] = (hist[v] ?? 0) + 1;
  const total = values.length;
  let sumAll = 0;
  for (let v = 0; v <= max; v++) sumAll += v * hist[v]!;
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let threshold: number | null = null;
  let meanLo = 0;
  let meanHi = 0;
  for (let t = 0; t < max; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t + 1;
      meanLo = mB;
      meanHi = mF;
    }
  }
  if (threshold === null || meanHi / Math.max(meanLo, 1) < 1.8) return null;
  return threshold;
}

export interface Tile {
  index: number;
  segmentIndex: number;
  jpegBuffer: Buffer;
  /** Panorama y-range (full-res px) this tile shows, excluding the ruler margin. */
  top: number;
  bottom: number;
  /** Multiply a ruler label by this to get full-res panorama px. */
  scale: number;
  /** Ruler labels are in resized-panorama px; label y = (panoramaY / scale). */
  rulerTickEvery: number;
  /**
   * Row bands this tile contains (absolute panorama px), in order, when the
   * tile was cut on band boundaries. Null for fixed-height fallback tiles.
   */
  bands: RowBand[] | null;
  /** Index into the segment's band list of `bands[0]`. */
  firstBandIndex: number;
}

export interface TilingOptions {
  /** Target width the panorama is resized to before tiling (readability vs tokens). */
  targetWidth?: number;
  tileHeight?: number;
  overlap?: number;
  rulerWidth?: number;
  /** Detected row bands; tiles are cut on band boundaries when given. */
  bands?: RowBand[];
  overlapBands?: number;
}

/**
 * Cut a panorama into overlapping tiles the model can read. Every row is
 * fully visible in at least one tile (overlap ≥ a few row heights), and each
 * tile carries a pixel ruler in the left margin so the model can *read* a
 * row's position off a label instead of estimating coordinates — VLMs read
 * labels far more reliably than they localize.
 */
export async function tilePanorama(pano: PanoramaImage, segmentIndex: number, startIndex: number, opts: TilingOptions = {}): Promise<Tile[]> {
  const geo = tileGeometry(pano, opts);
  const tileHeight = opts.tileHeight ?? 1400;
  const overlap = opts.overlap ?? 320;
  const overlapBands = opts.overlapBands ?? 2;

  // Tile ranges in resized px, plus the bands each covers.
  const ranges: Array<{ y: number; h: number; bands: RowBand[] | null; firstBandIndex: number }> = [];
  const bands = opts.bands && opts.bands.length >= 3 ? opts.bands : null;
  if (bands) {
    let first = 0;
    while (first < bands.length) {
      const startY = Math.round(bands[first]!.outerTop / geo.scale);
      let last = first;
      while (last + 1 < bands.length && Math.round(bands[last + 1]!.outerBottom / geo.scale) - startY <= tileHeight) last++;
      const endY = Math.min(geo.resizedH, Math.round(bands[last]!.outerBottom / geo.scale));
      ranges.push({ y: startY, h: endY - startY, bands: bands.slice(first, last + 1), firstBandIndex: first });
      if (last >= bands.length - 1) break;
      first = Math.max(first + 1, last - overlapBands + 1);
    }
  } else {
    let y = 0;
    while (true) {
      const h = Math.min(tileHeight, geo.resizedH - y);
      ranges.push({ y, h, bands: null, firstBandIndex: 0 });
      if (y + h >= geo.resizedH) break;
      y = y + tileHeight - overlap;
    }
  }

  const tiles: Tile[] = [];
  let index = startIndex;
  for (const r of ranges) tiles.push(await renderTile(geo, r, index++, segmentIndex, opts));
  return tiles;
}

/**
 * One tile over a specific band range — used to re-read the rows around a
 * chain break with a band of context on each side, so the model sees them
 * in a different framing than the first time (docs/extraction-hardening.md §2).
 */
export async function cutBandTile(
  pano: PanoramaImage,
  bands: RowBand[],
  firstBand: number,
  lastBand: number,
  segmentIndex: number,
  index: number,
  opts: TilingOptions = {},
): Promise<Tile> {
  const geo = tileGeometry(pano, opts);
  const first = Math.max(0, firstBand);
  const last = Math.min(bands.length - 1, lastBand);
  const startY = Math.round(bands[first]!.outerTop / geo.scale);
  const endY = Math.min(geo.resizedH, Math.round(bands[last]!.outerBottom / geo.scale));
  return renderTile(geo, { y: startY, h: endY - startY, bands: bands.slice(first, last + 1), firstBandIndex: first }, index, segmentIndex, opts);
}

interface TileGeometry {
  resized: Promise<Buffer>;
  targetWidth: number;
  resizedH: number;
  scale: number;
}

function tileGeometry(pano: PanoramaImage, opts: TilingOptions): TileGeometry {
  const targetWidth = Math.min(opts.targetWidth ?? 600, pano.width);
  const scale = pano.width / targetWidth;
  const resizedH = Math.round(pano.height / scale);
  const resized = sharp(pano.png).resize({ width: targetWidth, height: resizedH, fit: "fill" }).png().toBuffer();
  return { resized, targetWidth, resizedH, scale };
}

async function renderTile(
  geo: TileGeometry,
  r: { y: number; h: number; bands: RowBand[] | null; firstBandIndex: number },
  index: number,
  segmentIndex: number,
  opts: TilingOptions,
): Promise<Tile> {
  const rulerWidth = opts.rulerWidth ?? 48;
  const tickEvery = 50;
  const resized = await geo.resized;
  const body = await sharp(resized).extract({ left: 0, top: r.y, width: geo.targetWidth, height: r.h }).png().toBuffer();
  const ruler = rulerSvg(rulerWidth, r.h, r.y, tickEvery);
  const jpegBuffer = await sharp({ create: { width: geo.targetWidth + rulerWidth, height: r.h, channels: 3, background: { r: 235, g: 235, b: 235 } } })
    .composite([
      { input: Buffer.from(ruler), left: 0, top: 0 },
      { input: body, left: rulerWidth, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
  return {
    index,
    segmentIndex,
    jpegBuffer,
    top: Math.round(r.y * geo.scale),
    bottom: Math.round((r.y + r.h) * geo.scale),
    scale: geo.scale,
    rulerTickEvery: tickEvery,
    bands: r.bands,
    firstBandIndex: r.firstBandIndex,
  };
}

function rulerSvg(width: number, height: number, yOffset: number, tickEvery: number): string {
  const first = Math.ceil(yOffset / tickEvery) * tickEvery;
  const parts: string[] = [`<rect x="0" y="0" width="${width}" height="${height}" fill="#ebebeb"/>`];
  for (let ty = first; ty < yOffset + height; ty += tickEvery) {
    const localY = ty - yOffset;
    const major = ty % 100 === 0;
    parts.push(`<line x1="${width - (major ? 12 : 6)}" y1="${localY}" x2="${width}" y2="${localY}" stroke="#333" stroke-width="1"/>`);
    parts.push(`<text x="1" y="${localY + 4}" font-family="monospace" font-size="${major ? 11 : 9}" fill="${major ? "#111" : "#555"}">${ty}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

/** Maps a panorama y-range back to the frame that shows it most centrally. */
export function locateInFrames(
  segment: Segment,
  regionH: number,
  top: number,
  bottom: number,
): { placement: FramePlacement; yInRegion: number } | null {
  const center = (top + bottom) / 2;
  let best: FramePlacement | null = null;
  let bestDist = -1;
  for (const p of segment.placements) {
    if (center < p.top || center >= p.top + regionH) continue;
    const dist = Math.min(center - p.top, p.top + regionH - center) + (isTrusted(p) ? regionH : 0);
    if (dist > bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  if (!best) return null;
  return { placement: best, yInRegion: top - best.top };
}
