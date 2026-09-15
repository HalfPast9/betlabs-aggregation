import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ALLOWED_TRANSITIONS, TERMINAL_STATES, isEnrollmentState, type EnrollmentState } from "./states.js";

export type Tx = Prisma.TransactionClient | PrismaClient;

export interface EvidenceSnapshot {
  artifacts: Array<{ submissionId: string; kind: string; channel: string; contentHash: string }>;
  dkim: Array<{
    submissionId: string;
    tier: string;
    dkimResult: string;
    dDomain: string | null;
    selector: string | null;
  }>;
  flags: Array<{ submissionId: string; code: string; severity: string }>;
}

/**
 * PRD §6.5: "the DKIM verdict, the set of flags present, and the content
 * hashes of every artifact, as they stood at the moment of the decision."
 * Frozen into the decision row rather than recomputed later, because DKIM
 * selectors get retired and flags get recomputed when the extractor is
 * upgraded — the snapshot must survive that.
 */
export async function buildEvidenceSnapshot(tx: Tx, enrollmentId: string): Promise<EvidenceSnapshot> {
  const submissions = await tx.submission.findMany({
    where: { enrollmentId },
    include: { emailEvidence: true, integrityFlags: true },
  });

  return {
    artifacts: submissions.map((s) => ({
      submissionId: s.id,
      kind: s.kind,
      channel: s.channel,
      contentHash: s.contentHash,
    })),
    dkim: submissions
      .filter((s) => s.emailEvidence)
      .map((s) => ({
        submissionId: s.id,
        tier: s.emailEvidence!.tier,
        dkimResult: s.emailEvidence!.dkimResult,
        dDomain: s.emailEvidence!.dDomain,
        selector: s.emailEvidence!.selector,
      })),
    flags: submissions.flatMap((s) =>
      s.integrityFlags.map((f) => ({ submissionId: s.id, code: f.code, severity: f.severity })),
    ),
  };
}

function computeHash(payload: unknown, prevHash: string | null): string {
  return createHash("sha256").update(JSON.stringify({ payload, prevHash })).digest("hex");
}

export interface RecordTransitionArgs {
  enrollmentId: string;
  toState: EnrollmentState;
  /** Free-text identity of who/what made this happen — "system" for automatic transitions. */
  actor: string;
  note?: string;
}

/**
 * The only path by which `enrollment.state` changes. Validates the
 * transition against the state machine, writes a hash-chained `decision`
 * row with a fresh evidence snapshot, then updates the enrollment — all
 * inside the caller's transaction so the two never diverge.
 */
export async function recordTransition(
  tx: Tx,
  args: RecordTransitionArgs,
): Promise<{ id: string; state: string }> {
  const enrollment = await tx.enrollment.findUnique({ where: { id: args.enrollmentId } });
  if (!enrollment) throw new Error(`No enrollment ${args.enrollmentId}`);
  if (!isEnrollmentState(enrollment.state)) {
    throw new Error(`Enrollment ${args.enrollmentId} has unknown state ${enrollment.state}`);
  }

  const fromState = enrollment.state;
  if (TERMINAL_STATES.has(args.toState)) {
    if (TERMINAL_STATES.has(fromState)) {
      throw new Error(`Enrollment ${args.enrollmentId} is already terminal (${fromState})`);
    }
  } else if (!ALLOWED_TRANSITIONS[fromState].includes(args.toState)) {
    throw new Error(`Illegal transition ${fromState} -> ${args.toState}`);
  }

  const at = new Date();
  const snapshot = await buildEvidenceSnapshot(tx, args.enrollmentId);
  const lastDecision = await tx.decision.findFirst({
    where: { enrollmentId: args.enrollmentId },
    orderBy: { at: "desc" },
  });
  const prevHash = lastDecision?.hash ?? null;
  const hash = computeHash(
    {
      enrollmentId: args.enrollmentId,
      actor: args.actor,
      fromState,
      toState: args.toState,
      note: args.note ?? null,
      at: at.toISOString(),
      snapshot,
    },
    prevHash,
  );

  await tx.decision.create({
    data: {
      enrollmentId: args.enrollmentId,
      actor: args.actor,
      fromState,
      toState: args.toState,
      at,
      note: args.note,
      evidenceSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      prevHash,
      hash,
    },
  });

  return tx.enrollment.update({ where: { id: args.enrollmentId }, data: { state: args.toState } });
}
