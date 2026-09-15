import type { DkimVerdict } from "./dkim.js";

/** PRD §7.2 evidence-tiering table. */
export type EvidenceTier = "A" | "B" | "C" | "D";

export function tierForAttachedOriginal(args: {
  dkimResult: DkimVerdict;
  hTagCoversTo: boolean;
  signerAllowlisted: boolean;
}): EvidenceTier {
  const cryptographic = args.dkimResult === "pass" && args.hTagCoversTo && args.signerAllowlisted;
  return cryptographic ? "A" : "B";
}

export function tierForNoAttachment(hasImageAttachment: boolean): EvidenceTier {
  return hasImageAttachment ? "D" : "C";
}
