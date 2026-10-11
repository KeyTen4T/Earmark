import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha1Hex } from '../src/scrapers/sha1';
import { torrentToMagnet, hashFromMagnet, utf8 } from '../src/scrapers/bencode';
import { render } from '../src/scrapers/template';
import { runSearch, resolveMagnet, validateScraper, fetchDetail } from '../src/scrapers/engine';
import { LIBRIVOX, AUDIOBOOKBAY } from '../src/scrapers/builtin';
// The one-time built-in migration is pure; give it its own file.
import './scrapers-merge.test.ts';
// Sync's pure merge module has its own file; register its tests under the same `npm test` run.
import './sync.test.ts';
// Stream recovery and book maths are pure too; give them their own files as well.
import './recovery.test.ts';
import './book-math.test.ts';
import './downloads.test.ts';
// Position extrapolation for the read-along highlight is pure.
import './position.test.ts';
// Background visibility: when a status update may reach React and when a progress bar animates.
import './visibility.test.ts';
// Read-along EPUB parsing, tokenising and locate() are pure too.
import './readalong.test.ts';
// The read-along build's pure pieces: ebook search, the shared job store and scope rules.
import './readalong-create.test.ts';
// The read-along server client: URL joining, error mapping, validation, pending jobs, build path.
import './readalong-server.test.ts';
// The Xing/VBR seek map: the media3 player model and its true-time table.
import './mp3seek.test.ts';
// The read-along seek-target tracking and player-time/true-time boundary conversion.
import './seekbase.test.ts';
// Matching an Open Library result to a torrent name before filling in a missing title.
import './title-match.test.ts';
// The library's own search: title, author and narrator matching for the shelf.
import './library-search.test.ts';
// Ratings and reviews on a Discover book's detail page: title cleaning, matching and formatting.
import './ratings.test.ts';
// Full-cast and dramatised detection for the sources list.
import './cast.test.ts';
// Following narrators: name splitting, normalising, toggling and floating followed results up.
import './narrators.test.ts';
// Which content the wide player's second pane shows, and when it splits at all.
import './panes.test.ts';
// Chapters embedded inside a single audio file (MP4 chpl/QuickTime track, MP3 ID3v2 CHAP) and the
// HTTP range reader that fetches just enough to find them.
import './chapters.test.ts';
// The idle-chrome timings and the tap-to-seek guard for immersive reading.
import './idle-chrome.test.ts';
// Reading stored JSON: telling a corrupt value (kept as a backup) from a missing one.
import './stored-json.test.ts';
// The update check's version ordering, release parsing and note summary are pure.
import './update.test.ts';
// The finished shelf: year grouping, finish dates and half-star rating taps are pure.
import './shelf.test.ts';
// Importing a reading history from Hardcover or a Goodreads export: matching and the pure plan.
import './reading-history.test.ts';
// The Goodreads CSV reader and its read-row mapping.
import './goodreads.test.ts';
import './library-poll.test.ts';
// Backup files and their build/parse/merge/replace logic are pure too.
import './backup.test.ts';
// The narrator preview's decisions and its fake-driven controller are pure.
import './preview.test.ts';
// The car-mode screen's chapter line and current-file progress/remaining time are pure.
import './car-mode.test.ts';

test('sha1 matches node crypto across lengths', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000, 70000]) {
    const b = randomBytes(n);
    assert.equal(sha1Hex(new Uint8Array(b)), createHash('sha1').update(b).digest('hex'), `len ${n}`);
  }
});

function benc(v: any): Buffer {
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return benc(Buffer.from(v));
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(benc), Buffer.from('e')]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [benc(k), benc(v[k])]), Buffer.from('e')]);
}

