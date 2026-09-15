import type { PrismaClient } from "@prisma/client";
import type { DNSResolver } from "mailauth";
import { parseInboundEmail, parseOriginalHeaders } from "./parseMime.js";
import { verifyDkim } from "./dkim.js";
import { tierForAttachedOriginal, tierForNoAttachment } from "./tier.js";
import { buildAutoReplyMessage, type EmailSender } from "./sender.js";
import { recordTransition } from "../enrollment/decisions.js";
import { sha256Hex } from "../lib/hash.js";
import type { ObjectStore } from "../storage/objectStore.js";

export interface InboundEmailDeps {
  prisma: PrismaClient;
  objectStore: ObjectStore;
  emailSender: EmailSender;
  /** Injected in tests; real DNS is used when omitted. */
  dkimResolver?: DNSResolver;
}

export type InboundEmailOutcome =
  | { status: "unmatched"; reason: string; fromAddr?: string }
  | { status: "auto_replied"; enrollmentId: string }
  | { status: "duplicate"; enrollmentId: string }
  | { status: "verified"; enrollmentId: string; tier: string; dkimResult: string };

const PENDING_EMAIL_STATES = ["invited", "email_submitted"];

/**
 * Handles one inbound message to the intake mailbox (PRD §7.2): match it to
 * an enrollment by the forwarding participant's registered address, extract
 * the attached original (if present), verify its DKIM signature, and record
 * an EmailEvidence row. Mirrors dropbox/sync.ts's role for the Dropbox path —
 * this is the analogous ingest core for email evidence.
 */
export async function handleInboundEmail(
  deps: InboundEmailDeps,
  rawOuterEmail: Buffer,
): Promise<InboundEmailOutcome> {
  const { prisma, objectStore, emailSender, dkimResolver } = deps;
  const outer = await parseInboundEmail(rawOuterEmail);

  if (!outer.fromAddr) {
    await logUnmatched(prisma, "no_from_address", "unknown");
    return { status: "unmatched", reason: "no_from_address" };
  }

  const participants = await prisma.participant.findMany({
    where: { email: { equals: outer.fromAddr, mode: "insensitive" } },
  });
  if (participants.length === 0) {
    await logUnmatched(prisma, "no_participant", outer.fromAddr);
    return { status: "unmatched", reason: "no_participant", fromAddr: outer.fromAddr };
  }

  const candidates = await prisma.enrollment.findMany({
    where: {
      participantId: { in: participants.map((p) => p.id) },
      state: { in: PENDING_EMAIL_STATES },
    },
    orderBy: { createdAt: "desc" },
  });

  if (candidates.length === 0) {
    await logUnmatched(prisma, "no_pending_enrollment", outer.fromAddr);
    return { status: "unmatched", reason: "no_pending_enrollment", fromAddr: outer.fromAddr };
  }
  if (candidates.length > 1) {
    // Ambiguous by design — the participant has more than one enrollment
    // simultaneously awaiting a signup email. Staff must resolve manually;
    // PRD §6.5's "self-attributing" mechanism assumes one pending enrollment.
    await logUnmatched(prisma, "ambiguous_enrollment", outer.fromAddr);
    return { status: "unmatched", reason: "ambiguous_enrollment", fromAddr: outer.fromAddr };
  }

  const enrollment = candidates[0]!;

  if (!outer.attachedOriginal) {
    await emailSender.send(buildAutoReplyMessage(outer.fromAddr, enrollment.casino));
    if (enrollment.state === "invited") {
      await prisma.$transaction((tx) =>
        recordTransition(tx, {
          enrollmentId: enrollment.id,
          toState: "email_submitted",
          actor: "system",
          note: `Inbound email received without an attached original (tier ${tierForNoAttachment(outer.hasImageAttachment)}); auto-reply sent`,
        }),
      );
    }
    return { status: "auto_replied", enrollmentId: enrollment.id };
  }

  const contentHash = sha256Hex(outer.attachedOriginal);
  const existingMedia = await prisma.mediaAsset.findUnique({ where: { contentHash } });
  if (existingMedia) {
    return { status: "duplicate", enrollmentId: enrollment.id };
  }

  const dkim = await verifyDkim(outer.attachedOriginal, dkimResolver);
  const original = await parseOriginalHeaders(outer.attachedOriginal);

  const allowedSigner = dkim.dDomain
    ? await prisma.dkimAllowedSigner.findFirst({
        where: { casino: enrollment.casino, domain: dkim.dDomain },
      })
    : null;
  const tier = tierForAttachedOriginal({
    dkimResult: dkim.result,
    hTagCoversTo: dkim.hTagCoversTo,
    signerAllowlisted: !!allowedSigner,
  });

  await objectStore.put(contentHash, outer.attachedOriginal);

  await prisma.$transaction(async (tx) => {
    const mediaAsset = await tx.mediaAsset.create({
      data: {
        blobKey: contentHash,
        contentHash,
        bytes: outer.attachedOriginal!.byteLength,
        mime: "message/rfc822",
      },
    });
    const submission = await tx.submission.create({
      data: {
        enrollmentId: enrollment.id,
        kind: "signup_email",
        channel: "email",
        mediaAssetId: mediaAsset.id,
        contentHash,
      },
    });
    await tx.emailEvidence.create({
      data: {
        submissionId: submission.id,
        tier,
        dkimResult: dkim.result,
        selector: dkim.selector,
        dDomain: dkim.dDomain,
        publicKeyUsed: dkim.publicKeyUsed,
        verifiedAt: new Date(),
        hTagCoversTo: dkim.hTagCoversTo,
        lTagPresent: dkim.lTagPresent,
        fromAddr: original.fromAddr,
        toAddr: original.toAddr,
        subject: original.subject,
        sentAt: original.date,
      },
    });

    if (enrollment.state === "invited") {
      await recordTransition(tx, {
        enrollmentId: enrollment.id,
        toState: "email_submitted",
        actor: "system",
        note: "Inbound email received with an attached original",
      });
    }
    await recordTransition(tx, {
      enrollmentId: enrollment.id,
      toState: "email_verified",
      actor: "system",
      note: `DKIM verification ran: ${dkim.result} (tier ${tier})`,
    });
  });

  return { status: "verified", enrollmentId: enrollment.id, tier, dkimResult: dkim.result };
}

async function logUnmatched(prisma: PrismaClient, reason: string, fromAddr: string): Promise<void> {
  await prisma.auditEvent.create({
    data: { actor: "system", action: `inbound_email_unmatched:${reason}`, target: fromAddr },
  });
}
