import type { SyncDeps } from "../dropbox/sync.js";
import { syncDropbox } from "../dropbox/sync.js";

/**
 * Fallback for missed webhook notifications (PRD §6.1). Runs syncDropbox on
 * an interval; a failed run is logged and retried on the next tick rather
 * than crashing the process.
 */
export function startDropboxPolling(
  deps: SyncDeps,
  intervalMs: number,
  onError: (err: unknown) => void = console.error,
): { stop: () => void } {
  const timer = setInterval(() => {
    syncDropbox(deps).catch(onError);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
