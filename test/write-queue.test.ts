import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serial } from '../src/write-queue';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test('write queue: runs tasks in call order and returns each result', async () => {
  const order: number[] = [];
  const p1 = serial(async () => { await tick(); order.push(1); return 'a'; });
  const p2 = serial(async () => { order.push(2); return 'b'; });
  const p3 = serial(() => { order.push(3); return 'c'; });
  assert.deepEqual(await Promise.all([p1, p2, p3]), ['a', 'b', 'c']);
  assert.deepEqual(order, [1, 2, 3]);
});

test('write queue: never runs two tasks at once', async () => {
  let active = 0;
  let max = 0;
  const task = (n: number) => serial(async () => {
    active++;
    max = Math.max(max, active);
    await tick();
    active--;
    return n;
  });
  assert.deepEqual(await Promise.all([task(1), task(2), task(3), task(4)]), [1, 2, 3, 4]);
  assert.equal(max, 1);
});

test('write queue: passes through a task return value', async () => {
  assert.equal(await serial(() => 42), 42);
  assert.deepEqual(await serial(async () => ({ ok: true })), { ok: true });
});

test('write queue: a rejection reaches its caller but not the queue', async () => {
  const order: string[] = [];
  const bad = serial(async () => { order.push('bad'); throw new Error('boom'); });
  const good = serial(async () => { order.push('good'); return 'ok'; });
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
  assert.deepEqual(order, ['bad', 'good']);
});

test('write queue: the next task runs even when the caller ignores the rejection', async () => {
  const failed = serial(() => { throw new Error('first'); });
  const next = serial(() => 'second');
  await assert.rejects(failed, /first/);
  assert.equal(await next, 'second');
});
