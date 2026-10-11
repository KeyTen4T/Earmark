// EPUB -> paragraph list, a faithful port of tools/readalong/readalong.py's `parse_epub` /
// `_extract_blocks` / `paragraphs_sha1`. Pure: no react-native, expo, node:fs, Buffer, crypto or
// DOMParser, so it runs under the Node test runner, Hermes and the web.
import { unzipSync } from 'fflate';
import { parseDocument } from 'htmlparser2';
import { sha1Hex } from '../scrapers/sha1';
import { utf8 } from '../scrapers/bencode';

// Same set (and order) as readalong.py's _BLOCK_TAGS.
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'div']);

/** Minimal structural view of a domhandler node; keeps us off its version-specific exports. */
type DomNode = {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
  attribs?: Record<string, string>;
};

const isElement = (n: DomNode) => n.type === 'tag' || n.type === 'script' || n.type === 'style';

// --------------------------------------------------------------------------------------
// Small posix + url helpers (Python's posixpath / urllib.parse, without node:path / node:url)
// --------------------------------------------------------------------------------------

/** posixpath.normpath: collapse slashes/dots, resolve "..", preserve leading slashes. */
function posixNormpath(path: string): string {
  if (path === '') return '.';
  const initialSlashes = path.startsWith('/')
    ? (path.startsWith('//') && !path.startsWith('///') ? 2 : 1)
    : 0;
  const out: string[] = [];
  for (const comp of path.split('/')) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (initialSlashes === 0 && out.length === 0) || (out.length > 0 && out[out.length - 1] === '..')) {
      out.push(comp);
    } else if (out.length > 0) {
      out.pop();
    }
  }
  const joined = out.join('/');
  const res = initialSlashes ? '/'.repeat(initialSlashes) + joined : joined;
  return res || '.';
}

