import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFullCast, fullCastShelf, type CatalogBook } from '../src/catalog';

const book = (id: string, title: string, description?: string): CatalogBook => ({ id, title, description });

test('catalog: mergeFullCast interleaves the queries, de-dupes and keeps only full cast', () => {
  const a = [book('1', 'Dune (Full Cast)'), book('2', 'The Broadcast'), book('3', 'GraphicAudio: Mistborn')];
  const b = [book('4', 'The Sandman [Dramatized Adaptation]'), book('1', 'Dune (Full Cast)')]; // duplicate id
  const c = [book('5', 'Forecast'), book('6', 'Plain Book', 'A full cast production of a classic')];
  assert.deepEqual(mergeFullCast([a, b, c]).map((x) => x.id), ['1', '4', '6', '3']);
});

test('catalog: mergeFullCast tolerates an empty query', () => {
  const a = [book('1', 'Dune (Full Cast)'), book('2', 'Dune')];
  assert.deepEqual(mergeFullCast([[], a, []]).map((x) => x.id), ['1']);
  assert.deepEqual(mergeFullCast([]), []);
});

// The shelf caches for half an hour, so the failing case runs before anything is cached.
test('catalog: fullCastShelf throws when every search fails', async () => {
  const all = ['dramatized adaptation', 'full cast', 'graphicaudio', 'audio drama', 'bbc radio drama'];
  await assert.rejects(fullCastShelf(fakeCatalog({}, all)), /full-cast/);
});

test('catalog: fullCastShelf merges the searches and skips one that fails', async () => {
  const row = (id: string, name: string, description?: string) => ({ collectionId: id, collectionName: name, description });
  const rows: Record<string, any[]> = {
    'dramatized adaptation': [row('1', 'Dune [Dramatized Adaptation]')],
    'full cast': [row('2', 'Mistborn (Full Cast)'), row('9', 'Plain Book')],
    graphicaudio: [row('3', 'GraphicAudio: Elantris')],
    'audio drama': [row('1', 'Dune [Dramatized Adaptation]')], // duplicate id
    'bbc radio drama': [row('4', 'A BBC radio drama')],
  };
  const books = await fullCastShelf(fakeCatalog(rows, ['graphicaudio']));
  assert.deepEqual(books.map((b) => b.id), ['1', '2', '4']);
});

// A catalogue search that answers by `term`, or fails for the terms it is told to.
function fakeCatalog(rowsByTerm: Record<string, any[]>, fail: string[] = []) {
  return (async (url: string) => {
    const term = decodeURIComponent(new URL(url).searchParams.get('term') ?? '');
    if (fail.includes(term)) return { ok: false, status: 500 } as any;
    return { ok: true, status: 200, json: async () => ({ results: rowsByTerm[term] ?? [] }) } as any;
  }) as unknown as typeof fetch;
}
