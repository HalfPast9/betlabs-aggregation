import Anthropic from "@anthropic-ai/sdk";
import type {
  FrameInput,
  RawExtractedRow,
  VisionExtractionResult,
  VisionExtractor,
} from "./visionExtractor.js";

const TOOL_NAME = "record_transaction_rows";

// Not billed at time of writing (no confirmed vendor rate card for this
// project); left null until Betlab's actual usage tier is known. Cost
// instrumentation (PRD §6.3) still records raw token counts either way.
const KNOWN_USD_PER_TOKEN: { input: number | null; output: number | null } = {
  input: null,
  output: null,
};

export interface ClaudeVisionExtractorOptions {
  apiKey: string;
  model?: string;
}

/**
 * Reads transaction rows out of a screen-recording frame using Claude's
 * vision + tool-use (PRD §6.3 step 2). One request per frame — casino UIs
 * are unknown and varied, so this is deliberately a generalist reader rather
 * than a per-casino template (§6.3 rationale).
 */
export class ClaudeVisionExtractor implements VisionExtractor {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: ClaudeVisionExtractorOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-5";
  }

  async extractRows(frames: FrameInput[]): Promise<VisionExtractionResult> {
    const results: VisionExtractionResult["frames"] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    for (const frame of frames) {
      const rows = await this.readFrame(frame);
      results.push({ frameIndex: frame.index, rows: rows.rows });
      inputTokens += rows.inputTokens;
      outputTokens += rows.outputTokens;
    }

    const costUsd =
      KNOWN_USD_PER_TOKEN.input !== null && KNOWN_USD_PER_TOKEN.output !== null
        ? inputTokens * KNOWN_USD_PER_TOKEN.input + outputTokens * KNOWN_USD_PER_TOKEN.output
        : null;

    return { frames: results, inputTokens, outputTokens, costUsd };
  }

  private async readFrame(
    frame: FrameInput,
  ): Promise<{ rows: RawExtractedRow[]; inputTokens: number; outputTokens: number }> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Records every transaction row visible in this frame of a scrolling transaction-history screen recording.",
          input_schema: {
            type: "object",
            properties: {
              rows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    timestamp: { type: ["string", "null"], description: "As displayed, verbatim" },
                    type: { type: ["string", "null"], description: "e.g. bet, win, deposit" },
                    amount: { type: ["number", "null"] },
                    balanceAfter: { type: ["number", "null"], description: "Running balance after this row, if shown" },
                    confidence: { type: ["number", "null"], description: "0-1, this row's read confidence" },
                  },
                  required: ["timestamp", "type", "amount", "balanceAfter", "confidence"],
                },
              },
            },
            required: ["rows"],
          },
        },
      ],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: frame.jpegBuffer.toString("base64") },
            },
            {
              type: "text",
              text: "This is one frame of a scrolling transaction-history list from a casino app, submitted as wager verification evidence. List every transaction row fully or partially visible in this frame.",
            },
          ],
        },
      ],
    });

    const toolUse = message.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
    );
    const rows = Array.isArray((toolUse?.input as { rows?: unknown })?.rows)
      ? ((toolUse!.input as { rows: RawExtractedRow[] }).rows)
      : [];

    return { rows, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  }
}