test('torrentToMagnet computes info hash, trackers, webseeds, size', () => {
  const info = { name: 'Sherlock – Ü', 'piece length': 16384, pieces: randomBytes(40),
    files: [{ length: 1000, path: ['01.mp3'] }, { length: 2500, path: ['02.mp3'] }] };
  const t = benc({ announce: 'http://a/announce', 'announce-list': [['http://a/announce'], ['udp://b:80']],
    'url-list': ['https://archive.org/download/'], info });
  const want = createHash('sha1').update(benc(info)).digest('hex');
  const r = torrentToMagnet(new Uint8Array(t));
  assert.equal(r.infoHash, want);
  assert.equal(r.name, 'Sherlock – Ü');
  assert.equal(r.totalSize, 3500);
  assert.match(r.magnet, new RegExp(`^magnet:\\?xt=urn:btih:${want}&dn=`));
  assert.equal((r.magnet.match(/&tr=/g) ?? []).length, 2);
  assert.ok(r.magnet.includes('&ws=https%3A%2F%2Farchive.org%2Fdownload%2F'));
});

test('hashFromMagnet handles hex and base32', () => {
  const hex = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
  assert.equal(hashFromMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=x`), hex);
  // base32 of the same 20 bytes
  const b = Buffer.from(hex, 'hex');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = ''; for (const x of b) bits += x.toString(2).padStart(8, '0');
  let b32 = ''; for (let i = 0; i < 160; i += 5) b32 += A[parseInt(bits.slice(i, i + 5), 2)];
  assert.equal(hashFromMagnet(`magnet:?xt=urn:btih:${b32}`), hex);
});

test('utf8 decoder', () => {
  const s = 'héllo – 日本 🎧';
  assert.equal(utf8(new Uint8Array(Buffer.from(s))), s);
});

test('template filters and fallbacks', () => {
  const v = { a: { b: ['x', 'y'] }, t: '  <b>Tom &amp; Jerry</b>  ', n: 1536, empty: '', rel: '/dl/1' };
  assert.equal(render('{a.b|first}', v), 'x');
  assert.equal(render('{a.b}', v), 'x, y');
  assert.equal(render('{a.b.1}', v), 'y');
  assert.equal(render('{t|clean}', v), 'Tom & Jerry');
  assert.equal(render('{n|bytes}', v), '1.5 KB');
  assert.equal(render('{empty||t|trim|striptags}', v), '<b>Tom &amp; Jerry</b>'.replace(/<[^>]*>/g, ''));
  assert.equal(render("{missing|default:none}", v), 'none');
  assert.equal(render("{missing||'lit'}", v), 'lit');
  assert.equal(render('{rel|abs}', v, 'https://ex.com/s/page'), 'https://ex.com/dl/1');
  assert.equal(render('{{x}} {q|urlencode}', { q: 'a b&c' }), '{x} a%20b%26c');
  assert.equal(render('{t|regex:Tom (.*?);}', v), '&amp');
});

const fakeFetch = (routes: Record<string, any>) => (async (url: string) => {
  const key = Object.keys(routes).find((k) => url.includes(k));
  if (!key) return { ok: false, status: 404 } as any;
  const body = routes[key];
  return {
    ok: true, status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => { const b = body as Buffer; return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
  } as any;
}) as unknown as typeof fetch;

test('LibriVox built-in parses archive.org response and resolves torrent', async () => {
  validateScraper(LIBRIVOX);
  const info = { name: 'adventures_holmes', 'piece length': 16384, pieces: randomBytes(20), length: 10 };
  const tor = benc({ announce: 'http://bt1.archive.org:6969/announce', info });
  const f = fakeFetch({
    'advancedsearch.php': { response: { docs: [
      { identifier: 'adventures_holmes', title: 'Adventures of Sherlock Holmes', creator: ['Arthur Conan Doyle'], item_size: 524288000, runtime: '12:30:00' },
    ] } },
    '_archive.torrent': tor,
  });
  const res = await runSearch(LIBRIVOX, 'sherlock holmes', f);
  assert.equal(res.length, 1);
  assert.equal(res[0].author, 'Arthur Conan Doyle');
  assert.equal(res[0].size, '500.0 MB');
  assert.equal(res[0].cover, 'https://archive.org/services/img/adventures_holmes');
  const mag = await resolveMagnet(LIBRIVOX, res[0], f);
  assert.ok(mag.startsWith('magnet:?xt=urn:btih:' + createHash('sha1').update(benc(info)).digest('hex')));
});

test('AudioBookBay built-in parses a listing and resolves the info hash', async () => {
  validateScraper(AUDIOBOOKBAY);
  const post = (href: string, title: string, size: string) =>
    `<div class="post"><div class="postTitle"><h2><a href="${href}" rel="bookmark">${title}</a></h2></div><div class="postInfo">Language: English<br /></div>` +
    `<div class="postContent"><div class="center">\n<p class="center"><a href="${href}"><img src="https://img.example/c.jpg" alt="x" width="250" /></a></p>\n</div>\n` +
    `<p style='text-align:center;'>Posted: 19 Apr 2026<br />Format: <span style='color:#a00;'>M4B</span><br />File Size: <span style='color:#00f;'>${size}</span> MBs</p>\n</div>\n<div class='postMeta'><span></span></div></div>`;
  const hash = '8E261769F4EFC48DC7F7F8F8C2DD6D0CC6C19BE9';
  const f = fakeFetch({
    '?s=': post('/abss/lost-souls/', 'Frankenstein - Lost Souls - Dean Koontz', '475.84') + post('/abss/untitled/', 'No Author Here', '12.5'),
    '/abss/lost-souls/': `<table><tr>\n<td>Tracker:</td>\n<td>udp://t.example:1337/announce</td>\n</tr><tr>\n<td>Tracker:</td>\n<td>http://t2.example/announce</td>\n</tr>` +
      `<tr>\n<td>Tracker:</td>\n<td>udp://t.example:1337/announce</td>\n</tr><tr>\n<td>Info Hash:</td>\n<td>${hash}</td>\n</tr></table>`,
  });
  const res = await runSearch(AUDIOBOOKBAY, 'Frankenstein', f);
  assert.equal(res.length, 2);
  assert.equal(res[0].title, 'Frankenstein - Lost Souls');
  assert.equal(res[0].author, 'Dean Koontz');
  assert.equal(res[0].size, '475.84 MB');
  assert.equal(res[0].cover, 'https://img.example/c.jpg');
  assert.equal(res[0].detailUrl, 'https://audiobookbay.lu/abss/lost-souls/');
  assert.equal(res[1].title, 'No Author Here');
  assert.equal(res[1].author, undefined);
  const mag = await resolveMagnet(AUDIOBOOKBAY, res[0], f);
  assert.ok(mag.startsWith(`magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=`));
  assert.ok(mag.endsWith('&tr=udp%3A%2F%2Ft.example%3A1337%2Fannounce&tr=http%3A%2F%2Ft2.example%2Fannounce'), mag);
});

