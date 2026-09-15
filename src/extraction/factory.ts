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
