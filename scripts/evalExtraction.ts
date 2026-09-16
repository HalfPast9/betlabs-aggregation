/**
 * Score an extraction run against a hand-verified ground-truth list.
 *
 *   npx tsx scripts/evalExtraction.ts <ground-truth.json> <extraction-run-id>
 *   npx tsx scripts/evalExtraction.ts <ground-truth.json> --export <run-id> > eval/new.json
 *
 * Ground truth is the full list of transactions in the recording, in display
 * order, with the fields the pipeline extracts. Rows are matched as an ordered
 * sequence (longest common subsequence on timestamp+type+amount+balances), so
 * a missed row costs recall, an invented or duplicated row costs precision,
 * and a misread field costs both. See docs/extraction-benchmark.md.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

interface GtRow {
  timestamp: string | null;
  type: string | null;
  amount: number | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
}

interface GroundTruth {
  description?: string;
  /** Expected number of balance-chain breaks that are genuinely in the source list. */
  expectedChainBreaks?: number;
  rows: GtRow[];
}

function sameRow(a: GtRow, b: GtRow): boolean {
  const num = (x: number | null, y: number | null) => (x === null || y === null ? x === y : Math.abs(x - y) < 0.011);
  const ts = (x: string | null) => (x ? new Date(x).getTime() : null);
  return ts(a.timestamp) === ts(b.timestamp) && a.type === b.type && num(a.amount, b.amount) && num(a.balanceBefore, b.balanceBefore) && num(a.balanceAfter, b.balanceAfter);
}

/** Longest common subsequence length — order-aware matching. */
function lcs(a: GtRow[], b: GtRow[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = sameRow(a[i - 1]!, b[j - 1]!) ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

async function main() {
  const [gtPath, arg, runIdArg] = process.argv.slice(2);
  if (!gtPath || !arg) {
    console.error("usage: evalExtraction.ts <ground-truth.json> <run-id> | --export <run-id>");
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const runId = arg === "--export" ? runIdArg! : arg;
    const run = await prisma.extractionRun.findUniqueOrThrow({
      where: { id: runId },
      include: { rows: { orderBy: { sequence: "asc" } }, reconciliation: true },
    });
    const got: GtRow[] = run.rows.map((r) => ({
      timestamp: r.timestamp ? r.timestamp.toISOString() : null,
      type: r.type,
      amount: r.amount === null ? null : Number(r.amount),
      balanceBefore: r.balanceBefore === null ? null : Number(r.balanceBefore),
      balanceAfter: r.balanceAfter === null ? null : Number(r.balanceAfter),
    }));

    if (arg === "--export") {
      const out: GroundTruth = {
        description: "Exported from run " + runId + " — verify by hand before treating as ground truth",
        expectedChainBreaks: run.reconciliation?.chainBreaks ? (run.reconciliation.chainBreaks as unknown[]).length : 0,
        rows: got,
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    const gt = JSON.parse(readFileSync(gtPath, "utf8")) as GroundTruth;
    const matched = lcs(gt.rows, got);
    const recall = matched / gt.rows.length;
    const precision = got.length ? matched / got.length : 0;
    const breaks = run.reconciliation?.chainBreaks ? (run.reconciliation.chainBreaks as unknown[]).length : null;
    const wagered = (rows: GtRow[]) => rows.filter((r) => r.type === "bet").reduce((s, r) => s + Math.abs(r.amount ?? 0), 0);

    console.log(`run ${runId}  model=${run.model}  extractor=${run.extractorVersion}  cost=$${run.costUsd ?? "?"}  tiles=${run.tileCount ?? "?"}`);
    console.log(`rows: expected ${gt.rows.length}, got ${got.length}, exactly matched in order ${matched}`);
    console.log(`recall ${(recall * 100).toFixed(1)}%  precision ${(precision * 100).toFixed(1)}%`);
    console.log(`wagered: expected ${wagered(gt.rows).toFixed(2)}, got ${wagered(got).toFixed(2)}`);
    console.log(`chain breaks: ${breaks ?? "n/a"} (expected ${gt.expectedChainBreaks ?? 0})`);
    const pass = recall === 1 && precision === 1 && breaks === (gt.expectedChainBreaks ?? 0);
    console.log(pass ? "PASS" : "FAIL");
    process.exitCode = pass ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
