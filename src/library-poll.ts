// After a book is sent to TorBox it can take a while to show up in the account's list (and a cached
// one is briefly listed as finished with no files, which the audiobook filter hides). Until it shows,
// the library is re-read on a short timer. Pure, so the Node tests can run it.

export const ADD_POLL_MS = 4_000;
/** How long to keep looking for a book whose hash is known. */
export const ADD_WAIT_MS = 3 * 60_000;
/** How long to keep re-reading after an add with no hash to look for (a pasted magnet or .torrent). */
export const ADD_BLIND_MS = 45_000;

export type Awaited = { hashes: string[]; until: number };
export const NOT_WAITING: Awaited = { hashes: [], until: 0 };

/** Start (or extend) the wait for a book that was just added. */
export function awaitAdded(a: Awaited, hash: string | undefined, now: number): Awaited {
  const h = hash?.toLowerCase();
  const hashes = h && !a.hashes.includes(h) ? [...a.hashes, h] : a.hashes;
  return { hashes, until: Math.max(a.until, now + (h ? ADD_WAIT_MS : ADD_BLIND_MS)) };
}

/** Drop the books that have arrived; the wait ends when its time is up or every known one is listed. */
export function settleAwaited(a: Awaited, listed: (string | undefined)[], now: number): Awaited {
  if (now >= a.until) return NOT_WAITING;
  const have = new Set(listed.map((h) => h?.toLowerCase()));
  const hadHashes = a.hashes.length > 0;
  const hashes = a.hashes.filter((h) => !have.has(h));
  return hadHashes && !hashes.length ? NOT_WAITING : { hashes, until: a.until };
}

export const stillWaiting = (a: Awaited, now: number): boolean => now < a.until;