/** posixpath.join. */
function posixJoin(a: string, b: string): string {
  if (b.startsWith('/')) return b;
  if (a === '' || a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}

/** posixpath.dirname. */
function posixDirname(p: string): string {
  const i = p.lastIndexOf('/') + 1;
  let head = p.slice(0, i);
  if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
  return head;
}

const HEX2 = /^[0-9a-fA-F]{2}$/;

/** urllib.parse.unquote: decode %XX as UTF-8, leaving other characters as-is. */
function unquote(s: string): string {
  if (!s.includes('%')) return s;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '%') {
      const hex = s.slice(i + 1, i + 3);
      if (hex.length === 2 && HEX2.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return utf8(new Uint8Array(bytes));
}

/** Read a zip entry, tolerating spaces/percent-encoding/leading ./ in hrefs (readalong.py's _zip_open). */
function zipOpen(files: Record<string, Uint8Array>, path: string): Uint8Array | null {
  const want = posixNormpath(unquote(path)).replace(/^[./]+/, '');
  for (const name of Object.keys(files)) {
    if (posixNormpath(unquote(name)).replace(/^[./]+/, '') === want) return files[name];
  }
  return null;
}

// --------------------------------------------------------------------------------------
// DOM walking / text extraction
// --------------------------------------------------------------------------------------

/** All descendants of `node`, pre-order (element and string nodes alike). */
function* descendants(node: DomNode): Generator<DomNode> {
  for (const child of node.children ?? []) {
    yield child;
    yield* descendants(child);
  }
}

/** All elements under `node`, in document order (bs4's find_all traversal order). */
function* elements(node: DomNode): Generator<DomNode> {
  for (const child of node.children ?? []) {
    if (isElement(child)) yield child;
    yield* elements(child);
  }
}

/** bs4's `el.find(_BLOCK_TAGS)`: any descendant block element at all. */
function hasBlockDescendant(el: DomNode): boolean {
  for (const d of descendants(el)) if (isElement(d) && BLOCK_TAGS.has(d.name ?? '')) return true;
  return false;
}

// bs4 counts comments as direct strings for the div "has direct text" test.
const STRING_TYPES = new Set(['text', 'comment', 'cdata', 'directive']);

function hasDirectText(el: DomNode): boolean {
  return (el.children ?? []).some((c) => STRING_TYPES.has(c.type) && (c.data ?? '').trim().length > 0);
}

/**
 * bs4's `get_text(separator, strip=True)`: each descendant string trimmed, empties dropped, joined
 * with `separator`. Script/style contents and comments are excluded, as bs4 does.
 */
function stringNodes(el: DomNode, separator: string): string {
  const parts: string[] = [];
  const visit = (node: DomNode) => {
    for (const c of node.children ?? []) {
      if (c.type === 'script' || c.type === 'style') continue;
      if (c.type === 'text') {
        const s = (c.data ?? '').trim();
        if (s) parts.push(s);
      } else {
        visit(c);
      }
    }
  };
  visit(el);
  return parts.join(separator);
}

/** readalong.py's paragraph text: get_text(" ", strip=True), collapse whitespace, trim. */
function paragraphText(el: DomNode): string {
  return stringNodes(el, ' ').replace(/\s+/g, ' ').trim();
}

function extractBlocks(root: DomNode): string[] {
  const out: string[] = [];
  for (const el of elements(root)) {
    if (!BLOCK_TAGS.has(el.name ?? '')) continue;
    // If this node contains another block, that inner block carries the text.
    if (hasBlockDescendant(el)) continue;
    // Only treat a div as a paragraph when it has direct text.
    if (el.name === 'div' && !hasDirectText(el)) continue;
    const text = paragraphText(el);
    if (text) out.push(text);
  }
  return out;
}

// --------------------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------------------

/** Parses an EPUB's spine into reading-order paragraphs. Mirrors `readalong.parse_epub`. */
export function parseEpub(bytes: Uint8Array): { title: string; paragraphs: string[] } {
  const files = unzipSync(bytes);

  const containerBytes = zipOpen(files, 'META-INF/container.xml');
  if (!containerBytes) throw new Error('EPUB is missing META-INF/container.xml');
  const container = parseDocument(utf8(containerBytes), { xmlMode: true }) as unknown as DomNode;

  let opfPath = '';
  for (const el of elements(container)) {
    if (el.name === 'rootfile' && el.attribs?.['full-path']) { opfPath = el.attribs['full-path']; break; }
  }
  if (!opfPath) throw new Error('container.xml has no rootfile');

  const opfBytes = zipOpen(files, opfPath);
  if (!opfBytes) throw new Error(`EPUB is missing ${opfPath}`);
  const opf = parseDocument(utf8(opfBytes), { xmlMode: true }) as unknown as DomNode;

  let title = 'EPUB';
  for (const el of elements(opf)) {
    if (/(^|:)title$/.test(el.name ?? '')) {
      const t = stringNodes(el, '');
      if (t) { title = t; break; }
    }
  }

  const base = posixDirname(opfPath);
  const manifest: Record<string, string> = {};
  for (const item of elements(opf)) {
    if (item.name !== 'item') continue;
    const id = item.attribs?.id;
    const href = item.attribs?.href;
    if (id && href) manifest[id] = unquote(href);
  }

  const paragraphs: string[] = [];
  for (const itemref of elements(opf)) {
    if (itemref.name !== 'itemref') continue;
    const idref = itemref.attribs?.idref;
    if (!idref || !(idref in manifest)) continue;
    const href = manifest[idref].split('#', 1)[0];
    const full = base ? posixNormpath(posixJoin(base, href)) : href;
    const data = zipOpen(files, full);
    if (!data) continue;
    const soup = parseDocument(utf8(data)) as unknown as DomNode;
    for (const text of extractBlocks(soup)) paragraphs.push(text);
  }

  return { title, paragraphs };
}

/** UTF-8 encode a string without TextEncoder (Hermes-safe). */
export function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

/** SHA-1 hex of the paragraph strings joined with "\n" (UTF-8). Mirrors `paragraphs_sha1`. */
export function paragraphsSha1(paragraphs: (string | null | undefined)[]): string {
  const joined = paragraphs.map((p) => (p == null ? '' : String(p))).join('\n');
  return sha1Hex(utf8Bytes(joined));
}
