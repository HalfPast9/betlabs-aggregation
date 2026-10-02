/**
 * Stage the existing demo data into one coherent story for a walkthrough
 * (docs/demo-script.md).
 *
 *   npx tsx scripts/stageDemo.ts            # show what it would change
 *   npx tsx scripts/stageDemo.ts --apply
 *
 * It renames the placeholder participants to plausible people and walks each
 * enrollment that already has an extracted recording up the real lifecycle —
 * through `recordTransition`, so every step writes a hash-chained Decision
 * exactly as it would in production. Nothing is deleted, no extraction is
 * re-run, and an enrollment that's already past a step is left alone.
 */
import { getPrisma } from "../src/db/client.js";
import { recordTransition } from "../src/enrollment/decisions.js";
import type { EnrollmentState } from "../src/enrollment/states.js";

const APPLY = process.argv.includes("--apply");

/** Placeholder contact → the person they stand in for in the demo. */
const PEOPLE: Record<string, { contact: string; email: string }> = {
  "whatsapp:+15550000001": { contact: "whatsapp:+14165550114", email: "d.okafor@example.com" },
  "whatsapp:+15550000002": { contact: "whatsapp:+14165550198", email: "m.laurent@example.com" },
  "whatsapp:+15550000101": { contact: "whatsapp:+14165550133", email: "s.whitfield@example.com" },
  "whatsapp:+15550000102": { contact: "whatsapp:+14165550176", email: "a.baptiste@example.com" },
  "whatsapp:+15550000103": { contact: "whatsapp:+14165550142", email: "r.nakamura@example.com" },
};

/** Grant per casino — what the participant was funded to wager. */
const GRANT_BY_CASINO: Record<string, number> = {
  "BetMGM Ontario": 100,
  "BetRivers Ontario (Game History)": 50,
  "BetRivers Ontario (Statements)": 50,
  "OLG / PlayNow style (Transaction History)": 80,
};

const PATH: EnrollmentState[] = ["email_submitted", "email_verified", "funded", "wager_submitted"];

async function main() {
  const prisma = getPrisma();
  const plan: string[] = [];
  try {
    for (const [from, to] of Object.entries(PEOPLE)) {
      const participant = await prisma.participant.findFirst({ where: { contact: from } });
      if (!participant) continue;
      plan.push(`participant ${from} → ${to.contact} (${to.email})`);
      if (APPLY) await prisma.participant.update({ where: { id: participant.id }, data: to });
    }

    const enrollments = await prisma.enrollment.findMany({
      include: {
        participant: true,
        grant: true,
        submissions: { include: { extractionRuns: { where: { status: "succeeded" }, take: 1 } } },
      },
      orderBy: { createdAt: "asc" },
    });

    for (const e of enrollments) {
      const hasExtraction = e.submissions.some((s) => s.extractionRuns.length > 0);
      if (!hasExtraction) {
        plan.push(`${e.casino}: left at "${e.state}" (no extracted recording — it's the funding-queue example)`);
        continue;
      }
      const grantAmount = GRANT_BY_CASINO[e.casino];
      const target = PATH.indexOf("wager_submitted");
      const current = PATH.indexOf(e.state as EnrollmentState);
      if (e.state === "wager_submitted" || e.state === "wager_verified") {
        plan.push(`${e.casino}: already at "${e.state}"`);
      } else {
        for (let i = Math.max(0, current + 1); i <= target; i++) {
          const toState = PATH[i]!;
          plan.push(`${e.casino}: ${i === 0 ? e.state : PATH[i - 1]} → ${toState}`);
          if (APPLY) {
            await prisma.$transaction((tx) =>
              recordTransition(tx, {
                enrollmentId: e.id,
                toState,
                actor: toState === "funded" ? "demo-staging (ops)" : "system",
                note:
                  toState === "funded"
                    ? `Funded ${grantAmount ?? 50} for wagering`
                    : toState === "wager_submitted"
                      ? "Wager recording received"
                      : "Signup email evidence received",
              }),
            );
          }
        }
      }

      if (grantAmount !== undefined && !e.grant) {
        plan.push(`${e.casino}: record grant ${grantAmount.toFixed(2)}`);
        if (APPLY) {
          await prisma.grant.create({
            data: { enrollmentId: e.id, amount: grantAmount, sentAt: new Date(Date.now() - 36 * 60 * 60 * 1000), method: "interac" },
          });
        }
      }
    }

    console.log(plan.map((l) => `  ${l}`).join("\n"));
    console.log(APPLY ? "\napplied." : "\ndry run — nothing changed. Re-run with --apply.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
