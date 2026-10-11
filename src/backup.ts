// The backup file's shape, plus the pure logic to build, parse, summarise, merge and replace one.
// Deliberately free of React Native and Expo imports so it runs under the plain Node test runner
// (test/backup.test.ts). The sync document is carried verbatim, reusing ../sync/merge's parser and
// merge rather than inventing a second format. Nothing that lives in secure storage is ever read
// here (or written by the caller): see SECRET_KEYS.

import { emptyDoc, parseDoc, mergeDocs, SYNC_VERSION, type SyncDoc, type Stamped } from './sync/merge';
import { validateScraper, type ScraperDef } from './scrapers/engine';

export const BACKUP_VERSION = 1;
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
};

export type BackupFile = {
  app: typeof BACKUP_APP;
  kind: 'backup';
  version: number;
  exportedAt: number;
  appVersion: string;
  data: BackupData;
};

export type BackupSummary = {
  exportedAt: number;
  appVersion: string;
  withProgress: number;
  finished: number;
  ratings: number;
  wishlist: number;
  readalongs: number;
  sources: number;
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function buildBackup(data: BackupData, appVersion: string, now = Date.now()): BackupFile {
  return { app: BACKUP_APP, kind: 'backup', version: BACKUP_VERSION, exportedAt: now, appVersion, data };
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

  const sources: ScraperDef[] = [];
  if (d.sources !== undefined) {
    if (!Array.isArray(d.sources)) throw new Error("The backup's sources are malformed");
    for (const s of d.sources) {
      if (!isObj(s)) throw new Error("The backup's sources are malformed");
      try { sources.push(validateScraper(s)); }
      catch (e: any) { throw new Error(`The backup has an invalid source: ${e.message}`); }
    }
  }

  let disabled: string[] = [];
  if (d.disabled !== undefined) {
    if (!Array.isArray(d.disabled) || d.disabled.some((x) => typeof x !== 'string')) throw new Error("The backup's disabled-source list is malformed");
    disabled = d.disabled as string[];
  }

  // Unknown extra fields are ignored; a missing or wrong-typed section falls back to its empty value.
  return {
    app: BACKUP_APP, kind: 'backup', version: BACKUP_VERSION,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '',
    data: {
      sync: parseDoc(d.sync ?? {}),
      sources,
      disabled,
      ebookSearchUrl: typeof d.ebookSearchUrl === 'string' ? d.ebookSearchUrl : '',
      readalongServerUrl: typeof d.readalongServerUrl === 'string' ? d.readalongServerUrl : '',
      hardcoverLinks: isObj(d.hardcoverLinks) ? d.hardcoverLinks : {},
    },
  };
}

export function parseBackupText(text: string): BackupFile {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e: any) { throw new Error(`Not valid JSON: ${e.message}`); }
  return parseBackup(raw);
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
  };
}

/** Combine the device's data with a backup: newest record wins, sources added by id, blanks filled. */
export function mergeBackupData(device: BackupData, file: BackupData): BackupData {
  const have = new Set(device.sources.map((s) => s.id));
  return {
    sync: mergeDocs(device.sync, file.sync),
    sources: [...device.sources, ...file.sources.filter((s) => !have.has(s.id))],
    disabled: [...new Set([...device.disabled, ...file.disabled])],
    ebookSearchUrl: device.ebookSearchUrl || file.ebookSearchUrl,
    readalongServerUrl: device.readalongServerUrl || file.readalongServerUrl,
    hardcoverLinks: { ...file.hardcoverLinks, ...device.hardcoverLinks },
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
  return out;
}
