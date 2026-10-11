// Pending server builds, remembered per audiobook hash. A device keeps `{jobId, submittedAt}`
// here while the server works, so it can find the result again after the sheet closes or the app
// restarts (and save it locally even if the sync gist was overwritten — the "gist race" safeguard).
//
// Pure: no react-native/expo imports, so it runs under the Node test runner. The storage calls
// live in storage.ts; background.ts drives the async checking.

import type { ReadalongRecord } from './anchors';
import type { JobStatus, ServerJob } from './server';

export type PendingJob = { jobId: string; submittedAt: number };
export type PendingJobs = Record<string, PendingJob>;

/** Add or replace the pending job for a book. Pure. */
export function addPending(all: PendingJobs, hash: string, jobId: string, submittedAt = Date.now()): PendingJobs {
  return { ...all, [hash.toLowerCase()]: { jobId, submittedAt } };
}

/** Forget a book's pending job. Returns the same object when there was nothing to clear. Pure. */
export function clearPending(all: PendingJobs, hash: string): PendingJobs {
  const key = hash.toLowerCase();
  if (!(key in all)) return all;
  const next = { ...all };
  delete next[key];
  return next;
}

/** The pending job for a book, or null. Pure. */
export function pendingFor(all: PendingJobs, hash: string): PendingJob | null {
  return all[hash.toLowerCase()] ?? null;
}

/** What a job's latest server state means for the device watching it. */
export type PendingOutcome =
  | { kind: 'pending'; status: JobStatus }
  | { kind: 'done'; record: ReadalongRecord }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

/**
 * Classify a job: still running, finished (with the record to save), failed (with the message to
 * show) or cancelled. A `done` job with no usable record is treated as a failure rather than
 * saving nothing. Pure.
 */
export function pendingOutcome(job: ServerJob): PendingOutcome {
  switch (job.status) {
    case 'done':
      if (!job.record) return { kind: 'failed', message: 'The server finished but sent no read-along record.' };
      return { kind: 'done', record: job.record };
    case 'failed':
      return { kind: 'failed', message: job.error || 'The read-along build failed on the server.' };
    case 'cancelled':
      return { kind: 'cancelled' };
    default:
      return { kind: 'pending', status: job.status };
  }
}
