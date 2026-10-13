import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDoc, SYNC_VERSION } from '../src/sync/merge';
import {
  BACKUP_VERSION, SETUP_VERSION, SECRET_KEYS, buildBackup, buildSetup, parseBackup, parseBackupText,
  parseSetup, parseImportFile, parseImportFileText, backupSummary, setupSummary, mergeBackupData, mergeSetupData,
  replaceDoc, type BackupData, type SetupData,
} from '../src/backup';

const src = (id: string, headers: Record<string, string> = {}): any => ({
  id, name: `Source ${id}`, type: 'json',
  search: { url: `https://example.com/${id}?q={query}`, headers: { Accept: 'application/json', ...headers } },
  results: { fields: { title: '{title}', magnet: '{magnet}' } },
});

const prog = (updated: number, position = 0): any =>
  ({ fileId: 1, chapterIndex: 0, chapterCount: 3, position, duration: 100, updated });

const data = (over: Partial<BackupData> = {}): BackupData => ({
  sync: emptyDoc(),
  sources: [src('a')],
  disabled: ['a'],
  ebookSearchUrl: 'https://ebooks.example/search',
  readalongServerUrl: 'https://readalong.example/api',
  hardcoverLinks: { '7': { bookId: 1, title: 'Dune' } },
  narrators: ['Scott Brick'],
  readElsewhere: [],
  ...over,
});

test('backup: build -> JSON -> parse round trips', () => {
  const file = buildBackup(data({ sync: { ...emptyDoc(), progress: { h1: prog(100) } } }), '1.3.8', 1700000000000);
  assert.equal(file.app, 'earmark');
  assert.equal(file.kind, 'backup');
  assert.equal(file.version, BACKUP_VERSION);
  assert.deepEqual(parseBackupText(JSON.stringify(file)), file);
});

test('backup: readable errors for the wrong file, newer version and bad sections', () => {
  assert.throws(() => parseBackupText('not json'), /Not valid JSON/);
  assert.throws(() => parseBackup({ app: 'other', kind: 'backup', data: {} }), /Not an Earmark backup/);
  assert.throws(() => parseBackup({ app: 'earmark', kind: 'notes', data: {} }), /not a backup/);
  assert.throws(() => parseBackup({ app: 'earmark', kind: 'backup', version: 99, data: {} }), /newer version/);
  assert.throws(() => parseBackup({ app: 'earmark', kind: 'backup', version: 1 }), /no data/);
  assert.throws(() => parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { sync: [] } }), /sync data is malformed/);
  assert.throws(() => parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { sources: {} } }), /sources are malformed/);
  assert.throws(() => parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { sources: [{ id: 'x' }] } }), /invalid source/);
  assert.throws(() => parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { disabled: [1] } }), /disabled-source list is malformed/);
});

test('backup: unknown extra fields are ignored', () => {
  const file = parseBackup({ app: 'earmark', kind: 'backup', version: 1, exportedAt: 5, appVersion: '9', data: { sync: {}, future: { a: 1 } }, extra: true });
  assert.equal(file.data.sync.v, SYNC_VERSION);
  assert.equal((file as any).extra, undefined);
  assert.equal((file.data.sync as any).future, undefined);
});

test('backup: carries no secure-storage key name and no token/key/secret field', () => {
  const file = buildBackup(data({ sources: [src('a', { 'x-api-key': 'user header' })] }), '1.3.8');
  const text = JSON.stringify(file);
  for (const k of SECRET_KEYS) assert.ok(!text.includes(k), `leaked ${k}`);
  const names: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { names.push(k.toLowerCase()); walk(val); }
  };
  walk(file);
  for (const bad of ['token', 'key', 'secret']) assert.ok(!names.includes(bad), `found field ${bad}`);
});

