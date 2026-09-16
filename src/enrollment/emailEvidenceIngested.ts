import type { Tx } from "./decisions.js";
import { recordTransition } from "./decisions.js";

/**
 * Shared by every path that lands verified email evidence on an enrollment
 * (automated inbound-email matching, a runner's manual upload): advances
 * invited -> email_submitted -> email_verified. A no-op past that point —
 * e.g. a runner uploading corrected evidence on an already-funded
 * enrollment archives fine but doesn't force an illegal transition.
 */
export async function handleEmailEvidenceSubmitted(
  tx: Tx,
  enrollment: { id: string; state: string },
  dkimResult: string,
  tier: string,
): Promise<void> {
  if (enrollment.state === "invited") {
    await recordTransition(tx, {
      enrollmentId: enrollment.id,
      toState: "email_submitted",
      actor: "system",
      note: "Email evidence received with an attached original",
    });
  }

  if (enrollment.state === "invited" || enrollment.state === "email_submitted") {
    await recordTransition(tx, {
      enrollmentId: enrollment.id,
      toState: "email_verified",
      actor: "system",
      note: `DKIM verification ran: ${dkimResult} (tier ${tier})`,
    });
  }
}
