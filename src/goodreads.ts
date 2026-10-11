// A Goodreads library export (`goodreads_library_export.csv`): the RFC 4180 CSV reader and the mapping
// to "read elsewhere" entries. Pure: no React Native or Expo imports, so the Node test runner can
// exercise it (test/goodreads.test.ts). Goodreads writes a UTF-8 BOM, CRLF line endings and wraps
// long numbers such as ISBNs in ="…".
import { normalizeRating } from './shelf';
import type { ReadElsewhere } from './reading-history';

export const NOT_GOODREADS = "This doesn't look like a Goodreads export";

/** The columns this import reads. A file missing any of them is not treated as a Goodreads export. */
const HEADERS = ['Book Id', 'Title', 'Author', 'Exclusive Shelf', 'My Rating', 'Date Read'] as const;

/** Strips Goodreads' `="123"` wrapper, which it puts around ISBNs and other long numbers. */
const unwrap = (cell: string) => {
  const m = /^="(.*)"$/.exec(cell);
  return m ? m[1] : cell;
};

/**
 * Parses CSV into rows of cells: quoted fields may hold commas, newlines and doubled quotes, CRLF and a
 * leading BOM are handled, and `="…"` cells are unwrapped. A `"` only opens a quoted field at its start.
 */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const push = () => { row.push(unwrap(field)); field = ''; };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { push(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { push(); rows.push(row); row = []; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { push(); rows.push(row); }
  return rows;
}

/** A `YYYY/MM/DD` Goodreads date as a local-time millisecond stamp, or undefined when empty/invalid. */
export function parseReadDate(s: string): number | undefined {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s.trim());
  if (!m) return undefined;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Reads a Goodreads export. Rows whose `Exclusive Shelf` is `read` become entries; a 0 rating means
 * unrated and an empty date means undated. A missing or unknown column throws a readable error rather
 * than guessing, so a wrong file never reaches the shelf.
 */
export function parseGoodreadsExport(text: string): ReadElsewhere[] {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) throw new Error(NOT_GOODREADS);
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  for (const name of HEADERS) if (col(name) < 0) throw new Error(NOT_GOODREADS);
  const [iId, iTitle, iAuthor, iShelf, iRating, iDate] =
    ['Book Id', 'Title', 'Author', 'Exclusive Shelf', 'My Rating', 'Date Read'].map(col);

  const out: ReadElsewhere[] = [];
  for (const r of rows.slice(1)) {
    if ((r[iShelf] ?? '').trim() !== 'read') continue;
    const id = (r[iId] ?? '').trim();
    const title = (r[iTitle] ?? '').trim();
    if (!id || !title) continue;
    const author = (r[iAuthor] ?? '').trim();
    out.push({
      id: `gr:${id}`, source: 'goodreads', title,
      author: author || undefined,
      rating: normalizeRating(Number((r[iRating] ?? '').trim())),
      finishedAt: parseReadDate(r[iDate] ?? ''),
    });
  }
  return out;
}
