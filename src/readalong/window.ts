// Pure window maths for the read-along FlatList.
//
// A 3,000-paragraph book cannot be handed to FlatList as one list: a jump from the top to the
// current paragraph asks `scrollToIndex` for a row that was never rendered, so it fails. Rendering
// a moving slice keeps the current paragraph a fixed ~30 rows from the top of the slice, so every
// scroll target is already measured. This module holds the arithmetic; it has no react-native
// imports so it is unit-tested directly.
//
// The window is recentred only when the current paragraph approaches an edge (so ordinary reading
// never re-renders the slice) or when it jumps outside the window entirely (a seek). While the user
// browses by hand the window is instead grown outward (`growWindow`): it only ever adds rows toward
// the edge they reach, so it never moves the rows under their scroll offset.

/** Rows kept above / below the current paragraph when the window is centred. */
export const WINDOW_BEHIND = 30;
export const WINDOW_AHEAD = 60;
/** How close the current paragraph may get to an edge before the window is re-centred. */
export const WINDOW_EDGE = 10;
/** Rows added above / below the slice in one browsing step when the reader reaches an edge. */
export const WINDOW_CHUNK = 60;

export type WindowRange = { start: number; end: number };

function clampIndex(i: number, N: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(N - 1, Math.floor(i)));
}

/** The centred window around `current`, clamped to [0, N). Empty when `N <= 0`. */
export function computeWindow(current: number, N: number, _prev?: WindowRange | null): WindowRange {
  if (N <= 0) return { start: 0, end: 0 };
  const c = clampIndex(current, N);
  return { start: Math.max(0, c - WINDOW_BEHIND), end: Math.min(N, c + WINDOW_AHEAD) };
}

/**
 * Whether `current` has fallen outside `prev`, or within `WINDOW_EDGE` rows of one of its edges.
 * A missing/empty previous window always wants recentring, so the first layout is centred.
 */
export function shouldRecentre(current: number, N: number, prev?: WindowRange | null): boolean {
  if (N <= 0) return false;
  if (!prev || prev.end <= prev.start) return true;
  const c = clampIndex(current, N);
  if (c < prev.start || c >= prev.end) return true;
  return c - prev.start < WINDOW_EDGE || (prev.end - 1) - c < WINDOW_EDGE;
}

/**
 * Extends `prev` toward whichever edge the visible rows have reached, and only ever grows: rows are
 * appended below when `last` is within `WINDOW_EDGE` of the bottom, prepended above when `first` is
 * within `WINDOW_EDGE` of the top. Returns `prev` unchanged in the middle, for an empty book, or
 * when that edge is already the book's start/end.
 *
 * Unlike `computeWindow`, this never re-centres and so never drops rows out from under the reader's
 * scroll offset. Re-centring on the visible row while browsing was a runaway: it pulled the slice
 * past the row, which landed the viewport at the new edge and grew again, racing through the book
 * with most of the list unrendered.
 */
export function growWindow(first: number, last: number, N: number, prev: WindowRange): WindowRange {
  if (N <= 0 || prev.end <= prev.start) return prev;
  let { start, end } = prev;
  if (last >= end - 1 - WINDOW_EDGE && end < N) end = Math.min(N, end + WINDOW_CHUNK);
  if (first <= start + WINDOW_EDGE && start > 0) start = Math.max(0, start - WINDOW_CHUNK);
  if (start === prev.start && end === prev.end) return prev;
  return { start, end };
}
