import type { PrismaClient } from "@prisma/client";

export interface PreFundingCheck {
  code: string;
  passed: boolean;
  detail: string;
}

// PRD §6.5 doesn't name an exact threshold; a minute is a conservative floor
// below which "enrolled and already forwarded a signup confirmation" reads
// as automated rather than a person acting on a real email.
const IMPLAUSIBLY_SHORT_WINDOW_MS = 60_000;

/**
 * PRD §6.5 pre-funding checks — these "carry more weight than anything
 * post-funding" and are surfaced in the funding queue for a human to weigh
 * before the one consequential transition (email_verified -> funded).
 */
export async function runPreFundingChecks(
  prisma: PrismaClient,
  enrollmentId: string,
): Promise<PreFundingCheck[]> {
  const enrollment = await prisma.enrollment.findUniqueOrThrow({
    where: { id: enrollmentId },
    include: {
      participant: true,
      submissions: { include: { emailEvidence: true }, orderBy: { receivedAt: "asc" } },
    },
  });

  const checks: PreFundingCheck[] = [];

  if (enrollment.participant.email) {
    const otherParticipant = await prisma.participant.findFirst({
      where: { email: enrollment.participant.email, id: { not: enrollment.participantId } },
    });
    checks.push({
      code: "DUPLICATE_ENROLLMENT_EMAIL",
      passed: !otherParticipant,
      detail: otherParticipant
        ? `Registered email is also used by participant ${otherParticipant.id}`
        : "No other participant is registered with this email",
    });
  }

  const priorFunded = await prisma.enrollment.findFirst({
    where: {
      participantId: enrollment.participantId,
      casino: enrollment.casino,
      id: { not: enrollment.id },
      state: { in: ["funded", "wager_submitted", "wager_verified", "closed"] },
    },
  });
  checks.push({
    code: "ALREADY_FUNDED",
    passed: !priorFunded,
    detail: priorFunded
      ? `Participant was already funded for ${enrollment.casino} on enrollment ${priorFunded.id}`
      : `No prior funded enrollment for ${enrollment.casino}`,
  });

  const emailSubmission = enrollment.submissions.find((s) => s.emailEvidence);
  if (emailSubmission?.emailEvidence) {
    const toAddr = emailSubmission.emailEvidence.toAddr?.toLowerCase();
    const registered = enrollment.participant.email?.toLowerCase();
    const matches = !registered || !toAddr || toAddr === registered;
    checks.push({
      code: "RECIPIENT_MISMATCH",
      passed: matches,
      detail: matches
        ? "Signed To: matches the participant's registered address"
        : `Signed To: ${toAddr} does not match registered address ${registered}`,
    });
  }

  const firstEmailSubmission = enrollment.submissions.find((s) => s.kind === "signup_email");
  if (firstEmailSubmission) {
    const gapMs = firstEmailSubmission.receivedAt.getTime() - enrollment.createdAt.getTime();
    const plausible = gapMs >= IMPLAUSIBLY_SHORT_WINDOW_MS;
    checks.push({
      code: "SUBMISSION_TIMING",
      passed: plausible,
      detail: plausible
        ? `${Math.round(gapMs / 1000)}s between enrollment creation and first email submission`
        : `Only ${Math.round(gapMs / 1000)}s between enrollment creation and first email submission`,
    });
  }

  return checks;
}