test('AudioBookBay detail page yields the narrator and info hash in one fetch', async () => {
  const hash = '8E261769F4EFC48DC7F7F8F8C2DD6D0CC6C19BE9';
  const detail =
    `<p style="left;">Written by <a href="/?s=frank+herbert&#038;tt=1"><span class="author" itemprop="author">Frank Herbert</span></a> <br />Read by ` +
    `<a href="/?s=scott+brick"><span class="narrator" itemprop="author">Scott Brick</span></a>, ` +
    `<a href="/?s=orlagh+cassidy"><span class="narrator" itemprop="author">Orlagh Cassidy</span></a>, ` +
    `<a href="/?s=euan+morton"><span class="narrator" itemprop="author">Euan Morton</span></a>, ` +
    `<a href="/?s=simon+vance"><span class="narrator" itemprop="author">Simon Vance</span></a> <br />Format: <span class="format">M4B</span></p>` +
    `<table><tr>\n<td>Info Hash:</td>\n<td>${hash}</td>\n</tr></table>`;
  let calls = 0;
  const f = (async () => {
    calls++;
    return { ok: true, status: 200, text: async () => detail } as any;
  }) as unknown as typeof fetch;
  const item = { id: 'x', scraperId: AUDIOBOOKBAY.id, scraperName: AUDIOBOOKBAY.name, title: 'Dune', detailUrl: 'https://audiobookbay.lu/abss/dune/', vars: {} } as any;
  const d = await fetchDetail(AUDIOBOOKBAY, item, f);
  assert.equal(calls, 1);
  assert.equal(d.narrator, 'Scott Brick, Orlagh Cassidy, Euan Morton, Simon Vance');
  assert.equal(d.infoHash, hash.toLowerCase());
  assert.ok(d.magnet?.startsWith(`magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=`));
  // Storing the magnet means adding the result does not fetch the page a second time.
  const withDetail = { ...item, ...d };
  assert.ok((await resolveMagnet(AUDIOBOOKBAY, withDetail, f)).startsWith('magnet:?xt=urn:btih:'));
  assert.equal(calls, 1);
});

