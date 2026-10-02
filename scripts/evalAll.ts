/**
 * The extraction gate: re-extract every ground-truth recording in eval/ and
 * score it. Any FAIL exits non-zero. Run it before merging anything under
 * src/extraction/ (docs/extraction-benchmark.md).
 *
 *   npm run eval                       # server's configured model
 *   npm run eval -- --model claude-haiku-4-5
 *   npm run eval -- --only betmgm      # fixture filename filter
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { getPrisma } from "../src/db/client.js";
import { createObjectStore } from "../src/storage/objectStore.js";
import { ClaudeVisionExtractor } from "../src/extraction/claudeVisionExtractor.js";
import { createCrossCheckExtractor, createVisionExtractor } from "../src/extraction/factory.js";
import { runExtraction } from "../src/extraction/runExtraction.js";
import { scoreRun, type EvalScore, type GroundTruth } from "./evalExtraction.js";

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const model = opt("--model");
  const only = opt("--only");

  const dir = join(process.cwd(), "eval");
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && (!only || f.includes(only)))
    .sort();
  if (fixtures.length === 0) {
    console.error("no fixtures in eval/ (see docs/extraction-benchmark.md for how to create one)");
    process.exit(2);
  }

  const config = loadConfig();
  const prisma = getPrisma();
  const objectStore = createObjectStore(config);
  const visionExtractor = model ? new ClaudeVisionExtractor({ apiKey: config.ANTHROPIC_API_KEY!, model }) : createVisionExtractor(config);

  const results: Array<{ fixture: string; score: EvalScore; seconds: number }> = [];
  try {
    for (const f of fixtures) {
      const gt = JSON.parse(readFileSync(join(dir, f), "utf8")) as GroundTruth;
      if (!gt.submissionId) {
        console.warn(`${f}: no submissionId — skipped`);
        continue;
      }
      const t0 = Date.now();
      process.stdout.write(`${f} … `);
      const run = await runExtraction(
        { prisma, objectStore, visionExtractor, crossCheckExtractor: createCrossCheckExtractor(config), extractorVersion: config.EXTRACTOR_VERSION, panoramaFps: config.PANORAMA_FPS },
        gt.submissionId,
      );
      const score = await scoreRun(prisma, gt, run.extractionRunId);
      const seconds = (Date.now() - t0) / 1000;
      console.log(score.pass ? "PASS" : "FAIL");
      results.push({ fixture: f, score, seconds });
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("");
  console.log("fixture".padEnd(46), "model".padEnd(18), "rows".padEnd(9), "recall".padEnd(8), "prec".padEnd(8), "wagered".padEnd(16), "breaks".padEnd(8), "cost".padEnd(8), "time");
  for (const r of results) {
    const s = r.score;
    console.log(
      r.fixture.padEnd(46),
      s.model.padEnd(18),
      `${s.got}/${s.expected}`.padEnd(9),
      `${(s.recall * 100).toFixed(0)}%`.padEnd(8),
      `${(s.precision * 100).toFixed(0)}%`.padEnd(8),
      `${s.wageredGot.toFixed(2)}/${s.wageredExpected.toFixed(2)}`.padEnd(16),
      `${s.breaks ?? "n/a"}/${s.expectedBreaks}`.padEnd(8),
      `$${(s.cost ?? 0).toFixed(3)}`.padEnd(8),
      `${r.seconds.toFixed(0)}s`,
      s.pass ? "" : "  ← FAIL",
    );
  }
  const failed = results.filter((r) => !r.score.pass).length;
  const totalCost = results.reduce((a, r) => a + (r.score.cost ?? 0), 0);
  console.log(`\n${results.length - failed}/${results.length} pass · total cost $${totalCost.toFixed(3)}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
