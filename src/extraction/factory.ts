import type { Config } from "../config.js";
import { FakeVisionExtractor } from "./fakeVisionExtractor.js";
import { ClaudeVisionExtractor } from "./claudeVisionExtractor.js";
import type { VisionExtractor } from "./visionExtractor.js";

export function createVisionExtractor(config: Config): VisionExtractor {
  if (config.VISION_MODE === "claude") {
    return new ClaudeVisionExtractor({ apiKey: config.ANTHROPIC_API_KEY!, model: config.CLAUDE_VISION_MODEL });
  }
  return new FakeVisionExtractor();
}

/** Second, independent reader for timestamps/descriptions (docs/extraction-hardening.md §3); undefined when off. */
export function createCrossCheckExtractor(config: Config): VisionExtractor | undefined {
  if (config.VISION_MODE !== "claude" || config.CROSSCHECK_VISION_MODEL === "off") return undefined;
  return new ClaudeVisionExtractor({ apiKey: config.ANTHROPIC_API_KEY!, model: config.CROSSCHECK_VISION_MODEL });
}
