// Which audio files a read-along build should cover, and which EPUB file to use.
//
// Pure: no react-native, expo, node APIs or DOM, so it runs under the Node test runner, Hermes and
// the web. Kept apart from create.ts (which pulls in storage) so it can be unit-tested directly.

/** A torrent file, narrowed to the fields these helpers need. */
export type ScopeFile = { id?: number; name?: string; size?: number };

/** A whole-book audio file is usually well over this; per-chapter splits are usually under it. */
export const SERIES_BOOK_BYTES = 300 * 1024 * 1024;

/**
 * Whether a torrent looks like several books bundled together (a series / boxed set) rather than
 * one book split into chapters. The reliable signal is several audio files each over 300 MB; a
 * name that says so ("series", "complete", "omnibus", "books 1-3") reinforces it.
 */
export function looksLikeSeries(files: ScopeFile[], name = ''): boolean {
  const big = files.filter((f) => (f.size ?? 0) > SERIES_BOOK_BYTES).length;
  if (big >= 2) return true;
  if (files.length >= 2 && /\b(series|collection|complete|boxed?\s*set|omnibus|books?\s*\d+\s*[-–—]\s*\d+)\b/i.test(name)) {
    return true;
  }
  return false;
}

/**
 * The default scope for a scope chooser: 'current' (the chapter that is playing) for a series
 * torrent, otherwise 'all'.
 */
export function defaultScope(files: ScopeFile[], name: string): 'all' | 'current' {
  if (files.length <= 1) return 'all';
  return looksLikeSeries(files, name) ? 'current' : 'all';
}

/** The largest `.epub` file in a torrent, or null when there is none. */
export function largestEpub<T extends ScopeFile>(files: T[]): T | null {
  let best: T | null = null;
  for (const f of files) {
    if (!/\.epub$/i.test(f.name ?? '')) continue;
    if (!best || (f.size ?? 0) > (best.size ?? 0)) best = f;
  }
  return best;
}

// --------------------------------------------------------------------------------------
// Search-term cleaning
// --------------------------------------------------------------------------------------

/** A cleaned search title plus the author guessed from the name (empty when there is none). */
export type NameTerms = { title: string; author: string };

const NAME_EXTENSION = /\.[a-z0-9]{1,5}$/i;
const BRACKETED = /[\[\(\{][^\]\)\}]*[\]\)\}]/g;
// A leading track number: "01 ", "01. ", "1 - " but not a title like "1984" or "50 Shades".
const TRACK_NUMBER = /^\s*(?:0\d{1,2}\s+|\d{1,3}\s*[.\-_)]\s*)/;
const NARRATOR = /^(?:narrated|read)\s+by\b/i;
const NOISE_WORD = /^(?:chapterized|unabridged|abridged|audiobook|mp3|m4a|m4b|aac|flac|ogg|opus|vorbis|vbr|cbr|encode|encoded|encoding|stereo|mono|bitrate|kbps)$/i;
const NOISE_TOKEN = /\b(?:chapterized|unabridged|abridged|audiobook|opus|vorbis|mp3|m4a|m4b|aac|flac|ogg|vbr|cbr|encoded?|encoding)\b/gi;
const BITRATE = /\b\d{2,3}\s?k(?:b|bit)s?(?:\/s)?\b/gi;
const CHANNELS = /\b\d(?:\.\d)?\s?ch(?:annel)?s?\b/gi;

/** Curly quotes/dashes to ASCII so names compare and search consistently. */
function foldPunctuation(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...');
}

function tidy(s: string): string {
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s\-_:.,;]+/, '').replace(/[\s\-_:.,;]+$/, '').trim();
}

function basename(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] || name;
}

function normalizeForCompare(s: string): string {
  return foldPunctuation(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True for a whole segment that is only encode/narrator noise ("Opus 5.1ch Encode", "Narrated by X"). */
function isNoiseSegment(segment: string): boolean {
  const text = tidy(segment);
  if (!text) return true;
  if (NARRATOR.test(text)) return true;
  const tokens = text.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every((t) => NOISE_WORD.test(t) || /^\d+(?:\.\d+)?(?:ch|kbps|kb|mb|gb)?$/.test(t));
}

/** Splits "A - B - C" (spaced) or "A-B-C" (several bare hyphens) into segments. */
function splitSegments(s: string): string[] {
  if (/\s+-\s+/.test(s)) return s.split(/\s+-\s+/).map(tidy).filter(Boolean);
  if ((s.match(/-/g)?.length ?? 0) >= 2) return s.split('-').map(tidy).filter(Boolean);
  return [tidy(s)].filter(Boolean);
}

/** How much a segment looks like a person's name rather than a book title. */
function authorScore(segment: string): number {
  const words = tidy(segment).split(/\s+/).filter(Boolean);
  let score = 0;
  if (words.length === 1) score -= 2;
  else if (words.length <= 4) score += 2;
  if (words.some((w) => /^[A-Z]\.?$/.test(w))) score += 3; // initials: "J R R Tolkien"
  if (/^(the|a|an)\b/i.test(segment)) score -= 3;
  if (words.length > 5) score -= 3;
  if (words.length >= 3 && /\b(?:of|and|the|in|to|for|with)\b/i.test(segment)) score -= 1;
  return score - words.length * 0.1;
}

function guessAuthorTitle(segments: string[], metaAuthor: string): NameTerms {
  if (segments.length === 1) return { title: segments[0], author: '' };
  if (metaAuthor) {
    const needle = normalizeForCompare(metaAuthor);
    const found = segments.findIndex((s) => {
      const n = normalizeForCompare(s);
      return n === needle || (needle.length > 3 && (n.includes(needle) || needle.includes(n)));
    });
    if (found >= 0) {
      return { title: segments.filter((_, i) => i !== found).join(' - '), author: tidy(segments[found]) };
    }
  }
  let best = 0;
  for (let i = 1; i < segments.length; i++) {
    if (authorScore(segments[i]) > authorScore(segments[best])) best = i;
  }
  return { title: segments.filter((_, i) => i !== best).join(' - '), author: tidy(segments[best]) };
}

/**
 * Cleans a torrent or audio-file name into a search title and a guessed author. Takes the basename,
 * drops the extension, bracketed tags ("[Opus 5.1ch Encode]", "(FCE)"), leading track numbers,
 * narrator phrases, codec/bitrate words and a trailing "- Author" segment, and folds curly
 * punctuation. `metaAuthor` (when known) is used to pick the author side of "A - B".
 */
export function cleanName(raw: string, metaAuthor = ''): NameTerms {
  let text = foldPunctuation(basename(raw));
  text = text.replace(NAME_EXTENSION, '');
  text = text.replace(BRACKETED, ' ');
  text = text.replace(TRACK_NUMBER, '');
  const segments = splitSegments(text).filter((s) => !isNoiseSegment(s));
  const picked = segments.length ? guessAuthorTitle(segments, metaAuthor) : { title: tidy(text), author: '' };
  const title = tidy(
    picked.title
      .replace(NOISE_TOKEN, ' ')
      .replace(BITRATE, ' ')
      .replace(CHANNELS, ' ')
      .replace(/\s*-\s*(?:narrated|read)\s+by\b.*$/i, ' '),
  );
  return { title: title || tidy(text), author: picked.author };
}
