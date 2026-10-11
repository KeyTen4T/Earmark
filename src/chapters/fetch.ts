// The HTTP half of embedded chapters: a Range reader over a TorBox stream URL, and the one call
// that probes a single-file book for its own chapters. Non-pure (uses fetch), but free of
// react-native/expo imports. A server that ignores Range is treated as "no chapters" rather than
// downloading a whole audiobook, and the whole probe has a fixed time budget.
import { blockCached, readEmbeddedChapters, type EmbeddedChapter, type ReadRange } from './embedded';

/** Nothing may take longer than this in total; the caller is only ever hinting, never waiting. */
export const PROBE_BUDGET_MS = 20_000;

/** The server answered 200 with the whole body: it does not do Range requests. */
class NoRange extends Error {}

export async function fetchEmbeddedChapters(url: string, size: number, fetchImpl: typeof fetch = fetch): Promise<EmbeddedChapter[] | null> {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  let networkError: unknown = null;
  let noRange = false;

  const readRange: ReadRange = async (start, endInclusive) => {
    const left = deadline - Date.now();
    if (left <= 0) { networkError = new Error('embedded chapter probe timed out'); throw networkError; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), left);
    try {
      const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${endInclusive}` }, signal: ctl.signal });
      if (res.status === 200) {
        // The whole file is on its way: stop it and report that this URL can't be ranged.
        noRange = true;
        try { await (res as any).body?.cancel?.(); } catch { /* already gone */ }
        throw new NoRange();
      }
      if (res.status !== 206) { networkError = new Error(`HTTP ${res.status}`); throw networkError; }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      if (!(e instanceof NoRange) && !networkError) networkError = e;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  // Every request is a round trip to the stream host, so read in blocks and reuse them.
  const chapters = await readEmbeddedChapters(blockCached(readRange, size), size);
  if (noRange) return null; // a definitive "no chapters" that is worth caching
  if (chapters === null && networkError) throw networkError; // transient: leave the cache alone
  return chapters;
}
