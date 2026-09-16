import type { RawExtractedRow, TileInput, VisionExtractionResult, VisionExtractor } from "./visionExtractor.js";

export type TileScript = (tile: TileInput) => RawExtractedRow[];

/**
 * Deterministic stand-in for a vision model, used in tests and as the
 * default local-dev mode (no API key required — mirrors FakeDropboxClient).
 * Pass a script mapping a tile to the rows it "reads"; defaults to reading
 * nothing.
 */
export class FakeVisionExtractor implements VisionExtractor {
  readonly model = "fake";
  constructor(private readonly script: TileScript = () => []) {}

  async extractRows(tiles: TileInput[]): Promise<VisionExtractionResult> {
    return {
      tiles: tiles.map((t) => ({ tileIndex: t.index, rows: this.script(t) })),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
}
