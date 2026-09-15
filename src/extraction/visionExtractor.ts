export interface RawExtractedRow {
  timestamp: string | null;
  type: string | null;
  amount: number | null;
  balanceAfter: number | null;
  confidence: number | null;
}

export interface FrameReadResult {
  frameIndex: number;
  rows: RawExtractedRow[];
}

export interface VisionExtractionResult {
  frames: FrameReadResult[];
  inputTokens: number;
  outputTokens: number;
  /** null when the implementation doesn't know its own pricing (e.g. the fake). */
  costUsd: number | null;
}

export interface FrameInput {
  index: number;
  timestampSeconds: number;
  jpegBuffer: Buffer;
}

/**
 * PRD §6.3 step 2 — reads transaction rows out of sampled frames. Swappable
 * between a fake (deterministic, used in tests and local dev — no API key
 * needed) and a real Claude-backed implementation, the same pattern as
 * DropboxClient and EmailSender.
 */
export interface VisionExtractor {
  extractRows(frames: FrameInput[]): Promise<VisionExtractionResult>;
}
