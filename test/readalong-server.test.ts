import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseBuildPath, normalizeServerUrl, serverEndpoint, errorForStatus, networkErrorMessage,
  validateJob, validateJobSummary, isJobStatus, jobRunning, ServerError,
  type ServerJob,
} from '../src/readalong/server';
import {
  addPending, clearPending, pendingFor, pendingOutcome, type PendingJobs,
} from '../src/readalong/pending';
import type { ReadalongRecord } from '../src/readalong/anchors';

// --------------------------------------------------------------------------------------
// URL joining
// --------------------------------------------------------------------------------------

test('normalizeServerUrl adds the /readalong prefix and drops trailing slashes', () => {
  assert.equal(normalizeServerUrl('https://h/readalong'), 'https://h/readalong');
  assert.equal(normalizeServerUrl('https://h/readalong/'), 'https://h/readalong');
  assert.equal(normalizeServerUrl('https://h/readalong//'), 'https://h/readalong');
  assert.equal(normalizeServerUrl('https://h'), 'https://h/readalong');
  assert.equal(normalizeServerUrl('https://h/'), 'https://h/readalong');
  assert.equal(normalizeServerUrl('  https://h:8443/readalong  '), 'https://h:8443/readalong');
  assert.equal(normalizeServerUrl(''), '');
});

test('serverEndpoint joins the normalised URL and a path with or without a slash', () => {
  assert.equal(serverEndpoint('https://h/readalong/', '/v1/jobs'), 'https://h/readalong/v1/jobs');
  assert.equal(serverEndpoint('https://h', 'v1/jobs'), 'https://h/readalong/v1/jobs');
  assert.equal(serverEndpoint('https://h/readalong', '/v1/health'), 'https://h/readalong/v1/health');
});

// --------------------------------------------------------------------------------------
// Error mapping
// --------------------------------------------------------------------------------------

test('errorForStatus maps each status to a readable message', () => {
  assert.match(errorForStatus(400), /rejected the request/);
  assert.match(errorForStatus(400, 'paragraphsSha1 does not match'), /paragraphsSha1 does not match/);
  assert.match(errorForStatus(401), /rejected the token/);
  assert.match(errorForStatus(404), /no job for that book/);
  assert.match(errorForStatus(413), /too large/);
  assert.match(errorForStatus(429), /busy/);
  assert.match(errorForStatus(500), /HTTP 500/);
});

test('networkErrorMessage names the server and never leaks a bare exception', () => {
  assert.match(networkErrorMessage(), /Could not reach the read-along server/);
  assert.match(networkErrorMessage(new Error('fetch failed')), /fetch failed/);
});

// --------------------------------------------------------------------------------------
// Response validation
// --------------------------------------------------------------------------------------

const record: ReadalongRecord = {
  epub: { hash: 'a'.repeat(40), fileId: 3, title: 'Dune', paragraphs: 4, paragraphsSha1: 'z' },
  files: [{ id: 7, duration: 10, anchors: [[0, 0, 0]] }],
  created: 1000,
};

test('validateJobSummary accepts a queue response and rejects malformed ones', () => {
  assert.deepEqual(validateJobSummary({ id: 'abc', status: 'queued', position: 2 }),
    { id: 'abc', status: 'queued', position: 2 });
  assert.throws(() => validateJobSummary({ status: 'queued' }), ServerError);
  assert.throws(() => validateJobSummary({ id: 'abc', status: 'nonsense' }), /unknown job status/);
  assert.throws(() => validateJobSummary(null), /unexpected response/);
});

test('validateJob normalises a job and rejects a malformed one', () => {
  const job = validateJob({ id: 'abc', status: 'building', done: 3, total: 10, matched: 2, error: null, record });
  assert.equal(job.status, 'building');
  assert.equal(job.done, 3);
  assert.equal(job.total, 10);
  assert.equal(job.record, null, 'a running job never exposes the record');
  assert.equal(job.error, null);

  // A done job must carry a usable record.
  assert.throws(() => validateJob({ id: 'abc', status: 'done' }), /malformed record/);
  assert.throws(() => validateJob({ id: 'abc', status: 'done', record: { epub: {} } }), /malformed record/);

  const done = validateJob({ id: 'abc', status: 'done', matched: 8, total: 10, record });
  assert.equal(done.record?.epub.title, 'Dune');
  assert.equal(done.matched, 8);

  // Missing/unknown status is rejected.
  assert.throws(() => validateJob({ id: 'abc' }), /unknown job status/);
  assert.throws(() => validateJob('not a job'), /unexpected response/);
});