test('html scraper with detail page', async () => {
  const def = validateScraper({
    id: 'demo', name: 'Demo', type: 'html', baseUrl: 'https://demo.test',
    search: { url: 'https://demo.test/search?q={query|urlencode}' },
    results: {
      itemRegex: '<div class="r"><a href="(?<href>[^"]+)">(?<title>[^<]+)</a><span>(\\d+) seeds</span></div>',
      fields: { title: '{title|clean}', seeders: '{3}', detailUrl: '{href|abs}' },
    },
    detail: { regex: 'href="(magnet:[^"]+)"', fields: { magnet: '{1|decode}' } },
  });
  const html = '<div class="r"><a href="/b/1">Book &amp; One</a><span>12 seeds</span></div>' +
               '<div class="r"><a href="/b/2">Two</a><span>3 seeds</span></div>';
  const f = fakeFetch({ '/search?q=foo%20bar': html, '/b/1': '<a href="magnet:?xt=urn:btih:abc&amp;dn=x">m</a>' });
  const res = await runSearch(def, 'foo bar', f);
  assert.deepEqual(res.map((r) => [r.title, r.seeders, r.detailUrl]), [
    ['Book & One', '12', 'https://demo.test/b/1'], ['Two', '3', 'https://demo.test/b/2']]);
  assert.equal(await resolveMagnet(def, res[0], f), 'magnet:?xt=urn:btih:abc&dn=x');
});

test('provider.json sources import and search', async () => {
  const { isProvider, providerToScraper } = await import('../src/scrapers/provider');
  const provider = {
    schemaVersion: '1.0.0', id: 'ff', name: 'Example Provider', version: '1.0.0',
    adapters: { search: {
      request: { method: 'POST', url: 'https://example.com/all/search?x=1', headers: { 'Content-Type': 'application/json' },
        body: { title: '{TITLE}', author: '{AUTHOR}', limit: 120 } },
      response: { type: 'json', resultsPath: 'results', mapping: { title: 'originalTitle', cleanTitle: 'cleanTitle', url: 'url', magnetUrl: 'magnetUrl', infoHash: 'infoHash', mediaType: 'mediaType', author: 'author', sizeBytes: 'sizeBytes' } },
    } },
  };
  assert.ok(isProvider(provider));
  assert.ok(!isProvider(LIBRIVOX));
  const def = validateScraper(providerToScraper(provider));
  assert.equal(def.version, 1);

  let sentBody = '';
  const f = (async (url: string, init: any) => {
    sentBody = init?.body;
    return fakeFetch({ 'example.com': { results: [
      { cleanTitle: 'Pride and Prejudice', author: 'Jane Austen', narrator: ['Rosamund Pike', 'Adjoa Andoh'], mediaType: 'audiobook', url: 'https://www.archive.org/download/PrideAndPrejudice/part1.m4b' },
      { cleanTitle: 'Pride and Prejudice (ebook)', mediaType: 'ebook', url: 'https://archive.org/download/pp_text/pp.epub' },
      { cleanTitle: 'Gutenberg copy', mediaType: 'both', url: 'https://www.gutenberg.org/ebooks/1342' },
      { originalTitle: 'Some Torrent', mediaType: 'audiobook', magnetUrl: 'magnet:?xt=urn:btih:ABC', infoHash: 'ABC', sizeBytes: 1048576 },
    ] } })(url);
  }) as unknown as typeof fetch;

  const res = await runSearch(def, 'Say "hi"', f);
  assert.deepEqual(JSON.parse(sentBody), { title: 'Say "hi"', author: '', limit: 120 });
  // ebook row and the non-torrentable Gutenberg row are dropped
  assert.deepEqual(res.map((r) => r.title), ['Pride and Prejudice', 'Some Torrent']);
  assert.equal(res[0].torrentUrl, 'https://archive.org/download/PrideAndPrejudice/PrideAndPrejudice_archive.torrent');
  assert.equal(res[0].author, 'Jane Austen');
  // A provider may give the narrators as an array; every name is kept, not just the first.
  assert.equal(res[0].narrator, 'Rosamund Pike, Adjoa Andoh');
  assert.equal(res[1].infoHash, 'abc');
  assert.equal(res[1].size, '1.0 MB');
});

