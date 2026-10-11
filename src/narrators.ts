// Pure helpers for following narrators: splitting a result's narrator string, comparing names
// loosely, toggling the followed list and floating followed results up. No react-native/expo
// imports, so the Node test runner can exercise it (test/narrators.test.ts).

import { splitNarrators } from './scrapers/cast';

export { splitNarrators };

/**
 * A name reduced to what matters for matching: lower case, punctuation and spacing flattened, and a
 * trailing "(narrator)"-style marker dropped. "J. Smith" and "J Smith" both become "j smith".
 */
export function normalizeNarrator(name: string): string {
  return String(name ?? '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `name` matches any name already followed. */
export function isFavourite(name: string, list: readonly string[]): boolean {
  const key = normalizeNarrator(name);
  return !!key && list.some((n) => normalizeNarrator(n) === key);
}

/** The followed names present in a result's narrator string, in the order they were followed. */
export function resultFavourites(narrator: string | undefined, list: readonly string[]): string[] {
  const names = splitNarrators(narrator).map(normalizeNarrator);
  if (!names.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of list) {
    const key = normalizeNarrator(n);
    if (!key || seen.has(key) || !names.includes(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Adds `name` to the followed list, or removes the matching entry. Returns the new list. */
export function toggleNarrator(name: string, list: readonly string[]): string[] {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return [...list];
  if (isFavourite(trimmed, list)) return list.filter((n) => normalizeNarrator(n) !== normalizeNarrator(trimmed));
  return [...list, trimmed];
}

/** Union of two name lists by normalised value, keeping the first-seen typed form. */
export function unionNarrators(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...a, ...b]) {
    const key = normalizeNarrator(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n.trim());
  }
  return out;
}

/**
 * Stable partition: items whose narrator is followed come first, everything else keeps its relative
 * order (and so do the followed ones among themselves).
 */
export function favouriteFirst<T>(items: readonly T[], narratorOf: (item: T) => string | undefined, list: readonly string[]): T[] {
  const fav: T[] = [], rest: T[] = [];
  for (const it of items) (resultFavourites(narratorOf(it), list).length ? fav : rest).push(it);
  return [...fav, ...rest];
}
