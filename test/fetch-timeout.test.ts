import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, TimeoutError } from '../src/fetch-timeout';

const ok = { ok: true, status: 200 } as any;

const resolves = (ms: number) => (async (_url: string, _init?: RequestInit) => {
  await new Promise((r) => setTimeout(r, ms));
  return ok;
}) as unknown as typeof fetch;

// A fetch that hangs until its signal aborts, rejecting the way fetch does.
const hangsUntilAborted = ((_url: string, init?: RequestInit) => new Promise<any>((_resolve, reject) => {
  const signal = init?.signal;
  const abort = () => { const e = new Error('Aborted'); e.name = 'AbortError'; reject(e); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort);
})) as unknown as typeof fetch;

test('fetchWithTimeout: resolves when the request is in time', async () => {
  const res = await fetchWithTimeout('https://x', {}, 100, resolves(5));
  assert.equal(res.ok, true);
});

test('fetchWithTimeout: throws a distinguishable TimeoutError on timeout', async () => {
  await assert.rejects(
    fetchWithTimeout('https://x', {}, 10, hangsUntilAborted),
    (e: any) => e instanceof TimeoutError && e.name === 'TimeoutError',
  );
});

test('fetchWithTimeout: a caller abort is not reported as a timeout', async () => {
  const ctl = new AbortController();
  const p = fetchWithTimeout('https://x', { signal: ctl.signal }, 10_000, hangsUntilAborted);
  ctl.abort();
  await assert.rejects(p, (e: any) => e.name === 'AbortError' && !(e instanceof TimeoutError));
});

test('fetchWithTimeout: clears its timer when the request settles', async () => {
  const real = globalThis.clearTimeout;
  let cleared = 0;
  (globalThis as any).clearTimeout = (...args: any[]) => { cleared++; return (real as any)(...args); };
  try {
    await fetchWithTimeout('https://x', {}, 1000, resolves(0));
    assert.ok(cleared >= 1, 'the timeout timer was cleared');
  } finally {
    globalThis.clearTimeout = real;
  }
});
