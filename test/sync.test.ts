import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocs, parseDoc, emptyDoc, docEquals, SYNC_VERSION } from '../src/sync/merge';

// Local aliases keep the test bodies readable; the merge module is imported as-is.
type Doc = ReturnType<typeof emptyDoc>;
const mk = (over: Record<string, unknown> = {}): Doc => ({ ...emptyDoc(), ...over } as Doc);
const prog = (updated: number, position = 0): any =>
  ({ fileId: 1, chapterIndex: 0, chapterCount: 3, position, duration: 100, updated });
const meta = (title: string, updated: number): any => ({ value: { title }, updated });
const tomb = (updated: number): any => ({ value: null, updated });

test('merge: newer progress wins in both directions', () => {
  const a = mk({ progress: { h1: prog(100, 10) } });
  const b = mk({ progress: { h1: prog(200, 20) } });
  assert.equal(mergeDocs(a, b).progress.h1.position, 20);
  assert.equal(mergeDocs(b, a).progress.h1.position, 20);
});

test('merge: records present on only one side are kept', () => {
  const a = mk({ meta: { h1: meta('A', 10) }, hidden: { h2: { value: true, updated: 5 } } });
  const b = mk({ meta: { h3: meta('B', 20) }, wishlist: { '42': { value: { id: '42', title: 'X' }, updated: 1 } } });
  const m = mergeDocs(a, b);
  assert.equal(m.meta.h1.value?.title, 'A');
  assert.equal(m.meta.h3.value?.title, 'B');
  assert.equal(m.hidden.h2.value, true);
  assert.equal(m.wishlist['42'].value?.title, 'X');
});

test('merge: tombstone beats older value, older tombstone loses to newer value', () => {
  const deleted = mergeDocs(
    mk({ hidden: { h: { value: true, updated: 10 } } }),
    mk({ hidden: { h: { value: false, updated: 20 } } }),
  );
  assert.equal(deleted.hidden.h.value, false);

  const revived = mergeDocs(mk({ meta: { h: tomb(10) } }), mk({ meta: { h: meta('Back', 20) } }));
  assert.equal(revived.meta.h.value?.title, 'Back');

  const gone = mergeDocs(mk({ meta: { h: meta('Old', 10) } }), mk({ meta: { h: tomb(20) } }));
  assert.equal(gone.meta.h.value, null);
});

test('merge: settings last-write-wins', () => {
  const a = mk({ settings: { value: { rate: 1.5, skipBack: 15, skipForward: 30 }, updated: 100 } });
  const b = mk({ settings: { value: { rate: 2, skipBack: 10, skipForward: 60 }, updated: 200 } });
  assert.equal(mergeDocs(a, b).settings.value?.rate, 2);
  assert.equal(mergeDocs(b, a).settings.value?.rate, 2);
});

test('merge: idempotent and commutative', () => {
  const a = mk({
    progress: { h: prog(100) },
    meta: { x: meta('X', 10) },
    settings: { value: { rate: 1, skipBack: 15, skipForward: 30 }, updated: 5 },
  });
  const b = mk({
    progress: { h: prog(200), g: prog(50) },
    meta: { y: meta('Y', 30) },
    hidden: { x: { value: false, updated: 9 } },
  });
  assert.deepEqual(mergeDocs(a, a), a);
  assert.deepEqual(mergeDocs(a, b), mergeDocs(b, a));
  const once = mergeDocs(a, b);
  assert.deepEqual(mergeDocs(once, b), once);
  assert.deepEqual(mergeDocs(once, a), once);
  assert.ok(docEquals(mergeDocs(a, b), mergeDocs(b, a)));
});

test('merge/parse: empty or missing remote leaves local intact, junk does not throw', () => {
  const local = mk({
    progress: { h: prog(10) },
    meta: { x: meta('X', 3) },
    settings: { value: { rate: 3, skipBack: 15, skipForward: 30 }, updated: 7 },
  });
  assert.deepEqual(mergeDocs(local, emptyDoc()), local);
  assert.deepEqual(mergeDocs(emptyDoc(), local), local);

  assert.deepEqual(parseDoc(null), emptyDoc());
  assert.deepEqual(parseDoc(undefined), emptyDoc());
  assert.deepEqual(parseDoc('not a document'), emptyDoc());
  assert.deepEqual(parseDoc({ meta: { h: 'garbage' }, progress: 7 }), emptyDoc());

  // Unknown top-level keys and a higher version survive parsing without throwing.
  const parsed = parseDoc({ ...emptyDoc(), v: 2, future: { a: 1 } });
  assert.equal(parsed.v, 2);
  assert.deepEqual((parsed as any).future, { a: 1 });
  assert.ok(parsed.v > SYNC_VERSION);
});

test('docEquals ignores explicit undefined fields, so nothing is rewritten needlessly', () => {
  const a = mk({ wishlist: { '1': { value: { id: '1', title: 'X', author: undefined }, updated: 5 } } });
  const b = mk({ wishlist: { '1': { value: { id: '1', title: 'X' }, updated: 5 } } });
  assert.ok(docEquals(a, b));
  assert.ok(docEquals(mergeDocs(a, b), b));
});