test('job status helpers agree on which states are running', () => {
  assert.ok(isJobStatus('downloading'));
  assert.ok(!isJobStatus('finished'));
  for (const s of ['queued', 'running', 'downloading', 'building'] as const) assert.ok(jobRunning(s), s);
  for (const s of ['done', 'failed', 'cancelled'] as const) assert.ok(!jobRunning(s), s);
});

// --------------------------------------------------------------------------------------
// Pending-job store logic
// --------------------------------------------------------------------------------------

const runningJob: ServerJob = {
  id: 'j1', status: 'building', position: 1, done: 1, total: 10, matched: 0,
  bytes: 0, bytesTotal: 0, error: null, record: null, createdAt: 1, updatedAt: 2,
};

test('pending store adds, finds and clears per book', () => {
  let all: PendingJobs = {};
  all = addPending(all, 'ABC123', 'job-1', 111);
  assert.deepEqual(pendingFor(all, 'abc123'), { jobId: 'job-1', submittedAt: 111 });
  assert.deepEqual(pendingFor(all, 'ABC123'), { jobId: 'job-1', submittedAt: 111 });
  assert.equal(pendingFor(all, 'other'), null);

  all = addPending(all, 'other', 'job-2', 222);
  assert.equal(Object.keys(all).length, 2);

  const cleared = clearPending(all, 'ABC123');
  assert.equal(pendingFor(cleared, 'abc123'), null);
  assert.deepEqual(pendingFor(cleared, 'other'), { jobId: 'job-2', submittedAt: 222 });
  assert.equal(clearPending(cleared, 'missing'), cleared, 'clearing an absent entry is a no-op');
});

test('pendingOutcome hands a done job its record to save', () => {
  const done: ServerJob = { ...runningJob, status: 'done', record };
  assert.deepEqual(pendingOutcome(done), { kind: 'done', record });

  assert.deepEqual(pendingOutcome(runningJob), { kind: 'pending', status: 'building' });
  assert.deepEqual(pendingOutcome({ ...runningJob, status: 'failed', error: 'boom' }),
    { kind: 'failed', message: 'boom' });
  assert.deepEqual(pendingOutcome({ ...runningJob, status: 'cancelled' }), { kind: 'cancelled' });
});

test('pending store flows a job from submitted to saved record then cleared', () => {
  // Submit: remember it.
  let all: PendingJobs = addPending({}, 'book', 'job-9', 1);
  const entry = pendingFor(all, 'book')!;
  assert.equal(entry.jobId, 'job-9');

  // Poll: still running, keep it.
  assert.equal(pendingOutcome({ ...runningJob, id: entry.jobId }).kind, 'pending');
  assert.equal(pendingFor(all, 'book')!.jobId, 'job-9');

  // Finish: the record is handed to saveReadalong, and the entry is cleared.
  const outcome = pendingOutcome({ ...runningJob, id: entry.jobId, status: 'done', record });
  assert.equal(outcome.kind, 'done');
  const saved = outcome.kind === 'done' ? outcome.record : null;
  assert.equal(saved?.epub.title, 'Dune');
  all = clearPending(all, 'book');
  assert.equal(pendingFor(all, 'book'), null);
});

// --------------------------------------------------------------------------------------
// Build path choice
// --------------------------------------------------------------------------------------

test('chooseBuildPath prefers local, then a server, then nothing', () => {
  assert.equal(chooseBuildPath(true, true), 'local');
  assert.equal(chooseBuildPath(true, false), 'local');
  assert.equal(chooseBuildPath(false, true), 'server');
  assert.equal(chooseBuildPath(false, false), 'none');
});
