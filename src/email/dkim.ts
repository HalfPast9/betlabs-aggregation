import { dkimVerify } from "mailauth/lib/dkim/verify.js";
import type { DNSResolver } from "mailauth";

export type DkimVerdict = "pass" | "fail" | "no_signature" | "error";

export interface DkimVerificationResult {
  result: DkimVerdict;
  selector: string | null;
  dDomain: string | null;
  /** PEM-encoded public key fetched from DNS and actually used to verify (PRD §7.2 step 4). */
  publicKeyUsed: string | null;
  hTagCoversTo: boolean;
  lTagPresent: boolean;
}

// PRD §7.2 step 5: To/From/Subject/Date must all be covered by h= — otherwise
// they're unsigned body-adjacent metadata, freely editable.
const REQUIRED_SIGNED_HEADERS = ["to", "from", "subject", "date"];

/**
 * mailauth's shipped .d.ts is thinner than its actual runtime result; these
 * are the extra fields the real implementation returns that we rely on
 * (verified by hand against the installed version — see git history).
 */
interface DkimResultExtra {
  status: { result: string; comment?: string };
  selector?: string;
  signingDomain?: string;
  publicKey?: string;
  canonBodyLengthLimited?: boolean;
  signingHeaders?: { keys?: string };
}

/**
 * Verifies the DKIM signature on a raw email (PRD §7.2 steps 1-6). Runs
 * against real DNS by default; tests inject a fake `resolver` so verification
 * logic can be exercised without depending on external DNS state.
 */
export async function verifyDkim(rawEml: Buffer, resolver?: DNSResolver): Promise<DkimVerificationResult> {
  const empty: DkimVerificationResult = {
    result: "error",
    selector: null,
    dDomain: null,
    publicKeyUsed: null,
    hTagCoversTo: false,
    lTagPresent: false,
  };

  let verified;
  try {
    verified = await dkimVerify(rawEml, resolver ? { resolver } : undefined);
  } catch {
    return empty;
  }

  const primary = verified.results[0] as unknown as DkimResultExtra | undefined;
  if (!primary) return { ...empty, result: "no_signature" };

  const result = mapVerdict(primary.status.result);
  if (result === "no_signature") {
    return { ...empty, result: "no_signature" };
  }

  const signedKeys = (primary.signingHeaders?.keys ?? "")
    .split(":")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  return {
    result,
    selector: primary.selector ?? null,
    dDomain: primary.signingDomain ?? null,
    publicKeyUsed: primary.publicKey ?? null,
    hTagCoversTo: REQUIRED_SIGNED_HEADERS.every((h) => signedKeys.includes(h)),
    lTagPresent: primary.canonBodyLengthLimited ?? false,
  };
}

function mapVerdict(raw: string): DkimVerdict {
  switch (raw) {
    case "pass":
      return "pass";
    case "none":
      return "no_signature";
    case "temperror":
    case "temperr":
    case "permerror":
      return "error";
    default:
      return "fail";
  }
}
