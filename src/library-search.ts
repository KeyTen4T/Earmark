import { prettyName } from './theme';

/** The bits of a book's metadata a library search reads. */
export type SearchableMeta = { title?: string; author?: string; narrator?: string };

/** Everything a book can be matched on: its title, author, narrator, and the cleaned torrent name. */
export function libraryHaystack(name: string, meta?: SearchableMeta): string {
  return [meta?.title, meta?.author, meta?.narrator, prettyName(name ?? '')].filter(Boolean).join(' ').toLowerCase();
}

/** True when every word typed appears in the book's title, author, narrator or name (case-insensitive). */
export function matchesLibrarySearch(name: string, meta: SearchableMeta | undefined, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = libraryHaystack(name, meta);
  return words.every((w) => hay.includes(w));
}