test('backup: summary counts what the file holds', () => {
  const file = buildBackup(data({
    sync: {
      ...emptyDoc(),
      progress: { a: prog(1), b: { ...prog(2), finished: true } },
      meta: { m1: { value: { title: 'X', rating: 4.5 }, updated: 1 }, m2: { value: { title: 'Y' }, updated: 1 } },
      wishlist: { '1': { value: { id: '1', title: 'W' }, updated: 1 }, '2': { value: null, updated: 1 } },
      readalong: { r1: { value: null, updated: 1 } },
    },
    sources: [src('a'), src('b')],
  }), '1.3.8');
  const s = backupSummary(file);
  assert.equal(s.withProgress, 2);
  assert.equal(s.finished, 1);
  assert.equal(s.ratings, 1);
  assert.equal(s.wishlist, 1);
  assert.equal(s.readalongs, 0);
  assert.equal(s.sources, 2);
});

test('backup merge: newest record wins, sources added by id, blanks filled only when empty', () => {
  const device = data({
    sync: { ...emptyDoc(), meta: { h: { value: { title: 'Old' }, updated: 10 } }, progress: { h1: prog(10, 1) } },
    sources: [src('a'), src('b')],
    ebookSearchUrl: '',
    readalongServerUrl: 'https://device.example',
    disabled: ['a'],
  });
  const file = data({
    sync: { ...emptyDoc(), meta: { h: { value: { title: 'New' }, updated: 20 } }, progress: { h1: prog(30, 9) } },
    sources: [src('a'), src('c')],
    ebookSearchUrl: 'https://file.example',
    readalongServerUrl: 'https://file.example',
    disabled: ['c'],
  });
  const m = mergeBackupData(device, file);
  assert.equal(m.sync.meta.h.value?.title, 'New');
  assert.equal(m.sync.progress.h1.position, 9);
  assert.deepEqual(m.sources.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(m.ebookSearchUrl, 'https://file.example');
  assert.equal(m.readalongServerUrl, 'https://device.example');
  assert.deepEqual([...m.disabled].sort(), ['a', 'c']);
});

test('backup merge: the EPUB search address follows the newest stamped record', () => {
  const older = data({
    sync: { ...emptyDoc(), ebookSearch: { value: 'https://device.example/search?q={query}', updated: 10 } },
    ebookSearchUrl: 'https://device.example/search?q={query}',
  });
  const newer = data({
    sync: { ...emptyDoc(), ebookSearch: { value: 'https://file.example/search?q={query}', updated: 20 } },
    ebookSearchUrl: 'https://file.example/search?q={query}',
  });
  assert.equal(mergeBackupData(older, newer).ebookSearchUrl, 'https://file.example/search?q={query}');
  assert.equal(mergeBackupData(newer, older).ebookSearchUrl, 'https://file.example/search?q={query}');
  // A deliberately cleared record (stamp > 0, value '') clears the top-level field too.
  const cleared = data({ sync: { ...emptyDoc(), ebookSearch: { value: '', updated: 30 } }, ebookSearchUrl: '' });
  assert.equal(mergeBackupData(older, cleared).ebookSearchUrl, '');
});

test('backup: narrators ride a backup, parse tolerantly, union on Merge and take the file on Replace', () => {
  // A backup from before this feature has no list, and one with junk in it keeps only real names.
  assert.deepEqual(parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { sync: {} } }).data.narrators, []);
  assert.deepEqual(parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { narrators: 'nope' } }).data.narrators, []);
  assert.deepEqual(parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { narrators: ['A', 1, '  '] } }).data.narrators, ['A']);

  const file = buildBackup(data({ narrators: ['J. Smith', 'Scott Brick'] }), '1.3.11');
  assert.deepEqual(parseBackupText(JSON.stringify(file)).data.narrators, ['J. Smith', 'Scott Brick']);

  // Merge unions by normalised name, keeping the device's own spelling first.
  const merged = mergeBackupData(data({ narrators: ['J Smith', 'Orlagh Cassidy'] }), file.data);
  assert.deepEqual(merged.narrators, ['J Smith', 'Orlagh Cassidy', 'Scott Brick']);
});