// ---- readalong ----
const rl = (sha: string, updated: number): any => ({
  value: {
    epub: { hash: 'h', fileId: 1, title: 'T', paragraphs: 2, paragraphsSha1: sha },
    files: [{ id: 1, duration: 10, anchors: [[0, 0, 0]] }],
    created: 1,
  },
  updated,
});

test('readalong: SYNC_VERSION is unchanged and emptyDoc carries an empty map', () => {
  assert.equal(SYNC_VERSION, 1);
  assert.deepEqual(emptyDoc().readalong, {});
});

test('readalong: parse keeps valid records, drops malformed ones, keeps tombstones', () => {
  const parsed = parseDoc({
    ...emptyDoc(),
    readalong: {
      good: rl('sha', 10),
      tomb: { value: null, updated: 5 },
      notObject: 'nope',
      badValue: { value: { epub: { hash: 'h' }, files: 'not an array' }, updated: 3 },
      badFile: { value: { epub: { hash: 'h', fileId: 1, paragraphs: 2, paragraphsSha1: 's' }, files: [{ id: 'x', duration: 1, anchors: [] }], created: 0 }, updated: 2 },
    },
  });
  assert.deepEqual(Object.keys(parsed.readalong).sort(), ['good', 'tomb']);
  assert.equal(parsed.readalong.good.value?.epub.paragraphsSha1, 'sha');
  assert.equal(parsed.readalong.tomb.value, null);
  assert.equal(parsed.readalong.tomb.updated, 5);
});

test('readalong: merge is last-write-wins and commutative', () => {
  const a = mk({ readalong: { h: rl('old', 10) } });
  const b = mk({ readalong: { h: rl('new', 20) } });
  assert.equal(mergeDocs(a, b).readalong.h.value?.epub.paragraphsSha1, 'new');
  assert.equal(mergeDocs(b, a).readalong.h.value?.epub.paragraphsSha1, 'new');
  assert.ok(docEquals(mergeDocs(a, b), mergeDocs(b, a)));
});

test('readalong: a newer tombstone wins; an older one loses to a newer value', () => {
  const deleted = mergeDocs(
    mk({ readalong: { h: rl('x', 10) } }),
    mk({ readalong: { h: { value: null, updated: 20 } } }),
  );
  assert.equal(deleted.readalong.h.value, null);

  const revived = mergeDocs(
    mk({ readalong: { h: { value: null, updated: 10 } } }),
    mk({ readalong: { h: rl('back', 20) } }),
  );
  assert.equal(revived.readalong.h.value?.epub.paragraphsSha1, 'back');
});

test('readalong: the word-timing mark survives parse and merge, unknown marks are dropped', () => {
  const base = rl('sha', 10);
  const timed = { ...base, value: { ...base.value, timing: 2 } };
  const parsed = parseDoc({ ...emptyDoc(), readalong: { h: timed } });
  assert.equal(parsed.readalong.h.value?.timing, 2);

  const merged = mergeDocs(
    mk({ readalong: { h: timed } }),
    mk({ readalong: { h: { ...timed, updated: 20 } } }),
  );
  assert.equal(merged.readalong.h.value?.timing, 2);

  // A mark we don't understand is simply dropped rather than carried or rejected.
  const junk = { ...base, value: { ...base.value, timing: 'later' } };
  const parsedJunk = parseDoc({ ...emptyDoc(), readalong: { h: junk } });
  assert.equal(parsedJunk.readalong.h.value?.timing, undefined);
  assert.equal(parsedJunk.readalong.h.value?.epub.paragraphsSha1, 'sha');
});

test('readalong: a future top-level key is still preserved as unknown', () => {
  const parsed = parseDoc({ ...emptyDoc(), v: 2, future: { a: 1 }, readalong: {} });
  assert.equal(parsed.v, 2);
  assert.deepEqual((parsed as any).future, { a: 1 });
  const merged = mergeDocs(mk({ future: { a: 1 } }), mk({ future: { a: 2 } }));
  assert.deepEqual((merged as any).future, { a: 2 });
});

test('meta: parse keeps a rating and a finish date, and drops junk ones', () => {
  const parsed = parseDoc({
    ...emptyDoc(),
    meta: {
      h: { value: { title: 'Dune', rating: 4.5, finishedAt: 1700000000000 }, updated: 5 },
      junk: { value: { rating: '4', finishedAt: -1 }, updated: 5 },
    },
  });
  assert.equal(parsed.meta.h.value?.rating, 4.5);
  assert.equal(parsed.meta.h.value?.finishedAt, 1700000000000);
  assert.equal(parsed.meta.junk.value?.rating, undefined);
  assert.equal(parsed.meta.junk.value?.finishedAt, undefined);
});

