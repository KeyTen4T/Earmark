import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { parseEpub, paragraphsSha1, utf8Bytes } from '../src/readalong/epub';
import {
  normalizeWords, buildWordIndex, fromAnchorsJson, locate, timeForWord, paragraphStartWord,
  withTimingCorrection,
  type ReadalongRecord,
} from '../src/readalong/anchors';
import { paragraphSource, findEpubTorrent } from '../src/readalong/source';
import { computeWindow, shouldRecentre, growWindow, WINDOW_BEHIND, WINDOW_AHEAD, WINDOW_CHUNK } from '../src/readalong/window';

// --------------------------------------------------------------------------------------
// A tiny EPUB built in-memory. The spine deliberately lists ch2 before ch1.
// --------------------------------------------------------------------------------------
function tinyEpub(): Uint8Array {
  const container =
    '<?xml version="1.0"?>' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
    '</container>';
  const opf =
    '<?xml version="1.0"?>' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<dc:title>Test Book</dc:title><dc:identifier id="id">x</dc:identifier></metadata>' +
    '<manifest>' +
    '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
    '</manifest><spine><itemref idref="ch2"/><itemref idref="ch1"/></spine></package>';
  const ch1 =
    '<html><body>' +
    '<h1>Chapter One</h1>' +
    '<p>alpha beta gamma.</p>' +
    '<div>delta epsilon</div>' +
    '<div><span>skipped</span></div>' +
    '<p>a <b>bold</b> c</p>' +
    '<p>&amp; &lt;tag&gt;</p>' +
    '<p></p>' +
    '<ul><li>item one</li><li>item two</li></ul>' +
    '</body></html>';
  const ch2 =
    '<html><body><p>zeta eta theta.</p><blockquote>iota kappa</blockquote>' +
    '<p>   </p><div>a<p>b</p>c</div></body></html>';
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/ch1.xhtml': strToU8(ch1),
    'OEBPS/ch2.xhtml': strToU8(ch2),
  });
}

test('parseEpub follows spine order and collects the same blocks as Python', () => {
  const { title, paragraphs } = parseEpub(tinyEpub());
  assert.equal(title, 'Test Book');
  assert.deepEqual(paragraphs, [
    'zeta eta theta.',   // ch2 first, because that is the spine order
    'iota kappa',
    'b',                 // div with only a nested p carries nothing; the p wins
    'Chapter One',
    'alpha beta gamma.',
    'delta epsilon',     // div with direct text
    'a bold c',          // nested inline tag joined with spaces
    '& <tag>',           // entities decoded
    'item one',
    'item two',
  ]);
  // div with text only inside a span is skipped, and empty paragraphs are dropped.
  assert.ok(!paragraphs.includes('skipped'));
  assert.ok(!paragraphs.some((p) => p === ''));
});

