// The finished shelf: how finished books are grouped and dated, and how a tap on a star changes a
// rating. Pure: no React Native, Expo or storage imports, so the Node test runner can exercise it.

/** The fields the shelf needs from a finished book. Kept local so this module stays dependency-free. */
export type ShelfBook = { finishedAt?: number };

/** One heading on the shelf: a calendar year (null for undated books) with its books, newest first. */
export type ShelfGroup<T extends ShelfBook> = {
  year: number | null;
  label: string;
  count: number;
  books: T[];
};

/** A real millisecond timestamp. Zero is not one: it is treated as "no date". */
const realAt = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0;

/**
 * The best date a finished book has: its own `finishedAt`, or the progress record's last update for
 * books finished before dates were stored. Never invents one.
 */
export function bookFinishedAt(
  meta?: { finishedAt?: number },
  progress?: { finished?: boolean; updated?: number },
): number | undefined {
  if (realAt(meta?.finishedAt)) return meta.finishedAt;
  if (progress?.finished && realAt(progress.updated)) return progress.updated;
  return undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A finish date as "3 Oct", or '' for an undated book. The shelf adds the "Finished " prefix. */
export function formatFinishedDate(at?: number): string {
  if (!realAt(at)) return '';
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const yearOf = (at?: number): number | null => (realAt(at) ? new Date(at).getFullYear() : null);

/**
 * Finished books grouped by finish year, newest year first and newest book first within a year.
 * Undated books come last in a single "Earlier" group, keeping the order they were given in.
 */
export function shelfGroups<T extends ShelfBook>(books: T[]): ShelfGroup<T>[] {
  const dated: T[] = [];
  const undated: T[] = [];
  for (const b of books) (yearOf(b.finishedAt) === null ? undated : dated).push(b);

  const years = [...new Set(dated.map((b) => yearOf(b.finishedAt) as number))].sort((a, b) => b - a);
  const groups: ShelfGroup<T>[] = years.map((y) => {
    const list = dated
      .filter((b) => yearOf(b.finishedAt) === y)
      .sort((a, b) => (b.finishedAt as number) - (a.finishedAt as number));
    return { year: y, label: `${y} · ${list.length} book${list.length === 1 ? '' : 's'}`, count: list.length, books: list };
  });
  if (undated.length) groups.push({ year: null, label: 'Earlier', count: undated.length, books: undated });
  return groups;
}

/** Rounds to the nearest half step and clamps into the 0.5–5 range. */
export function clampRating(n: number): number {
  return Math.min(5, Math.max(0.5, Math.round(n * 2) / 2));
}

/** A stored rating as a valid half step, or undefined when absent or unusable. */
export function normalizeRating(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0.5) return undefined;
  return clampRating(n);
}

/**
 * The rating a tap on star `star` (1..5) produces. A tap sets that many stars; tapping the star that
 * is already the current whole rating drops it to a half; tapping that same star once more at the
 * half clears the rating if it is the first star, otherwise restores the whole rating.
 */
export function ratingAfterTap(current: number | undefined, star: number): number | undefined {
  const n = Math.min(5, Math.max(1, Math.round(star)));
  const cur = normalizeRating(current);
  if (cur === n) return n - 0.5;
  if (cur === n - 0.5) return n === 1 ? undefined : n;
  return n;
}
