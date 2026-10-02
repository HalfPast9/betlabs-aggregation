/**
 * Run extraction on a submission from the command line, optionally with a
 * different vision model than the server is configured with — the per-model
 * half of the benchmark (docs/extraction-benchmark.md).
 *
 *   npx tsx scripts/runExtraction.ts <submission-id> [--model claude-haiku-4-5]
 *
 * Prints the extraction run id, which scripts/evalExtraction.ts scores.
 */
import { loadConfig } from "../src/config.js";
import { getPrisma } from "../src/db/client.js";
import { createObjectStore } from "../src/storage/objectStore.js";
import { ClaudeVisionExtractor } from "../src/extraction/claudeVisionExtractor.js";
import { createCrossCheckExtractor, createVisionExtractor } from "../src/extraction/factory.js";
import { runExtraction } from "../src/extraction/runExtraction.js";

async function main() {
  const args = process.argv.slice(2);
  const submissionId = args.find((a) => !a.startsWith("--"));
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  if (!submissionId) {
    console.error("usage: runExtraction.ts <submission-id> [--model <claude model id>]");
    process.exit(2);
  }
  const config = loadConfig();
  const prisma = getPrisma();
  try {
    const visionExtractor = model
      ? new ClaudeVisionExtractor({ apiKey: config.ANTHROPIC_API_KEY!, model })
      : createVisionExtractor(config);
    const t0 = Date.now();
    const result = await runExtraction(
      { prisma, objectStore: createObjectStore(config), visionExtractor, crossCheckExtractor: createCrossCheckExtractor(config), extractorVersion: config.EXTRACTOR_VERSION, panoramaFps: config.PANORAMA_FPS },
      submissionId,
    );
    console.log(
      `${result.extractionRunId}  model=${visionExtractor.model}  rows=${result.rowCount}  flags=${result.flagCount}  chainComplete=${result.chainComplete}  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
