import type { ReconstructionPlan, RowBand } from "./panorama.js";

export type QualityVerdict = "ok" | "warn" | "reject";

export interface RecordingQuality {
  verdict: QualityVerdict;
  reasons: string[];
  /** The numbers behind the verdict, for the console and for tuning. */
  metrics: {
    durationSeconds: number;
    frameCount: number;
    untrustedFrames: number;
    segments: number;
    gaps: number;
    rowBands: number;
    /** Ink-diff of near-identical consecutive frames — higher means a noisier (re-encoded) recording. */
    noiseFloor: number;
  };
}

/**
 * Judge a recording from reconstruction alone, before any model call
 * (docs/extraction-hardening.md §4): a runner should learn in seconds that
 * a clip scrolled too fast or doesn't show a list, not after review.
 */
export function assessRecording(
  plan: ReconstructionPlan,
  bandsPerSegment: RowBand[][],
  frames: { count: number; fps: number },
): RecordingQuality {
  const reasons: string[] = [];
  let verdict: QualityVerdict = "ok";
  const warn = (r: string) => {
    reasons.push(r);
    if (verdict === "ok") verdict = "warn";
  };
  const reject = (r: string) => {
    reasons.push(r);
    verdict = "reject";
  };

  const durationSeconds = frames.count / frames.fps;
  const rowBands = bandsPerSegment.reduce((a, b) => a + b.length, 0);
  const listSegments = bandsPerSegment.filter((b) => b.length >= 2).length;
  const untrusted = plan.rejectedFrames.length;

  if (listSegments === 0) reject("no scrolling list with at least two rows was found — is this a transaction history?");
  if (durationSeconds < 3) warn(`very short recording (${durationSeconds.toFixed(1)}s)`);

  // Gaps going in and out of a loading screen a few frames apart are one event.
  const gapTimes = plan.gaps.map((g) => g.timestampSeconds).filter((t, i, arr) => i === 0 || t - arr[i - 1]! > 1);
  if (gapTimes.length > 0) {
    const where = gapTimes.map((t) => `${t.toFixed(1)}s`).join(", ");
    if (gapTimes.length > 3) reject(`the view jumped ${gapTimes.length} times (${where}) — scroll slowly in one direction without switching pages`);
    else warn(`the view jumped at ${where} (scrolled past a whole screen, or changed page) — rows in between may be missing`);
  }

  if (frames.count > 0 && untrusted / frames.count > 0.25) {
    warn(`${Math.round((100 * untrusted) / frames.count)}% of frames were too degraded to use (heavy compression or re-encoding) — send the original file`);
  }

  return {
    verdict,
    reasons,
    metrics: { durationSeconds, frameCount: frames.count, untrustedFrames: untrusted, segments: plan.segments.length, gaps: gapTimes.length, rowBands, noiseFloor: plan.calibration.noiseFloor },
  };
}
