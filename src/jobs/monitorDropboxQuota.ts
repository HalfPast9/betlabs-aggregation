import type { PrismaClient } from "@prisma/client";
import type { DropboxClient } from "../dropbox/client.js";

/**
 * PRD §12 risk: "Dropbox quota fills, uploads silently rejected | Quota
 * monitor with alert threshold." Writes an AuditEvent (visible to staff, and
 * queryable) whenever usage crosses the threshold, rather than only logging
 * — a filled quota otherwise fails silently exactly as the risk describes.
 */
export async function checkDropboxQuota(
  prisma: PrismaClient,
  dropbox: DropboxClient,
  warningThreshold: number,
): Promise<{ usedBytes: number; allocatedBytes: number | null; warned: boolean }> {
  const usage = await dropbox.getSpaceUsage();
  const warned = usage.allocatedBytes !== null && usage.usedBytes / usage.allocatedBytes >= warningThreshold;

  if (warned) {
    await prisma.auditEvent.create({
      data: {
        actor: "system",
        action: "dropbox_quota_warning",
        target: `${usage.usedBytes}/${usage.allocatedBytes}`,
      },
    });
  }

  return { usedBytes: usage.usedBytes, allocatedBytes: usage.allocatedBytes, warned };
}

export function startDropboxQuotaMonitor(
  prisma: PrismaClient,
  dropbox: DropboxClient,
  warningThreshold: number,
  intervalMs: number,
  onError: (err: unknown) => void = console.error,
): { stop: () => void } {
  const timer = setInterval(() => {
    checkDropboxQuota(prisma, dropbox, warningThreshold).catch(onError);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
