import type { PrismaClient } from "@prisma/client";
import type { DNSResolver } from "mailauth";
import { verifyDkim } from "./dkim.js";
import { parseOriginalHeaders } from "./parseMime.js";
import { tierForAttachedOriginal } from "./tier.js";

export interface EmailEvidenceData {
  tier: string;
  dkimResult: string;
  selector: string | null;
  dDomain: string | null;
  publicKeyUsed: string | null;
  hTagCoversTo: boolean;
  lTagPresent: boolean;
  fromAddr: string | null;
  toAddr: string | null;
  subject: string | null;
  sentAt: Date | null;
}

/**
 * PRD §7.2's verification procedure, factored out so a runner manually
 * relaying an .eml (PRD §6.1's "manual paste by runner" pattern, applied to
 * email evidence — see routes/submissions.ts) gets the exact same real DKIM
 * verification and tiering as the automated inbound-email path
 * (email/inboundEmail.ts). Which door the bytes came through shouldn't
 * change how much evidential weight they carry.
 *
 * Does real network I/O (DKIM's DNS lookup) — call this *before* opening a
 * DB transaction, never from inside one.
 */
export async function verifyEmailEvidence(
  prisma: PrismaClient,
  casino: string,
  rawEml: Buffer,
  dkimResolver?: DNSResolver,
): Promise<EmailEvidenceData> {
  const dkim = await verifyDkim(rawEml, dkimResolver);
  const original = await parseOriginalHeaders(rawEml);

  const allowedSigner = dkim.dDomain
    ? await prisma.dkimAllowedSigner.findFirst({ where: { casino, domain: dkim.dDomain } })
    : null;
  const tier = tierForAttachedOriginal({
    dkimResult: dkim.result,
    hTagCoversTo: dkim.hTagCoversTo,
    signerAllowlisted: !!allowedSigner,
  });

  return {
    tier,
    dkimResult: dkim.result,
    selector: dkim.selector,
    dDomain: dkim.dDomain,
    publicKeyUsed: dkim.publicKeyUsed,
    hTagCoversTo: dkim.hTagCoversTo,
    lTagPresent: dkim.lTagPresent,
    fromAddr: original.fromAddr,
    toAddr: original.toAddr,
    subject: original.subject,
    sentAt: original.date,
  };
}
