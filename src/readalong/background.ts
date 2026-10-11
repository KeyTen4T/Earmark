// App-level handling of read-along jobs submitted to the server. The sheet submits a job and
// remembers it in storage; this module checks the remembered jobs when the app starts, returns to
// the foreground, or opens a book. When one is `done`, its record is saved locally (the safeguard
// against the sync gist being overwritten) and the pending entry is cleared.
//
// Not imported by the Node tests (it touches storage and the toast UI); the pure decisions live in
// pending.ts.

import { getJob, ServerError, type ServerJob } from './server';
import { clearPending, pendingOutcome, type PendingJobs } from './pending';
import { loadPendingJobs, savePendingJobs, saveReadalong } from '../storage';
import { toast } from '../components/ui';

/** Errors from finished-but-failed jobs, kept in memory so the sheet can show them after the
 * pending entry has been cleared. */
const lastErrors = new Map<string, string>();

export const pendingError = (hash: string): string => lastErrors.get(hash.toLowerCase()) ?? '';
export const clearPendingError = (hash: string): void => { lastErrors.delete(hash.toLowerCase()); };

/** Fetch one pending job and fold its outcome into the map. Returns the (maybe new) map. */
async function processOne(all: PendingJobs, hash: string): Promise<PendingJobs> {
  const entry = all[hash];
  if (!entry) return all;

  let job: ServerJob;
  try {
    job = await getJob(entry.jobId);
  } catch (e) {
    // A 404 means the server forgot the job; anything else (offline, bad token) is retried later.
    return e instanceof ServerError && e.status === 404 ? clearPending(all, hash) : all;
  }

  const outcome = pendingOutcome(job);
  if (outcome.kind === 'done') {
    await saveReadalong(hash, outcome.record);
    lastErrors.delete(hash);
    toast(`Read-along ready: ${job.matched} of ${job.total} clips matched`);
    return clearPending(all, hash);
  }
  if (outcome.kind === 'failed') {
    lastErrors.set(hash, outcome.message);
    return clearPending(all, hash);
  }
  if (outcome.kind === 'cancelled') {
    lastErrors.delete(hash);
    return clearPending(all, hash);
  }
  return all;
}

/** Check every remembered job once. Called when the app starts and returns to the foreground. */
export async function reconcilePendingJobs(): Promise<void> {
  const all = await loadPendingJobs();
  let next = all;
  for (const hash of Object.keys(all)) next = await processOne(next, hash);
  if (next !== all) await savePendingJobs(next);
}

/** Check the remembered job for one book. Called when the player opens a book. */
export async function checkPendingForBook(hash: string): Promise<void> {
  const all = await loadPendingJobs();
  const next = await processOne(all, hash.toLowerCase());
  if (next !== all) await savePendingJobs(next);
}
