/**
 * Constrained vocabulary rather than free text — casino UIs describe the
 * same underlying event ("bet", "wager placed", "Taken to <game>") very
 * differently, and reconciliation needs to key off something stable across
 * all of them. Anything the model can't confidently map here goes in
 * `description` instead, not into this field.
 */
export type TransactionType = "bet" | "win" | "deposit" | "withdrawal" | "bonus" | "refund" | "other";

export interface RawExtractedRow {
  timestamp: string | null;
  type: TransactionType | null;
  /** Free text for whatever doesn't fit `type` — game name, counterparty, the raw label, etc. */
  description: string | null;
  /** Signed as displayed when the UI shows a sign; otherwise the magnitude. */
  amount: number | null;
  /** Only present when the UI shows a per-row starting balance; many UIs show just one running balance. */
  balanceBefore: number | null;
  balanceAfter: number | null;
  confidence: number | null;
  /** False when the row is cut off by the tile edge — a neighbouring tile has the full read. */
  fullyVisible: boolean;
  /**
   * The ruler label nearest this row's top edge, in the tile's ruler units.
   * The model reads this off the margin rather than estimating coordinates.
   */
  yTop: number | null;
}

export interface TileReadResult {
  tileIndex: number;
  rows: RawExtractedRow[];
}

export interface VisionExtractionResult {
  tiles: TileReadResult[];
  inputTokens: number;
  outputTokens: number;
  /** null when the implementation doesn't know its own pricing (e.g. the fake). */
  costUsd: number | null;
}

export interface TileInput {
  index: number;
  jpegBuffer: Buffer;
  /** Panorama y-range (full-res px) the tile shows, and ruler-units → full-res px factor. */
  top: number;
  bottom: number;
  scale: number;
}

/**
 * PRD §6.3 step 2 — reads transaction rows out of panorama tiles. Swappable
 * between a fake (deterministic, used in tests and local dev — no API key
 * needed) and a real Claude-backed implementation, the same pattern as
 * DropboxClient and EmailSender.
 */
export interface VisionExtractor {
  /** Recorded on each extraction run so results can be compared across models. */
  readonly model: string;
  extractRows(tiles: TileInput[]): Promise<VisionExtractionResult>;
}
