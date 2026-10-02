import Anthropic from "@anthropic-ai/sdk";
import type {
  RawExtractedRow,
  TileInput,
  VisionExtractionResult,
  VisionExtractor,
} from "./visionExtractor.js";

const TOOL_NAME = "record_transaction_rows";

// First-party Anthropic API rates, $ per token (list price / 1,000,000).
// Betlab's actual negotiated/volume rate, if any, isn't known — this is
// what cost instrumentation (PRD §6.3) uses until that's confirmed.
const USD_PER_TOKEN_BY_MODEL: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  "claude-sonnet-5": { input: 2 / 1_000_000, output: 10 / 1_000_000 },
  "claude-opus-5": { input: 5 / 1_000_000, output: 25 / 1_000_000 },
};

const READ_CONCURRENCY = 4;

export interface ClaudeVisionExtractorOptions {
  apiKey: string;
  model?: string;
}

const TOOL = {
  name: TOOL_NAME,
  description: "Records every transaction row visible in this tile of a stitched transaction-history list.",
  input_schema: {
    type: "object" as const,
    properties: {
      rows: {
        type: "array",
        description: "Every row in the tile, in top-to-bottom display order.",
        items: {
          type: "object",
          properties: {
            timestamp: {
              type: ["string", "null"],
              description:
                "The full date+time for THIS row, combined into one string, as displayed. Many UIs split this across two places: a time-of-day next to each row (e.g. '1:23 PM') and a date shown once above a group of rows or once per row (e.g. '11/30/25'). Combine the applicable date with this row's own time. If only one of the two is visible anywhere, return just that one.",
            },
            type: {
              type: ["string", "null"],
              enum: ["bet", "win", "deposit", "withdrawal", "bonus", "refund", "other", null],
              description:
                "The single best-fit category for this row, inferred from wording, color, icon, or sign (e.g. a red/negative amount taken for a wager is 'bet'; green/positive returned from a game is 'win'). Use 'other' rather than guessing.",
            },
            description: {
              type: ["string", "null"],
              description:
                "Whatever doesn't belong in `type` — game/counterparty name, the raw on-screen label, anything else identifying. Do not put this in `type`.",
            },
            amount: {
              type: ["number", "null"],
              description:
                "The row's amount. Keep the sign the UI shows (e.g. -1.00 for a wager, +2.00 for a win); if no sign is shown, give the magnitude. A signed figure is always an amount (a change), even when the UI labels it 'My Balance +$30.00' — that is the change to the balance, not a balance.",
            },
            balanceBefore: {
              type: ["number", "null"],
              description:
                "This row's starting/initial balance, ONLY if the UI shows one distinct from the ending balance (e.g. separate 'Initial balance' and 'Final balance' fields on the same row). Leave null if the UI shows only a single running balance — put that single value in balanceAfter instead.",
            },
            balanceAfter: {
              type: ["number", "null"],
              description:
                "This row's ending/final/resulting balance, or the single running balance if the UI only shows one ('Balance', 'Balance after', 'Final balance'). Null when the UI shows no balance at all — never put a signed change here.",
            },
            confidence: { type: ["number", "null"], description: "0-1, this row's read confidence." },
            fullyVisible: {
              type: "boolean",
              description:
                "true if the whole row (all its lines and fields) is inside the tile. false if the tile's top or bottom edge cuts through it — still record what you can read, another tile has the rest.",
            },
            yTop: {
              type: ["number", "null"],
              description:
                "The number printed on the ruler in the grey left margin that is closest to this row's TOP edge (the first line of the row). Read the label; do not compute it. Interpolate between two labels if the edge is clearly between them (e.g. 1250 for halfway between 1200 and 1300).",
            },
          },
          required: ["timestamp", "type", "description", "amount", "balanceBefore", "balanceAfter", "confidence", "fullyVisible", "yTop"],
        },
      },
    },
    required: ["rows"],
  },
};

const PROMPT = `This is one tile of a tall image: a casino app's transaction-history list, reconstructed from a screen recording so that the whole scrolled list appears as one continuous image, then cut into overlapping tiles. The grey strip on the left is a pixel ruler with numeric labels; it is not part of the app.

List every transaction row in this tile in top-to-bottom order, including rows cut off by the top or bottom edge (mark those fullyVisible=false). Casino UIs vary a lot — read exactly what's shown rather than assuming a fixed layout: some show one running balance per row, others show separate initial/final balances; some label transactions plainly, others embed the game name in the same text as the transaction type; some print a full timestamp on every row, others print a date once above a group and only a time-of-day per row. Use the schema fields as described. Rows in this kind of list often look nearly identical (same game, same amount, same minute) — they are distinct transactions; record every one.

Some UIs summarize a game session in one card with both an amount wagered and an amount won (e.g. "Bets $5 / Wins $10 / Balance after $84"). Record such a card as two rows with the same timestamp and description: a bet row for the wagered amount with both balances null, then a win row for the won amount carrying the card's balance in balanceAfter. If the won amount is 0, record only the bet row and give it the balance. Cards that are not transactions (page titles, filters, "Showing N results", loading indicators) are not rows.`;

/**
 * Reads transaction rows out of panorama tiles using Claude's vision +
 * tool-use (PRD §6.3 step 2). One request per tile — casino UIs are unknown
 * and varied, so this is deliberately a generalist reader rather than a
 * per-casino template (§6.3 rationale).
 */
export class ClaudeVisionExtractor implements VisionExtractor {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(opts: ClaudeVisionExtractorOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-5";
  }

  async extractRows(tiles: TileInput[]): Promise<VisionExtractionResult> {
    // Tiles are independent; read a few at a time (order of results preserved).
    const reads = new Array<Awaited<ReturnType<ClaudeVisionExtractor["readTile"]>>>(tiles.length);
    let next = 0;
    const worker = async () => {
      while (next < tiles.length) {
        const i = next++;
        reads[i] = await this.readTile(tiles[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, tiles.length) }, worker));

    let inputTokens = 0;
    let outputTokens = 0;
    const results: VisionExtractionResult["tiles"] = tiles.map((tile, i) => {
      inputTokens += reads[i]!.inputTokens;
      outputTokens += reads[i]!.outputTokens;
      return { tileIndex: tile.index, rows: reads[i]!.rows };
    });

    const rate = USD_PER_TOKEN_BY_MODEL[this.model];
    const costUsd = rate ? inputTokens * rate.input + outputTokens * rate.output : null;
    return { tiles: results, inputTokens, outputTokens, costUsd };
  }

  private async readTile(tile: TileInput): Promise<{ rows: RawExtractedRow[]; inputTokens: number; outputTokens: number }> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: tile.jpegBuffer.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });

    const toolUse = message.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );
    const raw = (toolUse?.input as { rows?: unknown })?.rows;
    const rows: RawExtractedRow[] = Array.isArray(raw)
      ? (raw as Partial<RawExtractedRow>[]).map((r) => ({
          timestamp: r.timestamp ?? null,
          type: r.type ?? null,
          description: r.description ?? null,
          amount: typeof r.amount === "number" ? r.amount : null,
          balanceBefore: typeof r.balanceBefore === "number" ? r.balanceBefore : null,
          balanceAfter: typeof r.balanceAfter === "number" ? r.balanceAfter : null,
          confidence: typeof r.confidence === "number" ? r.confidence : null,
          fullyVisible: r.fullyVisible !== false,
          yTop: typeof r.yTop === "number" ? r.yTop : null,
        }))
      : [];

    return { rows, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  }
}
