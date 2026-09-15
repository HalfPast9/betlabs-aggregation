import type { PrismaClient } from "@prisma/client";
import type { ObjectStore } from "../storage/objectStore.js";
import { runRetentionJob } from "../retention/retentionJob.js";

export function startRetentionSchedule(
  prisma: PrismaClient,
  objectStore: ObjectStore,
  intervalMs: number,
  onError: (err: unknown) => void = console.error,
): { stop: () => void } {
  const timer = setInterval(() => {
    runRetentionJob(prisma, objectStore).catch(onError);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
