// Pure helpers for the virtualised Library grid: how the shelf is cut into rows for the list, and
// the per-book numbers a card draws. Deliberately free of React Native, Expo and storage imports so
// the Node test runner (test/library-rows.test.ts) can exercise it directly.

import { chapterList } from './torbox';
import { sizeWeightedFraction, remainingBookSeconds } from './book-math';
import { prettyName } from './theme';
import type { TBTorrent } from './torbox';
import type { DownloadBook } from './downloads/state';

/** The progress fields a card needs. Structural, so a storage `Progress` can be passed unchanged. */
export type ProgressLike = {
  chapterIndex: number;
  position: number;
  duration: number;
  chapterCount: number;
  finished?: boolean;
};

/** The book-detail fields a card needs. Structural, so a storage `BookMeta` can be passed unchanged. */
export type MetaLike = { title?: string; author?: string; cover?: string };

/** The numbers and labels one library card draws, computed once per change of the data below. */
export type BookMetrics = {
  sizes: number[];
  chapterCount: number;
  /** Overall fraction listened, 0..1, size-weighted when sizes are known. */
  fraction: number;
  /** Estimated seconds left in the whole book, or null when it cannot be estimated. */
  leftSeconds: number | null;
  title: string;
  author?: string;
  cover?: string;
  finished: boolean;
  /** True when there is a stored progress record (even at 0), so an empty bar still shows. */
  hasProgress: boolean;
  /** True when this book is the one the player has loaded. */
  playing: boolean;
  download?: DownloadBook;
  /** One spoken description for a card: title, author, then how far along it is. */
  label: string;
};

/**
 * The per-book card metrics. Every expensive or repetition-prone bit of the card render (the
 * chapter list, the size-weighted fraction, the remaining time, the accessibility label) is done
 * here once, so a card is a plain render of the returned numbers.
 */
export function bookMetrics(input: {
  book: TBTorrent;
  progress?: ProgressLike;
  meta?: MetaLike;
  download?: DownloadBook;
  /** TorBox id of the book the player has loaded, so a card can mark itself "now playing". */
  nowPlayingId?: number;
}): BookMetrics {
  const { book } = input;
  const files = chapterList(book);
  const sizes = files.map((f) => f.size);
  const p = input.progress;
  const md = input.meta ?? {};
  const title = md.title ?? prettyName(book.name);
  const fraction = p
    ? sizeWeightedFraction(sizes, p.chapterIndex, p.position, p.duration, p.chapterCount, p.finished)
    : 0;
  const leftSeconds = p && !p.finished
    ? remainingBookSeconds(sizes, p.chapterIndex, p.position, p.duration, p.chapterCount)
    : null;
  const finished = !!p?.finished;
  const playing = input.nowPlayingId === book.id;

  const bits = [title];
  if (md.author) bits.push(md.author);
  if (finished) bits.push('finished');
  else if (playing) bits.push('now playing');
  else if (p) bits.push(`${Math.round(fraction * 100)}% listened`);

  return {
    sizes,
    chapterCount: files.length,
    fraction,
    leftSeconds,
    title,
    author: md.author,
    cover: md.cover,
    finished,
    hasProgress: !!p,
    playing,
    download: input.download,
    label: bits.join(', '),
  };
}

/** One row of the virtualised list: a section heading, a row of grid cards, or a single item row. */
export type LibraryRow<T> =
  | { kind: 'heading'; key: string; label: string }
  | { kind: 'cards'; key: string; books: T[] }
  | { kind: 'item'; key: string; index: number; item: T };

/**
 * Groups books into rows of at most `cols` cards, keeping their order. `cols` is clamped to at least
 * one so a zero-width first layout still produces one card per row rather than nothing.
 */
export function cardRows<T extends { id: number }>(books: T[], cols: number): LibraryRow<T>[] {
  const n = Math.max(1, Math.floor(cols) || 1);
  const rows: LibraryRow<T>[] = [];
  for (let i = 0; i < books.length; i += n) {
    const slice = books.slice(i, i + n);
    rows.push({ kind: 'cards', key: `cards-${slice[0].id}`, books: slice });
  }
  return rows;
}

/** One heading per finished-shelf year group, each followed by its books as item rows. */
export type FinishedGroup<T> = { year: number | null; label: string; books: T[] };

export function finishedRows<T>(groups: FinishedGroup<T>[], itemKey: (item: T) => string): LibraryRow<T>[] {
  const rows: LibraryRow<T>[] = [];
  for (const g of groups) {
    rows.push({ kind: 'heading', key: `year-${g.year ?? 'earlier'}`, label: g.label });
    g.books.forEach((item, index) => rows.push({ kind: 'item', key: itemKey(item), index, item }));
  }
  return rows;
}
