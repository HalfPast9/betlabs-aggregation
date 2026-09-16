import type { PrismaClient } from "@prisma/client";
import type { ObjectStore } from "../storage/objectStore.js";

const SETTINGS_ID = "default";
const DAY_MS = 24 * 60 * 60 * 1000;

// States reached only after the funding decision — used to recognize
// "signup email evidence for a funded enrollment" for the retention
// exception below, regardless of how far the enrollment has since progressed.
const FUNDED_OR_LATER_STATES = ["funded", "wager_submitted", "wager_verified", "closed"];

export interface RetentionSettingsValue {
  rawMediaRetentionDays: number;
  fundedEmailEvidenceRetentionDays: number;
}

export async function getRetentionSettings(prisma: PrismaClient): Promise<RetentionSettingsValue> {
  const row = await prisma.retentionSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
  return { rawMediaRetentionDays: row.rawMediaRetentionDays, fundedEmailEvidenceRetentionDays: row.fundedEmailEvidenceRetentionDays };
}

export async function setRetentionSettings(
  prisma: PrismaClient,
  values: Partial<RetentionSettingsValue>,
): Promise<RetentionSettingsValue> {
  const row = await prisma.retentionSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...values },
    update: values,
  });
  return { rawMediaRetentionDays: row.rawMediaRetentionDays, fundedEmailEvidenceRetentionDays: row.fundedEmailEvidenceRetentionDays };
}

export interface RetentionJobResult {
  deleted: number;
  skipped: number;
}

/**
 * PRD §9: raw media retained `rawMediaRetentionDays` (default 90), then
 * deleted from the object store — except signup email evidence for a funded
 * enrollment, retained `fundedEmailEvidenceRetentionDays` instead (D9:
 * Betlab's dispute window, "not 90 days"). The row itself, and every
 * structured record derived from it, is kept regardless — only the raw
 * bytes are ever removed ("the structured data is the product; the raw
 * video is the liability").
 */
export async function runRetentionJob(prisma: PrismaClient, objectStore: ObjectStore): Promise<RetentionJobResult> {
  const settings = await getRetentionSettings(prisma);
  const now = Date.now();

  const candidates = await prisma.mediaAsset.findMany({
    where: { deletedAt: null },
    include: { submission: { include: { enrollment: true, extractionRuns: true } } },
  });

  let deleted = 0;
  let skipped = 0;

  for (const asset of candidates) {
    const submission = asset.submission;
    if (!submission) {
      skipped++;
      continue;
    }

    const isFundedSignupEmail =
      submission.kind === "signup_email" && FUNDED_OR_LATER_STATES.includes(submission.enrollment.state);
    const retentionDays = isFundedSignupEmail
      ? settings.fundedEmailEvidenceRetentionDays
      : settings.rawMediaRetentionDays;

    const ageMs = now - asset.createdAt.getTime();
    if (ageMs < retentionDays * DAY_MS) {
      skipped++;
      continue;
    }

    await objectStore.delete(asset.blobKey);
    // Stitched panoramas are the raw recording in another shape — same liability, same window.
    for (const run of submission.extractionRuns) {
      if (run.panoramaBlobKey) {
        await objectStore.delete(run.panoramaBlobKey);
        await prisma.extractionRun.update({ where: { id: run.id }, data: { panoramaBlobKey: null } });
      }
    }
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
    deleted++;
  }

  return { deleted, skipped };
}
