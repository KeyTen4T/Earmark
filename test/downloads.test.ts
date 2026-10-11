import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs, beginFile, bookKey, chapterSource, createBook, currentFile, enoughSpace, failFile, get,
  isComplete, markForRedownload, MAX_FILE_ATTEMPTS, nextQueued, pause, progressFraction, reconcileAfterRestart,
  remainingBytes, remove, resume, settleFile, start, upsert, usedBytes, verifyFiles,
  type Downloads,
} from '../src/downloads/state';

const files = (...sizes: number[]) => sizes.map((size, i) => ({ id: i + 1, name: `${i + 1}.mp3`, size }));

function enqueue(downloads: Downloads, id: number, hash: string, sizes: number[], now: number): Downloads {
  return upsert(downloads, createBook({ id, hash, name: hash, files: files(...sizes) }, now));
}

// ---- queue ordering ----

test('downloads: a book starts queued with every file pending', () => {
  const b = createBook({ id: 7, hash: 'AB', name: 'Book', files: files(100, 200) });
  assert.equal(b.status, 'queued');
  assert.equal(b.hash, 'ab');
  assert.deepEqual(b.files.map((f) => f.status), ['pending', 'pending']);
  assert.equal(remainingBytes(b), 300);
});

test('downloads: one book at a time, oldest first', () => {
  let d: Downloads = {};
  d = enqueue(d, 1, 'a', [100], 1000);
  d = enqueue(d, 2, 'b', [100], 2000);
  d = enqueue(d, 3, 'c', [100], 3000);
  assert.equal(nextQueued(d)?.hash, 'a');
  d = upsert(d, start(get(d, 'a')!));
  // While 'a' is downloading the queue is blocked and 'b' is next in line.
  assert.equal(nextQueued(d)?.hash, 'b');
  d = upsert(d, resume(get(d, 'a')!)); // resume puts it back in the queue
  assert.equal(nextQueued(d)?.hash, 'a');
});

// ---- resume skips done files ----

test('downloads: resume skips files already done', () => {
  let b = createBook({ id: 1, hash: 'h', name: 'B', files: files(100, 100, 100) });
  b = start(b);
  b = beginFile(b, 1);
  b = settleFile(b, 1, 100);
  b = beginFile(b, 2);
  b = pause(b);
  assert.equal(b.status, 'paused');
  assert.equal(currentFile(b)?.id, 2); // file 1 is done, file 2 still to fetch
  b = resume(b);
  assert.equal(b.status, 'queued');
  assert.deepEqual(b.files.map((f) => f.status), ['done', 'pending', 'pending']);
  assert.equal(remainingBytes(b), 200);
  assert.equal(usedBytes(b), 100);
});

// ---- size mismatch ----

test('downloads: a file is done only on an exact size match', () => {
  const b = createBook({ id: 1, hash: 'h', name: 'B', files: files(500) });
  const short = settleFile(b, 1, 499);
  assert.equal(short.files[0].status, 'pending'); // not done, retry queued
  assert.equal(short.files[0].attempts, 1);
  const exact = settleFile(b, 1, 500);
  assert.equal(exact.files[0].status, 'done');
  assert.ok(isComplete(exact));
});

test('downloads: verifyFiles drops done files whose bytes no longer match', () => {
  const b = { ...createBook({ id: 1, hash: 'h', name: 'B', files: files(100, 100) }), status: 'complete' as const,
    files: [{ id: 1, name: '1.mp3', size: 100, status: 'done' as const, received: 100, attempts: 0 },
            { id: 2, name: '2.mp3', size: 100, status: 'done' as const, received: 100, attempts: 0 }] };
  const verified = verifyFiles(b, { 1: 100, 2: 42 });
  assert.equal(verified.files[0].status, 'done');
  assert.equal(verified.files[1].status, 'pending');
  assert.equal(verified.status, 'paused'); // no longer complete; waits for a resume
});

// ---- disk space ----

