import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDoc, SYNC_VERSION } from '../src/sync/merge';
import {
  BACKUP_VERSION, SECRET_KEYS, buildBackup, parseBackup, parseBackupText, backupSummary, mergeBackupData, replaceDoc,
  type BackupData,
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

test('backup replace: file records re-stamped, device-only records tombstoned', () => {
  const device = {
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
