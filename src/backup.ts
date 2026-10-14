// The backup and setup file shapes, plus the pure logic to build, parse, summarise, merge and
// replace them. Deliberately free of React Native and Expo imports so it runs under the plain Node
// test runner (test/backup.test.ts). A backup carries the sync document verbatim, reusing
// ../sync/merge's parser and merge rather than inventing a second format; a setup file is the much
// smaller file one person hands to another. Nothing that lives in secure storage is ever read here
// (or written by the caller): see SECRET_KEYS.

import { emptyDoc, parseDoc, mergeDocs, SYNC_VERSION, type SyncDoc, type Stamped } from './sync/merge';
import { validateScraper, type ScraperDef } from './scrapers/engine';
import { unionNarrators } from './narrators';
import type { ReadElsewhere } from './reading-history';

export const BACKUP_VERSION = 1;
export const SETUP_VERSION = 1;
export const BACKUP_APP = 'earmark';

/** Secure-storage key names. A backup must never mention one of these. */
export const SECRET_KEYS = ['torbox_api_key', 'ai_api_key', 'github_sync_token', 'hardcover_token', 'readalong_server_token'];

/** Everything a backup carries. `sync` is the gist document's exact shape. */
export type BackupData = {
  sync: SyncDoc;
  sources: ScraperDef[];
  disabled: string[];
  ebookSearchUrl: string;
  readalongServerUrl: string;
  hardcoverLinks: Record<string, unknown>;
  narrators: string[];
  readElsewhere: ReadElsewhere[];
};

export type BackupFile = {
  app: typeof BACKUP_APP;
  kind: 'backup';
  version: number;
  exportedAt: number;
  appVersion: string;
  data: BackupData;
};

/**
 * The small file behind Settings → Backup → Share my setup: the user's own sources, the disabled
 * ids and the EPUB search address, nothing else. No progress, book details, ratings, wishlist,
 * read-alongs, Hardcover links, read-along server URL or secret ever reaches it.
 */
export type SetupData = {
  sources: ScraperDef[];
  disabled: string[];
  ebookSearchUrl: string;
};

export type SetupFile = {
  app: typeof BACKUP_APP;
  kind: 'setup';
  version: number;
  exportedAt: number;
  appVersion: string;
  data: SetupData;
};

/** A file the Import data row accepts, told apart by `kind`. */
export type ImportFile = BackupFile | SetupFile;

export type BackupSummary = {
  exportedAt: number;
  appVersion: string;
  withProgress: number;
  finished: number;
  ratings: number;
  wishlist: number;
  readalongs: number;
  sources: number;
  readElsewhere: number;
};