test('downloads: unknown free space does not block, a genuinely full disk does', () => {
  assert.equal(enoughSpace(null, 100, 50), true); // unknown: cannot tell, so don't block
  assert.equal(enoughSpace(0, 100, 50), false); // full disk (0 bytes) must fail
  assert.equal(enoughSpace(150, 100, 50), true); // exactly needed plus margin
  assert.equal(enoughSpace(149, 100, 50), false);
  assert.equal(enoughSpace(50, 100, 50), false);
});

// ---- failure / backoff ----

test('downloads: backoff grows and a file fails after the cap', () => {
  assert.ok(backoffMs(1) < backoffMs(2));
  assert.ok(backoffMs(2) < backoffMs(3));
  assert.equal(backoffMs(9), backoffMs(MAX_FILE_ATTEMPTS)); // capped

  let b = createBook({ id: 1, hash: 'h', name: 'B', files: files(100) });
  b = start(b);
  b = beginFile(b, 1);
  for (let i = 1; i < MAX_FILE_ATTEMPTS; i++) {
    b = failFile(b, 1, 'boom');
    assert.equal(b.status, 'downloading', `attempt ${i} still retrying`);
    assert.equal(b.files[0].status, 'pending');
  }
  b = failFile(b, 1, 'boom');
  assert.equal(b.status, 'failed');
  assert.equal(b.files[0].status, 'failed');
  assert.equal(b.error, 'boom');
  // Resuming resets the file so the user gets another full set of attempts.
  b = resume(b);
  assert.equal(b.status, 'queued');
  assert.equal(b.files[0].attempts, 0);
});

// ---- remove while downloading ----

test('downloads: removing the active book leaves the queue for the next one', () => {
  let d: Downloads = {};
  d = enqueue(d, 1, 'a', [100], 1000);
  d = enqueue(d, 2, 'b', [100], 2000);
  d = upsert(d, start(get(d, 'a')!));
  const after = remove(d, 'a');
  assert.equal(get(after, 'a'), undefined);
  assert.equal(nextQueued(after)?.hash, 'b');
  // remove is pure: the original map still holds the removed book.
  assert.ok(get(d, 'a'));
});

// ---- partial book: per-chapter local vs stream ----

test('downloads: a partly downloaded book plays local files where present', () => {
  let b = createBook({ id: 1, hash: 'h', name: 'B', files: files(100, 100, 100) });
  b = start(b);
  b = beginFile(b, 1);
  b = settleFile(b, 1, 100);
  b = beginFile(b, 2);
  b = settleFile(b, 2, 100);
  assert.equal(chapterSource(b, 1), 'local');
  assert.equal(chapterSource(b, 2), 'local');
  assert.equal(chapterSource(b, 3), 'stream');
  assert.equal(chapterSource(undefined, 1), 'stream');
  assert.equal(progressFraction(b), Math.min(1, 200 / 300));

  // Local playback failed for chapter 2: it must be fetched again, not left as done.
  b = markForRedownload(b, 2);
  assert.equal(chapterSource(b, 2), 'stream');
  const complete = [1, 2, 3].reduce((x, id) => settleFile(x, id, 100), start(b));
  assert.ok(isComplete(complete));
  assert.equal(markForRedownload(complete, 1).status, 'paused');
});

// ---- restart reconciliation ----

test('downloads: a stalled book becomes paused, the active one is offered for resume', () => {
  let d: Downloads = {};
  d = enqueue(d, 1, 'a', [100], 1000);
  d = enqueue(d, 2, 'b', [100], 2000);
  d = upsert(d, start(get(d, 'a')!));
  d = upsert(d, beginFile(get(d, 'a')!, 1));
  const { downloads, resume: resumeHashes } = reconcileAfterRestart(d);
  assert.deepEqual(resumeHashes, ['a']);
  assert.equal(get(downloads, 'a')?.status, 'paused');
  assert.deepEqual(get(downloads, 'a')?.files.map((f) => f.status), ['pending']);
  assert.equal(get(downloads, 'b')?.status, 'queued'); // never started, stays queued
  assert.deepEqual(bookKey('AB'), 'ab');
});