test('library keeps audiobooks and drops movies and shows', async () => {
  const { looksLikeAudiobook } = await import('../src/torbox');
  const t = (name: string, files: any[] | null, ready = true, state = 'cached') =>
    ({ id: 1, name, hash: 'h', size: 0, download_finished: ready, download_present: ready, progress: 1, download_state: state, files }) as any;
  const f = (name: string, size: number) => ({ id: 1, name, size });
  // by files
  assert.ok(looksLikeAudiobook(t('Dune', [f('Dune/01.mp3', 5e8), f('Dune/cover.jpg', 1e5)])));
  assert.ok(!looksLikeAudiobook(t('Sex and the City 2008 Extended', [f('satc.mkv', 4e9), f('sample.mp3', 2e6)])));
  assert.ok(!looksLikeAudiobook(t('Some Show S01', [f('e01.mkv', 1e9)], false, 'expired')));
  assert.ok(looksLikeAudiobook(t('Book with video extra', [f('book.m4b', 6e8), f('trailer.mp4', 2e7)])));
  // by name, when TorBox lists no files
  assert.ok(!looksLikeAudiobook(t('Project Hail Mary 2026 DV 2160p WEB-DL', null, false, 'expired')));
  assert.ok(!looksLikeAudiobook(t('Sex.and.the.City.2008.Extended', [], false, 'expired')));
  assert.ok(!looksLikeAudiobook(t('J R R Tolkien Animated Films Set', null, false, 'expired')));
  assert.ok(looksLikeAudiobook(t('Dune 2 - Dune Messiah - Frank Herbert', null, false, 'downloading')));
  assert.ok(looksLikeAudiobook(t('dune-audiobook-unabridged-frank-herbert 1080p', null, false, 'incomplete')));
  assert.ok(!looksLikeAudiobook(t('Finished but empty', [], true)));
});

test('validation errors are helpful', () => {
  assert.throws(() => validateScraper({ id: 'x', name: 'x', type: 'json', search: { url: 'https://x' }, results: { fields: { title: '{t}' } } }), /\{query\}/);
  assert.throws(() => validateScraper({ id: 'x', name: 'x', type: 'json', search: { url: 'https://x?q={query}' }, results: { fields: { title: '{t}' } } }), /magnet, infoHash/);
});

test('hardcover listenedSeconds estimate', async () => {
  const { listenedSeconds } = await import('../src/hardcover-math');
  // three equal files, halfway through the second, each 600s long
  assert.equal(listenedSeconds([100, 100, 100], 1, 300, 600), 900);
  // scaled to edition length of 3000s: (100 + 50)/300 * 3000
  assert.equal(listenedSeconds([100, 100, 100], 1, 300, 600, 3000), 1500);
  assert.equal(listenedSeconds([100, 200], 0, 0, 0), 0);
});

test('bundled example scrapers validate', async () => {
  const fs = await import('node:fs');
  for (const f of fs.readdirSync('scrapers')) {
    const def = JSON.parse(fs.readFileSync(`scrapers/${f}`, 'utf8'));
    validateScraper(def);
  }
});

test('a provider.json source keeps its published rate limit and retries once on 429', async () => {
  const { providerToScraper } = await import('../src/scrapers/provider');
  const def = validateScraper(providerToScraper({
    schemaVersion: '1.0.0', id: 'rl', name: 'Example', version: '1.0.0', rateLimit: { requestsPerMinute: 2, retryAfterMs: 1 },
    adapters: { search: {
      request: { method: 'POST', url: 'https://example.com/search', headers: { 'Content-Type': 'application/json' }, body: { title: '{TITLE}', author: '{AUTHOR}', limit: 120 } },
      response: { type: 'json', resultsPath: 'results', mapping: { title: 'originalTitle', magnetUrl: 'magnetUrl', infoHash: 'infoHash' } },
    } },
  }));
  assert.equal(def.id, 'provider-rl');
  assert.deepEqual(def.rateLimit, { requestsPerMinute: 2, retryAfterMs: 1 });
  let calls = 0, sent = '';
  const f = (async (_u: string, init: any) => {
    sent = init.body;
    if (++calls === 1) return { ok: false, status: 429 } as any; // retried once after retryAfterMs
    return { ok: true, status: 200, json: async () => ({ results: [{ originalTitle: 'Dune', infoHash: 'AB'.repeat(20) }] }) } as any;
  }) as unknown as typeof fetch;
  const res = await runSearch(def, 'Dune "x"', f);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(sent), { title: 'Dune "x"', author: '', limit: 120 });
  assert.equal(res[0].infoHash, 'ab'.repeat(20));
  await runSearch(def, 'Dune', f);
  await assert.rejects(runSearch(def, 'Dune', f), /allows 2 searches a minute/);
});

