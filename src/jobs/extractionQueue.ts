import { runExtraction, type RunExtractionDeps } from "../extraction/runExtraction.js";

export interface ExtractionQueue {
  /** Create a `pending` run and schedule it. Returns immediately. */
  enqueue(submissionId: string, opts?: { force?: boolean }): Promise<{ runId: string }>;
  /** Resolves once every queued run has finished (tests, shutdown). */
  drain(): Promise<void>;
  /** Re-queue runs left `pending`/`running` by a previous process (call at boot). */
  recover(): Promise<number>;
}

/**
 * In-process, one-at-a-time extraction worker (docs/extraction-hardening.md
 * §5). Extraction takes tens of seconds of CPU plus model calls; the upload
 * that triggers it returns at once with a run in `pending`, and the console
 * polls. Nothing survives a crash except the DB row, which `recover()`
 * re-queues on the next boot — the run is idempotent (re-runnable per PRD
 * §6.2), so a run interrupted mid-way is simply done again.
 */
export function createExtractionQueue(deps: RunExtractionDeps, onError: (err: Error, runId: string) => void): ExtractionQueue {
  const pending: Array<{ runId: string; submissionId: string; force: boolean }> = [];
  let active: Promise<void> | null = null;
  const idleWaiters: Array<() => void> = [];

  const pump = (): void => {
    if (active) return;
    const job = pending.shift();
    if (!job) {
      for (const w of idleWaiters.splice(0)) w();
      return;
    }
    active = runExtraction(deps, job.submissionId, { runId: job.runId, force: job.force })
      .then(() => undefined)
      .catch((err: unknown) => onError(err as Error, job.runId))
      .finally(() => {
        active = null;
        pump();
      });
  };

  return {
    async enqueue(submissionId, opts = {}) {
      const run = await deps.prisma.extractionRun.create({
        data: { submissionId, extractorVersion: deps.extractorVersion, model: deps.visionExtractor.model, status: "pending" },
      });
      pending.push({ runId: run.id, submissionId, force: opts.force ?? false });
      pump();
      return { runId: run.id };
    },
    drain() {
      if (!active && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    async recover() {
      const stale = await deps.prisma.extractionRun.findMany({ where: { status: { in: ["pending", "running"] } }, orderBy: { startedAt: "asc" } });
      for (const run of stale) pending.push({ runId: run.id, submissionId: run.submissionId, force: false });
      pump();
      return stale.length;
    },
  };
}