test('backup: read-elsewhere entries ride a backup, parse tolerantly and merge by id', () => {
  // A backup from before this feature has none, and junk entries are dropped rather than guessed at.
  assert.deepEqual(parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { sync: {} } }).data.readElsewhere, []);
  assert.deepEqual(parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { sync: {}, readElsewhere: 'nope' } }).data.readElsewhere, []);
  assert.deepEqual(
    parseBackup({ app: 'earmark', kind: 'backup', version: 1, data: { sync: {}, readElsewhere: [
      { id: 'x' }, { id: 'y', source: 'hardcover', title: 'The Quiet Machine' }, 7,
      { id: 'z', source: 'goodreads', title: 'Another', rating: 0, finishedAt: 0 },
    ] } }).data.readElsewhere,
    [{ id: 'y', source: 'hardcover', title: 'The Quiet Machine' }, { id: 'z', source: 'goodreads', title: 'Another' }],
  );

  const entry = (id: string, title: string): any => ({ id, source: 'goodreads', title });
  const file = buildBackup(data({ readElsewhere: [entry('gr:1', 'Mine')] }), '1.3.11');
  assert.deepEqual(parseBackupText(JSON.stringify(file)).data.readElsewhere, [entry('gr:1', 'Mine')]);

  // Merge keeps the device's entry where it has one and only adds the file's new ids.
  const device = data({ readElsewhere: [entry('gr:1', 'Device'), entry('gr:2', 'Keep')] });
  const merged = mergeBackupData(device, { ...data(), readElsewhere: [entry('gr:1', 'File'), entry('gr:3', 'New')] });
  assert.deepEqual(merged.readElsewhere.map((e) => e.id), ['gr:1', 'gr:2', 'gr:3']);
  assert.equal(merged.readElsewhere.find((e) => e.id === 'gr:1')?.title, 'Device');
});

test('backup replace: file records re-stamped, device-only records tombstoned', () => {  const device = {
    ...emptyDoc(),
    progress: { keep: prog(1), gone: prog(2) },
    meta: { h1: { value: { title: 'On device' }, updated: 5 }, h2: { value: { title: 'Only here' }, updated: 5 } },
    hidden: { hx: { value: true, updated: 5 } },
    wishlist: { '9': { value: { id: '9', title: 'X' }, updated: 5 } },
  };
  const file = { ...emptyDoc(), progress: { keep: prog(3, 7) }, meta: { h1: { value: { title: 'From file' }, updated: 1 } } };
  const out = replaceDoc(device, file, 1000);
  assert.equal(out.meta.h1.value?.title, 'From file');
  assert.equal(out.meta.h1.updated, 1000);
  assert.equal(out.meta.h2.value, null);
  assert.equal(out.meta.h2.updated, 1000);
  assert.equal(out.hidden.hx.value, null);
  assert.equal(out.hidden.hx.updated, 1000);
  assert.equal(out.wishlist['9'].value, null);
  assert.equal(out.progress.keep.position, 7);
  assert.equal(out.progress.keep.updated, 1000);
  assert.equal('gone' in out.progress, false);
  assert.equal(out.settings.updated, 1000);
  assert.equal(out.ebookSearch.value, '');
  assert.equal(out.ebookSearch.updated, 1000);
});

test('backup: Replace keeps the finish date of a book that only had its progress time', () => {
  const file = parseBackup(buildBackup({
    sync: { v: 1, progress: { aa: { fileId: 1, chapterIndex: 0, chapterCount: 1, position: 9, duration: 9, finished: true, updated: 5000 } },
      meta: {}, hidden: {}, wishlist: {}, readalong: {}, settings: { value: null, updated: 0 } } as any,
    sources: [], disabled: [], ebookSearchUrl: '', readalongServerUrl: '', hardcoverLinks: {},
  }, '1.0.0')).data.sync;
  const out = replaceDoc(file, file, 9000);
  assert.equal(out.progress.aa.updated, 9000);
  assert.equal(out.meta.aa.value?.finishedAt, 5000);
});

