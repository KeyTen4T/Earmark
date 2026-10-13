// A promise-chain mutex for read-modify-write storage. `serial(fn)` runs async functions one at a
// time, in the order they were called, and returns fn's own result. A rejection propagates to that
// caller but never blocks or rejects the next task, so one failed write can't wedge the queue.
//
// Pure: no react-native or expo imports, so the Node test runner can exercise it and every module
// that touches the same keys (storage, hardcover, …) shares this one chain.

let tail: Promise<void> = Promise.resolve();

export function serial<T>(fn: () => Promise<T> | T): Promise<T> {
  const result = tail.then(fn);
  // Only the caller sees a rejection; the chain carries on regardless.
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
