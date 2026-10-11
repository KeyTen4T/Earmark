import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchEbooks, normalizeEbookResult, looksLikeEpub, rankCandidates, isHttpUrl,
  type EbookResult,
} from '../src/readalong/ebookSearch';
import {
  applyJobEvent, getJob, jobActive, preparing, resetJob, subscribeJob,
} from '../src/readalong/job';
import { defaultScope, largestEpub, looksLikeSeries, cleanName } from '../src/readalong/scope';

// --------------------------------------------------------------------------------------
// ebookSearch: the EPUB source request/response port
// --------------------------------------------------------------------------------------

const EBOOK_URL = 'https://example.com/ebook/search';

test('searchEbooks sends the ebook request and normalises torrentable rows', async () => {
  let sent = '';
  const f = (async (url: string, init: any) => {
    assert.equal(url, EBOOK_URL);
    sent = init.body;
    return {
      ok: true, status: 200,
      json: async () => ({
        providerStatus: 'ok',
        results: [
          { cleanTitle: 'Dune', originalTitle: 'DUNE ORIG', infoHash: 'AB'.repeat(20), format: 'epub', sizeBytes: 1536, source: 'Forge', seeders: 12 },
          { title: 'No Locator', mediaKind: 'ebook' }, // no magnet/hash: dropped
          { originalTitle: 'Magnet Only', magnetUrl: `magnet:?xt=urn:btih:${'cd'.repeat(20)}`, extension: 'EPUB', size: 1048576, seedersDisplay: '4' },
          null,
          'nope',
        ],
      }),
    } as any;
  }) as unknown as typeof fetch;

  const res = await searchEbooks(EBOOK_URL, 'Dune', 'Frank Herbert', { fetchImpl: f });
  assert.deepEqual(JSON.parse(sent), { title: 'Dune', author: 'Frank Herbert', limit: 25, contentType: 'ebook' });
  assert.equal(res.length, 2);
  assert.equal(res[0].title, 'Dune');
  assert.equal(res[0].format, 'epub');
  assert.equal(res[0].sizeBytes, 1536);
  assert.equal(res[0].sizeLabel, '1.5 KB');
  assert.equal(res[0].infoHash, 'ab'.repeat(20));
  assert.equal(res[0].seeders, 12);
  assert.equal(res[1].title, 'Magnet Only');
  assert.equal(res[1].infoHash, 'cd'.repeat(20)); // derived from the magnet
  assert.equal(res[1].seeders, 4);
});

test('searchEbooks throws on a failed response', async () => {
  const f = (async () => ({ ok: false, status: 503, json: async () => ({}) } as any)) as unknown as typeof fetch;
  await assert.rejects(searchEbooks(EBOOK_URL, 'Dune', '', { fetchImpl: f }), /503/);
});

test('isHttpUrl accepts http(s) addresses and rejects anything else', () => {
  assert.ok(isHttpUrl('https://example.com/ebook/search'));
  assert.ok(isHttpUrl('  http://localhost:8080/ebook  '));
  assert.ok(!isHttpUrl(''));
  assert.ok(!isHttpUrl('example.com/ebook/search'));
  assert.ok(!isHttpUrl('ftp://example.com/ebook'));
  assert.ok(!isHttpUrl('javascript:alert(1)'));
  assert.ok(!isHttpUrl('https://'));
});

test('normalizeEbookResult drops hits with no magnet or info-hash', () => {
  assert.equal(normalizeEbookResult({ title: 'Nothing' }), null);
  const kept = normalizeEbookResult({ title: 'A', infoHash: 'ABCDEF' });
  assert.equal(kept?.infoHash, 'abcdef');
});

// --------------------------------------------------------------------------------------
// EPUB filtering and candidate ranking
// --------------------------------------------------------------------------------------

test('looksLikeEpub accepts the format or an .epub title, rejects others', () => {
  const c = (o: Partial<EbookResult>): EbookResult => ({
    title: 'x', format: '', sizeBytes: 0, sizeLabel: '', source: '', seeders: null, ...o,
  });
  assert.ok(looksLikeEpub(c({ format: 'EPUB' })));
  assert.ok(looksLikeEpub(c({ title: 'Dune.epub' })));
  assert.ok(looksLikeEpub(c({ url: 'https://x/book.epub' })));
  assert.ok(!looksLikeEpub(c({ format: 'mobi' })));
  assert.ok(!looksLikeEpub(c({ title: 'Dune.epub', format: 'mobi' })));
  assert.ok(!looksLikeEpub(c({ title: 'Dune' })));
});

test('rankCandidates floats cached hits first, then seeders, then size', () => {
  const h = (ch: string) => ch.repeat(40);
  const base = { format: 'epub', sizeBytes: 10, sizeLabel: '', source: '' };
  const rows: EbookResult[] = [
    { ...base, title: 'A-low', infoHash: h('a'), seeders: 1 },
    { ...base, title: 'B-high', infoHash: h('b'), seeders: 99 },
    { ...base, title: 'C-mid', infoHash: h('c'), seeders: 5 },
    { ...base, title: 'D-none', infoHash: h('d'), seeders: null, sizeBytes: 200 },
    { ...base, title: 'E-big', infoHash: h('e'), seeders: null, sizeBytes: 300 },
  ];
  const out = rankCandidates(rows, new Set([h('a')]));
  assert.deepEqual(out.map((r) => r.title), ['A-low', 'B-high', 'C-mid', 'E-big', 'D-none']);
  assert.deepEqual(out.map((r) => r.cached), [true, false, false, false, false]);
});