const setupData = (over: Partial<SetupData> = {}): SetupData => ({
  sources: [src('a')],
  disabled: ['a'],
  ebookSearchUrl: 'https://ebooks.example/search',
  ...over,
});

test('setup: build -> JSON -> parse round trips with kind setup', () => {
  const file = buildSetup(setupData({ sources: [src('a'), src('b')] }), '1.3.10', 1700000000000);
  assert.equal(file.app, 'earmark');
  assert.equal(file.kind, 'setup');
  assert.equal(file.version, SETUP_VERSION);
  assert.deepEqual(parseSetup(file), file);
  assert.deepEqual(parseImportFileText(JSON.stringify(file)), file);
});

test('setup: never carries progress, book details, ratings, read-alongs, links or secrets', () => {
  // The device has all of these; the setup file is built only from sources, disabled and the search address.
  const device = data({
    sync: { ...emptyDoc(), progress: { h1: prog(1) }, meta: { h: { value: { title: 'X', rating: 5 }, updated: 1 } },
      readalong: { r: { value: {}, updated: 1 } } },
  });
  const file = buildSetup({ sources: device.sources, disabled: device.disabled, ebookSearchUrl: device.ebookSearchUrl }, '1.3.10');
  assert.deepEqual(Object.keys(file.data).sort(), ['disabled', 'ebookSearchUrl', 'sources']);
  const text = JSON.stringify(file);
  for (const gone of ['"sync"', '"progress"', '"readalong"', '"hardcoverLinks"', '"readalongServerUrl"', '"rating"', '"finished"', '"narrators"']) {
    assert.ok(!text.includes(gone), `leaked ${gone}`);
  }
  for (const k of SECRET_KEYS) assert.ok(!text.includes(k), `leaked ${k}`);
});

test('setup: summary counts the sources and says whether a search address is in it', () => {
  assert.deepEqual(setupSummary(buildSetup(setupData({ sources: [src('a'), src('b')] }), '1.3.10')), { sources: 2, search: true });
  assert.deepEqual(setupSummary(buildSetup(setupData({ ebookSearchUrl: '' }), '1.3.10')), { sources: 1, search: false });
});

test('setup merge: adds unknown sources only, leaves disabled and an existing search address alone', () => {
  const device = setupData({ sources: [{ ...src('a'), name: 'Mine' }], disabled: ['a'], ebookSearchUrl: 'https://device.example/search' });
  const file = setupData({ sources: [{ ...src('a'), name: 'Theirs' }, src('c')], disabled: ['c'], ebookSearchUrl: 'https://file.example/search' });
  const m = mergeSetupData(device, file);
  assert.deepEqual(m.sources.map((s) => s.id), ['a', 'c']);
  assert.equal(m.sources.find((s) => s.id === 'a')?.name, 'Mine'); // existing source untouched
  assert.deepEqual(m.disabled, ['a']); // disabled list left alone
  assert.equal(m.ebookSearchUrl, 'https://device.example/search'); // kept when this device has one
  assert.equal(mergeSetupData({ ...device, ebookSearchUrl: '' }, file).ebookSearchUrl, 'https://file.example/search');
});

test('import: a backup still parses as a backup', () => {
  const file = parseImportFile(buildBackup(data(), '1.3.10'));
  assert.equal(file.kind, 'backup');
  if (file.kind === 'backup') {
    assert.equal(file.data.ebookSearchUrl, 'https://ebooks.example/search');
    assert.deepEqual(backupSummary(file).sources, 1);
  }
});

test('import: a setup file parses as one, and an unknown kind is rejected readably', () => {
  const file = parseImportFile(buildSetup(setupData(), '1.3.10'));
  assert.equal(file.kind, 'setup');
  assert.throws(() => parseImportFile({ app: 'earmark', kind: 'notes', data: {} }), /not an Earmark backup or setup/i);
  assert.throws(() => parseImportFile({ app: 'other', kind: 'setup', data: {} }), /not an Earmark/i);
  assert.throws(() => parseImportFileText('not json'), /Not valid JSON/);
});