test('meta: a newer rating wins the merge, and clearing it survives', () => {
  const a = mk({ meta: { h: { value: { title: 'Dune', rating: 3 }, updated: 10 } } });
  const b = mk({ meta: { h: { value: { title: 'Dune', rating: 4.5, finishedAt: 1700000000000 }, updated: 20 } } });
  assert.equal(mergeDocs(a, b).meta.h.value?.rating, 4.5);
  assert.equal(mergeDocs(b, a).meta.h.value?.rating, 4.5);
  // A newer record without the fields is a clear: both disappear from the merge.
  const cleared = mk({ meta: { h: { value: { title: 'Dune' }, updated: 30 } } });
  assert.equal(mergeDocs(b, cleared).meta.h.value?.rating, undefined);
  assert.equal(mergeDocs(b, cleared).meta.h.value?.finishedAt, undefined);
});

// ---- ebookSearch: the read-along EPUB search address ----
const EBOOK = 'https://example.test/search?q={query}';
const EBOOK_A = 'https://a.example.test/search?q={query}';
/** A document as an older version wrote it: without the ebookSearch key at all. */
const oldDoc = (): Doc => { const d = emptyDoc() as any; delete d.ebookSearch; return d; };

test('ebookSearch: newest wins in both directions', () => {
  const a = mk({ ebookSearch: { value: EBOOK_A, updated: 100 } });
  const b = mk({ ebookSearch: { value: EBOOK, updated: 200 } });
  assert.equal(mergeDocs(a, b).ebookSearch.value, EBOOK);
  assert.equal(mergeDocs(b, a).ebookSearch.value, EBOOK);
  assert.equal(mergeDocs(a, b).ebookSearch.updated, 200);
});

test('ebookSearch: a never-set device adopts the synced value', () => {
  // The default record is a device that has never set the address: stamp 0, so it loses.
  const fresh = mk({ ebookSearch: { value: '', updated: 0 } });
  const synced = mk({ ebookSearch: { value: EBOOK, updated: 100 } });
  assert.equal(mergeDocs(fresh, synced).ebookSearch.value, EBOOK);
  assert.equal(mergeDocs(synced, fresh).ebookSearch.value, EBOOK);
  assert.equal(mergeDocs(fresh, synced).ebookSearch.updated, 100);
});

test('ebookSearch: an old-format document without the key merges cleanly', () => {
  const old = parseDoc(oldDoc());
  assert.deepEqual(old.ebookSearch, { value: '', updated: 0 });
  // A device with a real address keeps it when the other side simply has no such key.
  const local = mk({ ebookSearch: { value: EBOOK, updated: 100 } });
  assert.equal(mergeDocs(local, old).ebookSearch.value, EBOOK);
  assert.equal(mergeDocs(old, local).ebookSearch.value, EBOOK);
  // Two never-set documents stay schematically correct and gain nothing.
  assert.deepEqual(mergeDocs(parseDoc(oldDoc()), parseDoc(oldDoc())).ebookSearch, { value: '', updated: 0 });
});

test('ebookSearch: a document with the key survives a merge with one from an old version', () => {
  // A new-version document is written to a gist an old version also reads; that old version parses
  // it without the key and writes its own, so the merge sees the key on one side only.
  const withKey = parseDoc({ ...emptyDoc(), ebookSearch: { value: EBOOK, updated: 42 } });
  const withoutKey = parseDoc(oldDoc());
  assert.equal(mergeDocs(withKey, withoutKey).ebookSearch.value, EBOOK);
  assert.equal(mergeDocs(withoutKey, withKey).ebookSearch.value, EBOOK);
  assert.equal(mergeDocs(withKey, withoutKey).ebookSearch.updated, 42);
});

test('ebookSearch: deliberate clearing propagates', () => {
  const set = mk({ ebookSearch: { value: EBOOK, updated: 10 } });
  const cleared = mk({ ebookSearch: { value: '', updated: 20 } });
  assert.equal(mergeDocs(set, cleared).ebookSearch.value, '');
  assert.equal(mergeDocs(cleared, set).ebookSearch.value, '');
  assert.equal(mergeDocs(set, cleared).ebookSearch.updated, 20);
  // An older clear loses to a newer value, and clearing only applies once it is a stamped change.
  const newer = mk({ ebookSearch: { value: EBOOK_A, updated: 30 } });
  assert.equal(mergeDocs(cleared, newer).ebookSearch.value, EBOOK_A);
});

test('ebookSearch: parse keeps a string, drops junk and a missing key stays never-set', () => {
  const kept = parseDoc({ ...emptyDoc(), ebookSearch: { value: EBOOK, updated: 7 } });
  assert.deepEqual(kept.ebookSearch, { value: EBOOK, updated: 7 });
  assert.deepEqual(parseDoc({ ...emptyDoc(), ebookSearch: { value: 5, updated: 7 } }).ebookSearch, { value: '', updated: 0 });
  assert.deepEqual(parseDoc({ ...emptyDoc(), ebookSearch: 'nope' }).ebookSearch, { value: '', updated: 0 });
});
