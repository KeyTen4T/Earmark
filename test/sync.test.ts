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
