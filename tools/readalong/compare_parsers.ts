// Compares the TypeScript EPUB parser against the Python reference in tools/readalong.
//
//   node --experimental-strip-types tools/readalong/compare_parsers.ts <book.epub>
//
// Prints paragraph/word counts and SHA-1s for both parsers and the first few differing paragraphs.
// Node-only (fs/child_process); the modules it imports stay pure. Registers a tiny loader so the
// src modules' extensionless TypeScript imports resolve.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { resolve } from 'node:path';

register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('.') && !/\\.[a-z]+$/.test(spec)) {
    const u = new URL(spec + '.ts', ctx.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
  }
  return next(spec, ctx);
}`));

const { parseEpub, paragraphsSha1 } = await import('../../src/readalong/epub');
const { normalizeWords } = await import('../../src/readalong/anchors');

const PYTHON = `${process.env.HOME}/.local/share/earmark-readalong/venv/bin/python`;

const epubPath = process.argv[2];
if (!epubPath) {
  console.error('usage: compare_parsers.ts <book.epub>');
  process.exit(2);
}

const pyScript = `
import json, sys
sys.path.insert(0, 'tools/readalong')
import readalong
b = readalong.parse_epub(sys.argv[1])
words = 0
for p in b.paragraphs:
    words += len(readalong.normalize_words(p.get('text', '')))
print(json.dumps({'title': b.title, 'texts': b.texts, 'words': words,
                  'sha1': readalong.paragraphs_sha1(b.texts)}))
`;

const py = JSON.parse(
  execFileSync(PYTHON, ['-c', pyScript, resolve(epubPath)], {
    cwd: resolve(import.meta.dirname, '../..'),
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  }),
) as { title: string; texts: string[]; words: number; sha1: string };

const bytes = new Uint8Array(readFileSync(epubPath));
const ts = parseEpub(bytes);
const tsSha = paragraphsSha1(ts.paragraphs);
const tsWords = ts.paragraphs.reduce((n, p) => n + normalizeWords(p).length, 0);

console.log(`file            ${resolve(epubPath)}`);
console.log(`title  python   ${JSON.stringify(py.title)}`);
console.log(`title  ts       ${JSON.stringify(ts.title)}`);
console.log(`paras  python   ${py.texts.length}`);
console.log(`paras  ts       ${ts.paragraphs.length}`);
console.log(`words  python   ${py.words}`);
console.log(`words  ts       ${tsWords}`);
console.log(`sha1   python   ${py.sha1}`);
console.log(`sha1   ts       ${tsSha}`);
console.log(`sha1 match      ${py.sha1 === tsSha}`);
console.log(`words match     ${py.words === tsWords}`);

const n = Math.max(py.texts.length, ts.paragraphs.length);
let diffs = 0;
for (let i = 0; i < n && diffs < 8; i++) {
  if (py.texts[i] !== ts.paragraphs[i]) {
    diffs++;
    console.log(`\n#${i}`);
    console.log(`  python ${JSON.stringify(py.texts[i])}`);
    console.log(`  ts     ${JSON.stringify(ts.paragraphs[i])}`);
  }
}
if (!diffs) console.log('\nno differing paragraphs');

process.exit(py.sha1 === tsSha && py.words === tsWords ? 0 : 1);