test('paragraphsSha1 hashes "\n"-joined UTF-8 and matches node:crypto', () => {
  const joinSha = (list: string[]) => createHash('sha1').update(list.join('\n'), 'utf8').digest('hex');
  assert.equal(paragraphsSha1(['a', 'b', 'c']), '2074e277e1b02db9a891a7242c9a4fe7054117a5');
  assert.equal(paragraphsSha1([]), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  const list = ['Hello, world.', 'Second paragraph.', 'Ünïcodé – 🎧'];
  assert.equal(paragraphsSha1(list), joinSha(list));
  // null/undefined become empty strings, like Python's `"" if t is None`.
  assert.equal(paragraphsSha1(['a', null, 'b']), joinSha(['a', '', 'b']));
});

test('utf8Bytes matches node Buffer encoding', () => {
  const s = 'héllo – 日本 🎧';
  assert.deepEqual([...utf8Bytes(s)], [...Buffer.from(s, 'utf8')]);
});

test('normalizeWords mirrors the Python tokeniser', () => {
  assert.deepEqual(normalizeWords("Alpha, beta-gamma. It's 1984!"), ['alpha', 'beta', 'gamma', 'it', 's', '1984']);
  assert.deepEqual(normalizeWords('“Hello” — it’s…'), ['hello', 'it', 's']);
  assert.deepEqual(normalizeWords('foo_bar'), ['foo', 'bar']);
  assert.deepEqual(normalizeWords('3.14'), ['3', '14']);
  assert.deepEqual(normalizeWords('ﬁne ﬂow'), ['fine', 'flow']); // NFKC ligatures
  assert.deepEqual(normalizeWords(''), []);
  assert.deepEqual(normalizeWords(null), []);
  assert.deepEqual(normalizeWords(undefined), []);
});

test('buildWordIndex maps each word to its paragraph', () => {
  const idx = buildWordIndex(['one two three', 'four', '', 'five six']);
  assert.deepEqual([...idx], [0, 0, 0, 1, 3, 3]);
});

test('fromAnchorsJson converts the tool output and drops malformed entries', () => {
  const rec = fromAnchorsJson(
    {
      version: 1,
      hash: 'abc',
      epub: { title: 'T', paragraphs: 2, words: 4, source: 'epub', paragraphsSha1: 'sha' },
      files: [
        { id: 5, name: 'a.m4b', duration: 60, anchors: [{ t: 10, para: 1, word: 3, conf: 0.9 }, { t: 0, para: 0, word: 0, conf: 1 }] },
        { id: 'bad', duration: 1, anchors: [] },
        { id: 6, duration: 2, anchors: [{ t: 1 }, { t: 2, para: 0, word: 1 }] },
      ],
    },
    { hash: 'abc', fileId: 5 },
    1234,
  );
  assert.equal(rec.epub.hash, 'abc');
  assert.equal(rec.epub.fileId, 5);
  assert.equal(rec.epub.title, 'T');
  assert.equal(rec.epub.paragraphsSha1, 'sha');
  assert.equal(rec.created, 1234);
  assert.deepEqual(rec.files.map((f) => f.id), [5, 6]); // the non-numeric id is dropped
  assert.deepEqual(rec.files[0].anchors, [[0, 0, 0], [10, 1, 3]]); // sorted by t
  assert.deepEqual(rec.files[1].anchors, [[2, 0, 1]]); // the anchor missing para/word is dropped
  assert.equal(rec.timing, undefined); // v1: read-time -10 s correction applies
});

test('fromAnchorsJson marks version-2 (word-timed) records', () => {
  const rec = fromAnchorsJson(
    {
      version: 2,
      timing: 'word',
      epub: { title: 'T', paragraphs: 1, words: 2, source: 'epub', paragraphsSha1: 'sha' },
      files: [{ id: 5, duration: 60, anchors: [{ t: 10, para: 0, word: 0, conf: 0.9 }] }],
    },
    { hash: 'abc', fileId: 5 },
  );
  assert.equal(rec.timing, 2);
});

// --------------------------------------------------------------------------------------
// Legacy (pre-v2) records: read-time correction of the ~10 s midpoint lag
// --------------------------------------------------------------------------------------

test('withTimingCorrection shifts legacy anchors 10 s earlier without rewriting the record', () => {
  const legacy: ReadalongRecord = {
    epub: { hash: 'h', fileId: 7, title: 'T', paragraphs: 3, paragraphsSha1: 's' },
    files: [{ id: 7, duration: 30, anchors: [[10, 0, 0], [20, 1, 20], [30, 2, 40]] }],
    created: 0,
  };
  const corrected = withTimingCorrection(legacy);
  assert.deepEqual(corrected.files[0].anchors, [[0, 0, 0], [10, 1, 20], [20, 2, 40]]);
  assert.deepEqual(legacy.files[0].anchors, [[10, 0, 0], [20, 1, 20], [30, 2, 40]]); // untouched
});

test('withTimingCorrection clamps at 0 and keeps times strictly increasing', () => {
  const legacy: ReadalongRecord = {
    epub: { hash: 'h', fileId: 7, title: 'T', paragraphs: 3, paragraphsSha1: 's' },
    files: [{ id: 7, duration: 30, anchors: [[5, 0, 0], [6, 1, 10], [20, 2, 20]] }],
    created: 0,
  };
  assert.deepEqual(withTimingCorrection(legacy).files[0].anchors,
    [[0, 0, 0], [0.001, 1, 10], [10, 2, 20]]);
});

test('withTimingCorrection leaves a v2 record alone', () => {
  const v2 = { ...sampleRecord(), timing: 2 };
  assert.equal(withTimingCorrection(v2), v2);
});

test('locate and timeForWord both see the corrected legacy anchors', () => {
  const legacy: ReadalongRecord = {
    epub: { hash: 'h', fileId: 7, title: 'T', paragraphs: 3, paragraphsSha1: 's' },
    files: [{ id: 7, duration: 30, anchors: [[10, 0, 0], [20, 1, 20], [30, 2, 40]] }],
    created: 0,
  };
  // Corrected anchors are at 0/10/20, so 5 s is halfway -> word 10.
  assert.deepEqual(locate(legacy, wordToPara, 7, 5), { para: 0, word: 10 });
  assert.equal(timeForWord(legacy, 7, 0), 0);   // tap-to-seek uses the corrected time
  assert.equal(timeForWord(legacy, 7, 20), 10);
  // A v2 record with the same raw anchors is NOT corrected: 5 s precedes the first anchor at 10 s.
  const v2: ReadalongRecord = { ...legacy, timing: 2 };
  assert.deepEqual(locate(v2, wordToPara, 7, 5), { para: 0, word: 0 });
  assert.equal(timeForWord(v2, 7, 0), 10);
});

// --------------------------------------------------------------------------------------
// locate(): interpolation, clamping and null cases
// --------------------------------------------------------------------------------------
function sampleRecord(): ReadalongRecord {
  return {
    epub: { hash: 'h', fileId: 7, title: 'T', paragraphs: 3, paragraphsSha1: 's' },
    files: [{ id: 7, duration: 30, anchors: [[0, 0, 0], [10, 1, 20], [20, 2, 40]] }],
    timing: 2,
    created: 0,
  };
}
// 3 paragraphs of 20 words each: word 0-19 -> para 0, 20-39 -> para 1, 40-59 -> para 2.
const wordToPara = Int32Array.from(Array.from({ length: 60 }, (_, i) => Math.floor(i / 20)));

test('locate interpolates between surrounding anchors', () => {
  const r = sampleRecord();
  assert.deepEqual(locate(r, wordToPara, 7, 5), { para: 0, word: 10 });
  assert.deepEqual(locate(r, wordToPara, 7, 15), { para: 1, word: 30 });
  assert.deepEqual(locate(r, wordToPara, 7, 10), { para: 1, word: 20 }); // exact anchor
});

test('locate extrapolates at the median pace, clamped to the book', () => {
  const r = sampleRecord();
  // before the first anchor: 0 - 2 words/s * 5s = -10 -> clamped to word 0
  assert.deepEqual(locate(r, wordToPara, 7, -5), { para: 0, word: 0 });
  // after the last anchor: 40 + 2 * 10 = 60 -> clamped to the last word (59)
  assert.deepEqual(locate(r, wordToPara, 7, 30), { para: 2, word: 59 });
});

test('locate returns null for a missing or anchor-less file', () => {
  const r = sampleRecord();
  assert.equal(locate(r, wordToPara, 99, 5), null);
  const empty: ReadalongRecord = { ...r, files: [{ id: 7, duration: 0, anchors: [] }] };
  assert.equal(locate(empty, wordToPara, 7, 5), null);
});

test('locate with a single anchor holds that anchor everywhere', () => {
  const r: ReadalongRecord = { ...sampleRecord(), files: [{ id: 7, duration: 30, anchors: [[10, 1, 25]] }] };
  assert.deepEqual(locate(r, wordToPara, 7, 0), { para: 1, word: 25 });
  assert.deepEqual(locate(r, wordToPara, 7, 100), { para: 1, word: 25 });
});

// --------------------------------------------------------------------------------------
// timeForWord(): the inverse of locate()
// --------------------------------------------------------------------------------------

test('timeForWord interpolates between the anchors around a word', () => {
  const r = sampleRecord(); // anchors at t=0/word=0, t=10/word=20, t=20/word=40
  assert.equal(timeForWord(r, 7, 0), 0);
  assert.equal(timeForWord(r, 7, 10), 5);
  assert.equal(timeForWord(r, 7, 20), 10);
  assert.equal(timeForWord(r, 7, 30), 15);
  assert.equal(timeForWord(r, 7, 40), 20);
});

test('timeForWord extrapolates at the median pace and clamps to [0, duration]', () => {
  const r = sampleRecord(); // 2 words/s, duration 30
  assert.equal(timeForWord(r, 7, -10), 0);   // -5s, clamped up
  assert.equal(timeForWord(r, 7, 60), 30);   // 30s, exactly the duration
  assert.equal(timeForWord(r, 7, 80), 30);   // 40s, clamped down to the duration
});

test('timeForWord is roughly the inverse of locate', () => {
  const r = sampleRecord();
  for (const seconds of [2, 5, 9, 12, 18]) {
    const hit = locate(r, wordToPara, 7, seconds);
    assert.ok(hit);
    const back = timeForWord(r, 7, hit!.word);
    assert.ok(back != null && Math.abs(back - seconds) <= 0.5, `${seconds}s -> word ${hit!.word} -> ${back}s`);
  }
});

test('timeForWord returns null without a file or anchors, and holds a single anchor', () => {
  const r = sampleRecord();
  assert.equal(timeForWord(r, 99, 10), null);
  const empty: ReadalongRecord = { ...r, files: [{ id: 7, duration: 0, anchors: [] }] };
  assert.equal(timeForWord(empty, 7, 10), null);
  const single: ReadalongRecord = { ...r, files: [{ id: 7, duration: 30, anchors: [[10, 1, 25]] }] };
  assert.equal(timeForWord(single, 7, 0), 10);
  assert.equal(timeForWord(single, 7, 100), 10);
});

test('paragraphStartWord finds the first word of a paragraph (or the end)', () => {
  const idx = buildWordIndex(['one two three', 'four', '', 'five six']); // [0,0,0,1,3,3]
  assert.equal(paragraphStartWord(idx, 0), 0);
  assert.equal(paragraphStartWord(idx, 1), 3);
  assert.equal(paragraphStartWord(idx, 3), 4);
  assert.equal(paragraphStartWord(idx, 4), 6); // past the end
});

// --------------------------------------------------------------------------------------
// source.ts pure helpers: parse + sha check, and the EPUB torrent lookup
// --------------------------------------------------------------------------------------

test('paragraphSource parses, indexes and checks the recorded SHA-1', () => {
  const { paragraphs } = parseEpub(tinyEpub());
  const sha = paragraphsSha1(paragraphs);

  const ok = paragraphSource(tinyEpub(), sha);
  assert.deepEqual(ok.paragraphs, paragraphs);
  assert.deepEqual([...ok.wordToPara], [...buildWordIndex(paragraphs)]);
  assert.equal(ok.sha1Ok, true);

  assert.equal(paragraphSource(tinyEpub(), 'not-the-sha').sha1Ok, false);
  assert.equal(paragraphSource(tinyEpub(), '').sha1Ok, true); // unrecorded hash: no spurious warning
});

test('paragraphSource wraps a broken EPUB in a readable error', () => {
  assert.throws(() => paragraphSource(new Uint8Array([1, 2, 3, 4]), ''), /Couldn't read the EPUB/);
});

test('findEpubTorrent matches by info-hash, case-insensitively', () => {
  const t = (id: number, hash: string) => ({ id, hash, name: 'x', files: [] }) as unknown as Parameters<typeof findEpubTorrent>[0][number];
  assert.equal(findEpubTorrent([t(1, 'AB'), t(2, 'cd')], 'ab')?.id, 1);
  assert.equal(findEpubTorrent([t(1, 'ab')], 'AB')?.id, 1);
  assert.equal(findEpubTorrent([t(1, 'ab')], 'nope'), undefined);
  assert.equal(findEpubTorrent([t(1, 'ab')], '   '), undefined);
});

// --------------------------------------------------------------------------------------
// window.ts: the moving slice that keeps scrollToIndex targets measured
// --------------------------------------------------------------------------------------

test('computeWindow centres on the current paragraph and clamps to the book', () => {
  assert.deepEqual(computeWindow(199, 3145), { start: 199 - WINDOW_BEHIND, end: 199 + WINDOW_AHEAD });
  assert.deepEqual(computeWindow(0, 100), { start: 0, end: 60 });
  assert.deepEqual(computeWindow(99, 100), { start: 69, end: 100 });
  assert.deepEqual(computeWindow(5, 3), { start: 0, end: 3 });
  assert.deepEqual(computeWindow(199, 0), { start: 0, end: 0 });
  // `prev` is only advisory: a centred window is always computed for the given current.
  assert.deepEqual(computeWindow(199, 3145, { start: 0, end: 90 }), computeWindow(199, 3145));
});

test('shouldRecentre only near an edge or after a jump', () => {
  const w = computeWindow(199, 3145); // {169, 259}
  assert.equal(shouldRecentre(199, 3145, w), false);
  assert.equal(shouldRecentre(189, 3145, w), false); // 20 rows from the start edge
  assert.equal(shouldRecentre(178, 3145, w), true);  // 9 rows from the start edge
  assert.equal(shouldRecentre(248, 3145, w), false); // 10 rows from the end edge
  assert.equal(shouldRecentre(249, 3145, w), true);  // 9 rows from the end edge
  assert.equal(shouldRecentre(168, 3145, w), true);  // jumped before the window
  assert.equal(shouldRecentre(259, 3145, w), true);  // jumped past the window
  assert.equal(shouldRecentre(0, 3145, null), true); // no window yet
  assert.equal(shouldRecentre(0, 0, null), false);   // empty book
});

// --------------------------------------------------------------------------------------
// window.ts: browsing grows the slice, it never re-centres
// --------------------------------------------------------------------------------------

test('growWindow appends below when the last visible row reaches the bottom edge', () => {
  const prev = { start: 100, end: 190 };
  assert.deepEqual(growWindow(175, 189, 3000, prev), { start: 100, end: 190 + WINDOW_CHUNK });
  assert.equal(growWindow(170, 175, 3000, prev), prev); // last is 15 rows from the edge: no change
});

test('growWindow prepends above when the first visible row reaches the top edge', () => {
  const prev = { start: 100, end: 190 };
  assert.deepEqual(growWindow(101, 130, 3000, prev), { start: 100 - WINDOW_CHUNK, end: 190 });
  assert.equal(growWindow(111, 140, 3000, prev), prev); // first is 11 rows in: no change
});

test('growWindow never shrinks and always contains prev and the visible rows', () => {
  const prev = { start: 100, end: 190 };
  for (const [first, last] of [[100, 189], [90, 200], [150, 189]] as const) {
    const next = growWindow(first, last, 3000, prev);
    assert.ok(next.start <= prev.start && next.end >= prev.end, `grew ${JSON.stringify(next)}`);
    assert.ok(next.start <= first && next.end > last, `contains ${first}..${last}`);
  }
});

test('growWindow clamps at both ends of the book', () => {
  assert.deepEqual(growWindow(0, 30, 50, { start: 0, end: 50 }), { start: 0, end: 50 });   // whole book already
  assert.deepEqual(growWindow(0, 30, 3000, { start: 0, end: 60 }), { start: 0, end: 60 }); // start cannot go below 0
  assert.deepEqual(growWindow(2990, 2999, 3000, { start: 2940, end: 3000 }), { start: 2940, end: 3000 }); // end cannot pass N
});

test('growWindow leaves the window alone in the middle and on an empty book', () => {
  const prev = { start: 100, end: 190 };
  assert.equal(growWindow(130, 160, 3000, prev), prev);
  assert.deepEqual(growWindow(0, 0, 0, { start: 0, end: 0 }), { start: 0, end: 0 });
});

test('repeated growWindow reaches the start and the end', () => {
  let w = { start: 500, end: 590 };
  for (let i = 0; w.start > 0 && i < 100; i++) w = growWindow(w.start, w.start + 5, 3000, w);
  assert.equal(w.start, 0);
  for (let i = 0; w.end < 3000 && i < 100; i++) w = growWindow(w.end - 5, w.end - 1, 3000, w);
  assert.equal(w.end, 3000);
});