// --------------------------------------------------------------------------------------
// The shared job store
// --------------------------------------------------------------------------------------

test('the job store follows preparing -> download -> clip -> done, then error', () => {
  resetJob();
  assert.equal(getJob().status, 'idle');
  preparing('Searching for an EPUB…');
  assert.deepEqual(getJob(), { status: 'preparing', message: 'Searching for an EPUB…' });
  applyJobEvent({ event: 'start', files: 1, clips: 10 });
  assert.deepEqual(getJob(), { status: 'building', done: 0, total: 10 });
  applyJobEvent({ event: 'download', file: 0, bytes: 5, total: 20 });
  assert.deepEqual(getJob(), { status: 'downloading', bytes: 5, total: 20 });
  applyJobEvent({ event: 'clip', done: 3, total: 10, t: 30, file: 0, transcribed: true });
  assert.deepEqual(getJob(), { status: 'building', done: 3, total: 10 });
  applyJobEvent({ event: 'done', out: '/x/anchors.json', clips: 10, matched: 8, kept: 8, wpm_median: 150 });
  assert.deepEqual(getJob(), { status: 'done', matched: 8, total: 10 });
  applyJobEvent({ event: 'error', message: 'boom' });
  assert.deepEqual(getJob(), { status: 'error', message: 'boom' });
});

test('jobActive covers the running states only', () => {
  resetJob();
  assert.ok(!jobActive(getJob()));
  preparing('x');
  assert.ok(jobActive(getJob()));
  applyJobEvent({ event: 'done', out: '', clips: 1, matched: 1, kept: 1, wpm_median: null });
  assert.ok(!jobActive(getJob()));
});

test('job subscribers are notified and can unsubscribe', () => {
  resetJob();
  let calls = 0;
  const off = subscribeJob(() => calls++);
  preparing('a');
  applyJobEvent({ event: 'start', files: 1, clips: 2 });
  off();
  preparing('b');
  assert.equal(calls, 2);
});

// --------------------------------------------------------------------------------------
// Scope: series detection, defaults and the EPUB pick
// --------------------------------------------------------------------------------------

const MB = 1024 * 1024;

test('looksLikeSeries spots multi-book torrents', () => {
  assert.ok(looksLikeSeries([{ size: 400 * MB }, { size: 500 * MB }], 'Dune saga'));
  assert.ok(looksLikeSeries([{ size: 50 * MB }, { size: 50 * MB }], 'Complete Collection'));
  assert.ok(looksLikeSeries([{ size: 10 * MB }, { size: 10 * MB }], 'Books 1-3'));
  assert.ok(!looksLikeSeries([{ size: 100 * MB }, { size: 100 * MB }, { size: 100 * MB }], 'Dune'));
  assert.ok(!looksLikeSeries([{ size: 400 * MB }], 'Dune'));
});

test('defaultScope is all files unless the torrent looks like a series', () => {
  assert.equal(defaultScope([{ size: 1 * MB }], 'Dune'), 'all');
  assert.equal(defaultScope([{ size: 100 * MB }, { size: 100 * MB }], 'Dune'), 'all');
  assert.equal(defaultScope([{ size: 400 * MB }, { size: 500 * MB }], 'Dune'), 'current');
});

test('largestEpub picks the biggest .epub and ignores other files', () => {
  assert.equal(largestEpub([{ name: 'a.epub', size: 10 }, { name: 'b.EPUB', size: 20 }, { name: 'c.pdf', size: 999 }])?.name, 'b.EPUB');
  assert.equal(largestEpub([{ name: 'c.pdf', size: 1 }]), null);
});

// --------------------------------------------------------------------------------------
// cleanName: turning torrent/audio file names into search terms
// --------------------------------------------------------------------------------------

test('cleanName derives a title from an audio file path, dropping track/format noise', () => {
  const hp = cleanName(
    `01 Harry Potter and the Philosopher's Stone (FCE)/Harry Potter and the Philosopher\u2019s Stone [Opus 5.1ch Encode].opus`,
  );
  assert.equal(hp.title, "Harry Potter and the Philosopher's Stone");
  assert.equal(hp.author, '');
});

test('cleanName drops narrator/tag noise and keeps the title', () => {
  const lotr = cleanName('The Lord of the Rings (Chapterized) - Narrated by Andy Serkis - J R R Tolkien');
  assert.equal(lotr.title, 'The Lord of the Rings');
  assert.equal(lotr.author, 'J R R Tolkien');
});

test('cleanName handles Author-Title and Title-Author names', () => {
  const dune = cleanName('Frank Herbert-Dune-Read by George Guidall');
  assert.equal(dune.title, 'Dune');
  assert.equal(dune.author, 'Frank Herbert');

  const hail = cleanName('Andy Weir - Project Hail Mary');
  assert.equal(hail.title, 'Project Hail Mary');
  assert.equal(hail.author, 'Andy Weir');

  const titleFirst = cleanName('Dune - Frank Herbert');
  assert.equal(titleFirst.title, 'Dune');
  assert.equal(titleFirst.author, 'Frank Herbert');
});

test('cleanName prefers the known author and strips a codec-only torrent name', () => {
  const lotr = cleanName('The Lord of the Rings - J R R Tolkien', 'J R R Tolkien');
  assert.equal(lotr.title, 'The Lord of the Rings');
  assert.equal(lotr.author, 'J R R Tolkien');

  const hp = cleanName('Harry Potter - Opus 5 1ch Encode');
  assert.equal(hp.title, 'Harry Potter');
});

