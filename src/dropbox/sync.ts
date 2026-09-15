import type { PrismaClient } from "@prisma/client";
import type { DropboxClient } from "./types.js";
import type { ObjectStore } from "../storage/objectStore.js";
import { sha256Hex } from "../lib/hash.js";
import { handleWagerRecordingSubmitted } from "../enrollment/wagerRecordingIngested.js";
import { runExtraction } from "../extraction/runExtraction.js";
import type { VisionExtractor } from "../extraction/visionExtractor.js";
import type { AppDeps } from "../app.js";

export interface AutoExtractConfig {
  visionExtractor: VisionExtractor;
  extractorVersion: string;
  frameIntervalSeconds: number;
  dedupHammingThreshold: number;
}

export interface SyncDeps {
  prisma: PrismaClient;
  dropbox: DropboxClient;
  objectStore: ObjectStore;
  intakeRoot: string;
  /** When set, extraction runs automatically right after a wager recording is archived. */
  autoExtract?: AutoExtractConfig;
}

/** Shared by the webhook handler and the polling job so their SyncDeps never drift apart. */
export function buildSyncDeps(deps: AppDeps): SyncDeps {
  return {
    prisma: deps.prisma,
    dropbox: deps.dropbox,
    objectStore: deps.objectStore,
    intakeRoot: deps.intakeRoot,
    autoExtract: deps.autoExtractOnIngest
      ? {
          visionExtractor: deps.visionExtractor,
          extractorVersion: deps.extractorVersion,
          frameIntervalSeconds: deps.frameIntervalSeconds,
          dedupHammingThreshold: deps.dedupHammingThreshold,
        }
      : undefined,
  };
}

export interface SyncResult {
  ingested: number;
  skipped: number;
}

const CURSOR_ID = "default";

/**
 * Cursor-based ingest of new files under the intake root (PRD §6.1): list
 * changes since the stored cursor, archive each new file into the object
 * store keyed by content hash, record it, then purge the Dropbox copy.
 * Idempotent — safe to call from both the webhook handler and the polling
 * fallback, and safe to be invoked concurrently or re-run on the same cursor.
 */
export async function syncDropbox(deps: SyncDeps): Promise<SyncResult> {
  const { prisma, dropbox, objectStore, intakeRoot } = deps;

  const cursorRow = await prisma.dropboxCursor.findUnique({ where: { id: CURSOR_ID } });
  let cursor = cursorRow?.cursor ?? undefined;

  let ingested = 0;
  let skipped = 0;

  while (true) {
    const page = await dropbox.listFolder(intakeRoot, cursor);

    for (const entry of page.entries) {
      if (!entry.isFile) continue;

      const enrollmentId = extractEnrollmentId(entry.pathLower, intakeRoot);
      if (!enrollmentId) {
        skipped++;
        continue;
      }

      const data = await dropbox.download(entry.pathLower);
      const contentHash = sha256Hex(data);

      const existing = await prisma.mediaAsset.findUnique({ where: { contentHash } });
      if (existing) {
        // Already archived (e.g. webhook + poll raced, or a retried purge).
        skipped++;
        await safeDelete(dropbox, entry.pathLower);
        continue;
      }

      const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId } });
      if (!enrollment) {
        // Path doesn't map to a known enrollment; leave it for manual triage
        // rather than silently dropping or purging it.
        skipped++;
        continue;
      }

      await objectStore.put(contentHash, data);

      const { submissionId, advancedToWagerSubmitted } = await prisma.$transaction(async (tx) => {
        const mediaAsset = await tx.mediaAsset.create({
          data: { blobKey: contentHash, contentHash, bytes: data.byteLength },
        });
        const submission = await tx.submission.create({
          data: {
            enrollmentId,
            kind: "wager_recording",
            channel: "dropbox",
            mediaAssetId: mediaAsset.id,
            contentHash,
          },
        });

        const { advancedToWagerSubmitted } = await handleWagerRecordingSubmitted(
          tx,
          enrollment,
          submission.id,
          "dropbox-sync",
        );
        return { submissionId: submission.id, advancedToWagerSubmitted };
      });

      ingested++;
      // Only purge after the archive write has committed (PRD §6.1: Dropbox
      // is transport, not storage). A failed purge just leaves the file for
      // the next poll — the contentHash dedup above prevents double-ingest.
      await safeDelete(dropbox, entry.pathLower);

      if (advancedToWagerSubmitted && deps.autoExtract) {
        try {
          await runExtraction(
            {
              prisma,
              objectStore,
              visionExtractor: deps.autoExtract.visionExtractor,
              extractorVersion: deps.autoExtract.extractorVersion,
              frameIntervalSeconds: deps.autoExtract.frameIntervalSeconds,
              dedupHammingThreshold: deps.autoExtract.dedupHammingThreshold,
            },
            submissionId,
          );
        } catch (err) {
          console.error(`Auto-extraction failed for submission ${submissionId}:`, err);
        }
      }
    }

    cursor = page.cursor;
    await prisma.dropboxCursor.upsert({
      where: { id: CURSOR_ID },
      create: { id: CURSOR_ID, cursor },
      update: { cursor },
    });

    if (!page.hasMore) break;
  }

  return { ingested, skipped };
}

function extractEnrollmentId(pathLower: string, intakeRoot: string): string | null {
  const root = intakeRoot.toLowerCase().replace(/\/$/, "");
  if (!pathLower.startsWith(`${root}/`)) return null;
  const rest = pathLower.slice(root.length + 1);
  const [enrollmentId] = rest.split("/");
  return enrollmentId || null;
}

async function safeDelete(dropbox: DropboxClient, pathLower: string): Promise<void> {
  try {
    await dropbox.deleteFile(pathLower);
  } catch (err) {
    console.error(`Failed to purge Dropbox file ${pathLower}:`, err);
  }
}
