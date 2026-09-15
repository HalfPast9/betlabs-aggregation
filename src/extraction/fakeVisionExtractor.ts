import type { FrameInput, RawExtractedRow, VisionExtractionResult, VisionExtractor } from "./visionExtractor.js";

export type FrameScript = (frame: FrameInput) => RawExtractedRow[];

/**
 * Deterministic stand-in for a vision model, used in tests and as the
 * default local-dev mode (no API key required — mirrors FakeDropboxClient).
 * Pass a script mapping a frame to the rows it "reads"; defaults to reading
 * nothing.
 */
export class FakeVisionExtractor implements VisionExtractor {
  constructor(private readonly script: FrameScript = () => []) {}

  async extractRows(frames: FrameInput[]): Promise<VisionExtractionResult> {
    return {
      frames: frames.map((f) => ({ frameIndex: f.index, rows: this.script(f) })),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
}
