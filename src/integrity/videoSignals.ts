import type { VideoFormatInfo } from "../extraction/ffmpeg.js";

export interface IntegritySignal {
  code: string;
  severity: "info" | "warning" | "high";
  detail: string;
}

// Heuristic, not exhaustive — a native OS screen recorder's container
// metadata looks nothing like these; a message-app transcoder's does. False
// negatives are expected as new apps/versions appear (annotation, not verdict).
const REENCODE_SIGNATURES = ["whatsapp", "lavf", "libx264", "handbrake"];

/**
 * PRD §7 ENCODER_MISMATCH. Per §6.1's provenance dependency, callers must
 * only run this for channel="dropbox" submissions — anything that could
 * have passed through a messaging app's transcoder is expected to fail it
 * and must be suppressed rather than flagged.
 */
export function checkEncoderMismatch(format: VideoFormatInfo): IntegritySignal | null {
  const encoder = format.encoder?.toLowerCase() ?? "";
  const matched = REENCODE_SIGNATURES.find((sig) => encoder.includes(sig));
  if (!matched) return null;
  return {
    code: "ENCODER_MISMATCH",
    severity: "warning",
    detail: `Container encoder tag "${format.encoder}" matches a known re-encode signature ("${matched}"), not a native screen recorder`,
  };
}

const OUTLIER_RATIO = 3;

/**
 * PRD §7 FRAME_DISCONTINUITY. A spliced-in segment tends to introduce an
 * extra keyframe outside the source encoder's normal GOP cadence, so an
 * interval far from the median is the signal — not proof, an annotation.
 */
export function checkFrameDiscontinuity(keyframeTimes: number[]): IntegritySignal | null {
  if (keyframeTimes.length < 3) return null;

  const intervals: number[] = [];
  for (let i = 1; i < keyframeTimes.length; i++) {
    intervals.push(keyframeTimes[i]! - keyframeTimes[i - 1]!);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median <= 0) return null;

  const outliers = intervals.filter((iv) => iv > median * OUTLIER_RATIO || iv < median / OUTLIER_RATIO);
  if (outliers.length === 0) return null;

  return {
    code: "FRAME_DISCONTINUITY",
    severity: "warning",
    detail: `${outliers.length} of ${intervals.length} keyframe interval(s) deviate sharply from the median (${median.toFixed(2)}s) — consistent with a splice point`,
  };
}
