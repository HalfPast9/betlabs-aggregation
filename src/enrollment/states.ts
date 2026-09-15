export const ENROLLMENT_STATES = [
  "invited",
  "email_submitted",
  "email_verified",
  "funded",
  "wager_submitted",
  "wager_verified",
  "closed",
  "rejected",
  "abandoned",
] as const;

export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<EnrollmentState> = new Set([
  "closed",
  "rejected",
  "abandoned",
]);

/**
 * Forward-path transitions from PRD §6.5:
 *   invited -> email_submitted -> email_verified -> funded
 *           -> wager_submitted -> wager_verified -> closed
 * `rejected`/`abandoned` are reachable from any non-terminal state via
 * separate explicit actions (see stateMachine.ts), not listed here.
 */
export const ALLOWED_TRANSITIONS: Record<EnrollmentState, EnrollmentState[]> = {
  invited: ["email_submitted"],
  email_submitted: ["email_verified"],
  email_verified: ["funded"],
  funded: ["wager_submitted"],
  wager_submitted: ["wager_verified"],
  wager_verified: ["closed"],
  closed: [],
  rejected: [],
  abandoned: [],
};

/** Which transitions are a human decision vs. a system-driven inference. */
export const HUMAN_DECISION_TRANSITIONS: ReadonlySet<string> = new Set([
  "email_verified->funded",
  "wager_submitted->wager_verified",
]);

export function isEnrollmentState(value: string): value is EnrollmentState {
  return (ENROLLMENT_STATES as readonly string[]).includes(value);
}
