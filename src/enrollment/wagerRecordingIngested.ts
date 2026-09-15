import type { Tx } from "./decisions.js";
import { recordTransition } from "./decisions.js";

/**
 * Shared by every wager-recording ingest path (Dropbox sync, manual upload):
 * advances funded -> wager_submitted, or — per PRD §6.5 "sequence violations
 * are flagged, not blocked" — archives the recording with an OUT_OF_SEQUENCE
 * flag instead of advancing state.
 */
export async function handleWagerRecordingSubmitted(
  tx: Tx,
  enrollment: { id: string; state: string },
  submissionId: string,
  generatedBy: string,
): Promise<{ advancedToWagerSubmitted: boolean }> {
  if (enrollment.state === "funded") {
    await recordTransition(tx, {
      enrollmentId: enrollment.id,
      toState: "wager_submitted",
      actor: "system",
      note: "Wager recording submitted",
    });
    return { advancedToWagerSubmitted: true };
  }

  await tx.integrityFlag.create({
    data: {
      submissionId,
      code: "OUT_OF_SEQUENCE",
      severity: "warning",
      detail: `Wager recording arrived while enrollment was in state "${enrollment.state}", not "funded"`,
      generatedBy,
    },
  });
  return { advancedToWagerSubmitted: false };
}