test('dedupeResults merges by info hash, else by title + author + size', async () => {
  const { dedupeResults } = await import('../src/scrapers/engine');
  const row = (o: any) => ({ id: String(Math.random()), scraperId: 's', scraperName: 'S', vars: {}, ...o });
  const h = 'a'.repeat(40);
  const out = dedupeResults([
    row({ title: 'Dune', infoHash: h }),
    row({ title: 'Dune (Unabridged)', magnet: `magnet:?xt=urn:btih:${h.toUpperCase()}&dn=x` }), // same torrent
    row({ title: 'Dune', author: 'Frank Herbert', size: '500.0 MB', detailUrl: 'a' }),
    row({ title: 'DUNE!', author: 'frank herbert', size: '500.0 MB', detailUrl: 'b' }), // same listing twice
    row({ title: 'Dune', author: 'Frank Herbert', size: '1.20 GB', detailUrl: 'c' }), // another edition
  ]);
  assert.deepEqual(out.map((r) => r.detailUrl ?? r.title), ['Dune', 'a', 'c']);
});

test('recommend picks a candidate through Gemini and Groq, key in a header', async () => {
  const { recommend, providerFor } = await import('../src/recommend');
  assert.equal(providerFor('  '), null);
  assert.equal(providerFor(' "AQ.newStyleGoogleKey"\n'), 'gemini');
  assert.equal(providerFor('Bearer gsk_x'), 'groq');
  const history = [{ title: 'Dune', author: 'Frank Herbert', status: 'finished' as const }];
  const cands = [{ id: '1', title: 'Hyperion' }, { id: '2', title: 'Verity' }];
  const calls: { url: string; init: any }[] = [];
  const reply = (body: any) => ({ ok: true, status: 200, json: async () => body }) as any;
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.includes('googleapis') && url.includes('/models?')) return reply({ models: [
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-9-flash', supportedGenerationMethods: ['generateContent'] }] });
    if (url.includes(':generateContent')) return reply({ candidates: [{ content: { parts: [{ text: '{"id":"1","reason":"Like Dune."}' }] } }] });
    if (url.endsWith('/models')) return reply({ data: [{ id: 'whisper-large' }, { id: 'llama-3.3-70b-versatile' }] });
    return reply({ choices: [{ message: { content: 'Sure! {"id": "7", "reason": "x"}' } }] });
  }) as unknown as typeof fetch;

  assert.deepEqual(await recommend('AIzaTEST', history, cands, [], f), { id: '1', reason: 'Like Dune.' });
  assert.ok(calls[1].url.endsWith('/models/gemini-9-flash:generateContent'));
  assert.ok(calls.every((c) => !c.url.includes('AIzaTEST') && c.init.headers['x-goog-api-key'] === 'AIzaTEST'));
  assert.match(JSON.parse(calls[1].init.body).contents[0].parts[0].text, /Dune by Frank Herbert \(finished\)[\s\S]*1 \| Hyperion/);

  // Groq answers with an id that isn't a candidate: refuse it rather than show a made-up book.
  await assert.rejects(recommend('gsk_TEST', history, cands, [], f), /didn’t pick a book from the list/);
  assert.equal(JSON.parse(calls[calls.length - 1].init.body).model, 'llama-3.3-70b-versatile');
  assert.equal(calls[calls.length - 1].init.headers.Authorization, 'Bearer gsk_TEST');
});