export type SetupSummary = {
  sources: number;
  search: boolean;
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function buildBackup(data: BackupData, appVersion: string, now = Date.now()): BackupFile {
  return { app: BACKUP_APP, kind: 'backup', version: BACKUP_VERSION, exportedAt: now, appVersion, data };
}

export function buildSetup(data: SetupData, appVersion: string, now = Date.now()): SetupFile {
  return { app: BACKUP_APP, kind: 'setup', version: SETUP_VERSION, exportedAt: now, appVersion, data };
}

/** Reads the sources section of a file, rejecting anything an import would not be able to run. */
function readSources(d: Record<string, unknown>, what: string): ScraperDef[] {
  const sources: ScraperDef[] = [];
  if (d.sources === undefined) return sources;
  if (!Array.isArray(d.sources)) throw new Error(`The ${what}'s sources are malformed`);
  for (const s of d.sources) {
    if (!isObj(s)) throw new Error(`The ${what}'s sources are malformed`);
    try { sources.push(validateScraper(s)); }
    catch (e: any) { throw new Error(`The ${what} has an invalid source: ${e.message}`); }
  }
  return sources;
}

function readDisabled(d: Record<string, unknown>, what: string): string[] {
  if (d.disabled === undefined) return [];
  if (!Array.isArray(d.disabled) || d.disabled.some((x) => typeof x !== 'string')) throw new Error(`The ${what}'s disabled-source list is malformed`);
  return d.disabled as string[];
}

/** Followed narrators, read tolerantly: a file from before this feature simply has none. */
function readNarrators(d: Record<string, unknown>): string[] {
  if (!Array.isArray(d.narrators)) return [];
  return d.narrators.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
}

/** Books read elsewhere, read tolerantly: a file from before this feature has none, junk is dropped. */
function readReadElsewhere(d: Record<string, unknown>): ReadElsewhere[] {
  if (!Array.isArray(d.readElsewhere)) return [];
  const out: ReadElsewhere[] = [];
  for (const e of d.readElsewhere) {
    if (!isObj(e)) continue;
    const source = e.source === 'hardcover' || e.source === 'goodreads' ? e.source : null;
    const id = typeof e.id === 'string' ? e.id : '';
    const title = typeof e.title === 'string' ? e.title : '';
    if (!id || !source || !title) continue;
    const entry: ReadElsewhere = { id, source, title };
    if (typeof e.author === 'string' && e.author) entry.author = e.author;
    if (typeof e.cover === 'string' && e.cover) entry.cover = e.cover;
    if (typeof e.finishedAt === 'number' && e.finishedAt > 0) entry.finishedAt = e.finishedAt;
    if (typeof e.rating === 'number' && e.rating >= 0.5) entry.rating = e.rating;
    out.push(entry);
  }
  return out;
}

/** Reads a backup, throwing a readable error for the wrong file, a newer version or a bad section. */
export function parseBackup(raw: unknown): BackupFile {
  if (!isObj(raw)) throw new Error('Not a backup file');
  if (raw.app !== BACKUP_APP) throw new Error('Not an Earmark backup file');
  if (raw.kind !== 'backup') throw new Error('This file is not a backup');
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > BACKUP_VERSION) throw new Error(`This backup was made by a newer version of Earmark (v${version}); update the app to restore it.`);
  if (!isObj(raw.data)) throw new Error('The backup has no data');

  const d = raw.data;
  if (d.sync !== undefined && !isObj(d.sync)) throw new Error("The backup's sync data is malformed");

  // Unknown extra fields are ignored; a missing or wrong-typed section falls back to its empty value.
  return {
    app: BACKUP_APP, kind: 'backup', version: BACKUP_VERSION,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    data: {
      sync: parseDoc(d.sync ?? {}),
      sources: readSources(d, 'backup'),
      disabled: readDisabled(d, 'backup'),
      ebookSearchUrl: typeof d.ebookSearchUrl === 'string' ? d.ebookSearchUrl : '',
      readalongServerUrl: typeof d.readalongServerUrl === 'string' ? d.readalongServerUrl : '',
      hardcoverLinks: isObj(d.hardcoverLinks) ? d.hardcoverLinks : {},
      narrators: readNarrators(d),
      readElsewhere: readReadElsewhere(d),
    },
  };
}

/** Reads a setup file: the user's own sources, the disabled ids and the EPUB search address. */
export function parseSetup(raw: unknown): SetupFile {
  if (!isObj(raw)) throw new Error('Not a setup file');
  if (raw.app !== BACKUP_APP) throw new Error('Not an Earmark setup file');
  if (raw.kind !== 'setup') throw new Error('This file is not a setup file');
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > SETUP_VERSION) throw new Error(`This setup was made by a newer version of Earmark (v${version}); update the app to import it.`);
  if (!isObj(raw.data)) throw new Error('The setup file has no data');

  const d = raw.data;
  return {
    app: BACKUP_APP, kind: 'setup', version: SETUP_VERSION,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    data: {
      sources: readSources(d, 'setup'),
      disabled: readDisabled(d, 'setup'),
      ebookSearchUrl: typeof d.ebookSearchUrl === 'string' ? d.ebookSearchUrl : '',
    },
  };
}

/** Parses whatever Import data was handed, telling a setup file from a backup by its `kind`. */
export function parseImportFile(raw: unknown): ImportFile {
  if (!isObj(raw)) throw new Error('Not an Earmark file');
  if (raw.app !== BACKUP_APP) throw new Error('Not an Earmark backup or setup file');
  if (raw.kind === 'backup') return parseBackup(raw);
  if (raw.kind === 'setup') return parseSetup(raw);
  throw new Error('This file is not an Earmark backup or setup file');
}

export function parseBackupText(text: string): BackupFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e: any) { throw new Error(`Not valid JSON: ${e.message}`); }
  return parseBackup(raw);
}

export function parseImportFileText(text: string): ImportFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e: any) { throw new Error(`Not valid JSON: ${e.message}`); }
  return parseImportFile(raw);
}

/** What the import sheet shows before the user chooses Merge or Replace. */
export function backupSummary(file: BackupFile): BackupSummary {
  const sync = file.data.sync;
  const present = (m: Record<string, Stamped<unknown>>) => Object.values(m).filter((e) => e.value != null).length;
  return {
    exportedAt: file.exportedAt,
    appVersion: file.appVersion,
    withProgress: Object.keys(sync.progress).length,
    finished: Object.values(sync.progress).filter((p) => p.finished === true).length,
    ratings: Object.values(sync.meta).filter((e) => e.value?.rating != null).length,
    wishlist: present(sync.wishlist),
    readalongs: present(sync.readalong),
    sources: file.data.sources.length,
    readElsewhere: file.data.readElsewhere.length,
  };
}

