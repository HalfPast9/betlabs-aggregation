import type { IntegritySignal } from "./videoSignals.js";

export function checkManualIntake(channel: string): IntegritySignal | null {
  if (channel !== "manual_upload") return null;
  return {
    code: "MANUAL_INTAKE",
    severity: "info",
    detail: "Submission arrived out of band (manual upload); provenance unverified",
  };
}

// PRD §7 doesn't name an exact threshold; two weeks is a conservative default
// pending Betlab guidance, easy to make configurable later.
const SUBMISSION_GAP_DAYS = 14;

export function checkSubmissionGap(receivedAt: Date, grantSentAt: Date | null): IntegritySignal | null {
  if (!grantSentAt) return null;
  const gapDays = Math.abs(receivedAt.getTime() - grantSentAt.getTime()) / (1000 * 60 * 60 * 24);
  if (gapDays <= SUBMISSION_GAP_DAYS) return null;
  return {
    code: "SUBMISSION_GAP",
    severity: "warning",
    detail: `Recording submitted ${gapDays.toFixed(1)} days from the grant date (threshold ${SUBMISSION_GAP_DAYS}d)`,
  };
}
