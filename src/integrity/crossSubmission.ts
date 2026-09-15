import type { PrismaClient } from "@prisma/client";
import { hammingDistance } from "../extraction/ffmpeg.js";
import type { IntegritySignal } from "./videoSignals.js";

const DUPLICATE_MEDIA_HAMMING_THRESHOLD = 5;

/**
 * PRD §7 DUPLICATE_MEDIA. Exact-hash duplicates can never reach this check —
 * dropbox/sync.ts and the manual-upload route already refuse to create a
 * second submission for a content hash that's archived (PRD §6.1/§6.2). This
 * catches near-duplicates instead: the same recording re-encoded, trimmed,
 * or re-exported and resubmitted.
 *
 * Scans every other media asset with a stored perceptual hash in memory —
 * fine at the "modest volume" this project is scoped for (PRD D3); an
 * indexed nearest-neighbour lookup would be the fix once that stops holding.
 */
export async function checkDuplicateMedia(
  prisma: PrismaClient,
  mediaAssetId: string,
  dHash: bigint,
): Promise<IntegritySignal | null> {
  const others = await prisma.mediaAsset.findMany({ where: { id: { not: mediaAssetId } } });

  for (const other of others) {
    const meta = other.sourceMeta as { dHash?: string } | null;
    if (!meta?.dHash) continue;
    const distance = hammingDistance(dHash, BigInt(`0x${meta.dHash}`));
    if (distance <= DUPLICATE_MEDIA_HAMMING_THRESHOLD) {
      return {
        code: "DUPLICATE_MEDIA",
        severity: "high",
        detail: `Perceptually matches media asset ${other.id} (Hamming distance ${distance})`,
      };
    }
  }
  return null;
}

/** PRD §7 SHARED_ROWS. */
export async function checkSharedRows(
  prisma: PrismaClient,
  extractionRunId: string,
  participantId: string,
  rowKeys: string[],
): Promise<IntegritySignal | null> {
  if (rowKeys.length === 0) return null;

  const matches = await prisma.transactionRow.findMany({
    where: {
      rowKey: { in: rowKeys },
      extractionRunId: { not: extractionRunId },
      extractionRun: { submission: { enrollment: { participantId: { not: participantId } } } },
    },
    include: { extractionRun: { include: { submission: { include: { enrollment: true } } } } },
    take: 50,
  });
  if (matches.length === 0) return null;

  const otherParticipants = new Set(matches.map((m) => m.extractionRun.submission.enrollment.participantId));
  return {
    code: "SHARED_ROWS",
    severity: "high",
    detail: `${matches.length} row(s) also appear in submissions from ${otherParticipants.size} other participant(s)`,
  };
}