/** What the import sheet shows for a setup file: how many sources, and whether a search address is in it. */
export function setupSummary(file: SetupFile): SetupSummary {
  return { sources: file.data.sources.length, search: !!file.data.ebookSearchUrl };
}

/**
 * Applies a setup file: sources whose id is not already here are added, existing ones are left
 * untouched, the disabled list is left alone, and the EPUB search address is filled only when this
 * device has none.
 */
export function mergeSetupData(device: SetupData, file: SetupData): SetupData {
  const have = new Set(device.sources.map((s) => s.id));
  return {
    sources: [...device.sources, ...file.sources.filter((s) => !have.has(s.id))],
    disabled: device.disabled,
    ebookSearchUrl: device.ebookSearchUrl || file.ebookSearchUrl,
  };
}

/** Combine the device's data with a backup: newest record wins, sources added by id, blanks filled. */
export function mergeBackupData(device: BackupData, file: BackupData): BackupData {
  const have = new Set(device.sources.map((s) => s.id));
  const readElsewhereIds = new Set(device.readElsewhere.map((e) => e.id));
  const sync = mergeDocs(device.sync, file.sync);
  return {
    sync,
    sources: [...device.sources, ...file.sources.filter((s) => !have.has(s.id))],
    disabled: [...new Set([...device.disabled, ...file.disabled])],
    // The address now lives in the sync document too; when the merged record is stamped, it decides.
    // An older backup only carries it in this top-level field, so fall back to that when the sync
    // record is unstamped (stamp 0).
    ebookSearchUrl: sync.ebookSearch.updated > 0 ? sync.ebookSearch.value : device.ebookSearchUrl || file.ebookSearchUrl,
    readalongServerUrl: device.readalongServerUrl || file.readalongServerUrl,
    hardcoverLinks: { ...file.hardcoverLinks, ...device.hardcoverLinks },
    narrators: unionNarrators(device.narrators, file.narrators),
    readElsewhere: [...device.readElsewhere, ...file.readElsewhere.filter((e) => !readElsewhereIds.has(e.id))],
  };
}

/**
 * The sync half of Replace. Every record the file carries is re-stamped `now`, so the next sync
 * pushes it; every record the device had but the file does not becomes a tombstone stamped `now`,
 * so its removal is pushed too. Progress has no tombstone in the sync format, so device-only
 * progress is simply dropped here (the caller removes it locally); see the report.
 */
export function replaceDoc(device: SyncDoc, file: SyncDoc, now: number): SyncDoc {
  const out = emptyDoc();
  out.v = SYNC_VERSION;
  for (const [hash, p] of Object.entries(file.progress)) out.progress[hash] = { ...p, updated: now };

  const stamp = <T>(deviceMap: Record<string, Stamped<T>>, fileMap: Record<string, Stamped<T>>): Record<string, Stamped<T>> => {
    const merged: Record<string, Stamped<T>> = {};
    for (const key of new Set([...Object.keys(deviceMap), ...Object.keys(fileMap)])) {
      merged[key] = key in fileMap ? { value: fileMap[key].value, updated: now } : { value: null, updated: now };
    }
    return merged;
  };
  out.meta = stamp(device.meta, file.meta);
  // Re-stamping moves every progress record's time to now, and that time is what the finished shelf
  // falls back on for a book with no finish date; keep the real one in the book's details.
  for (const [hash, p] of Object.entries(file.progress)) {
    const value = out.meta[hash]?.value ?? {};
    if (p.finished && p.updated > 0 && value.finishedAt == null) out.meta[hash] = { value: { ...value, finishedAt: p.updated }, updated: now };
  }
  out.hidden = stamp(device.hidden, file.hidden);
  out.wishlist = stamp(device.wishlist, file.wishlist);
  out.readalong = stamp(device.readalong, file.readalong);
  out.settings = { value: file.settings.value, updated: now };
  out.ebookSearch = { value: file.ebookSearch.value, updated: now };
  // The listening log has no tombstones and is additive by device, so Replace simply takes the file's.
  out.listening = file.listening ?? {};
  out.listeningEstimate = file.listeningEstimate ?? null;
  return out;
}
