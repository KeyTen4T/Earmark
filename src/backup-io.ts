// Platform glue for backups: read the device into a BackupFile, save one to a file, and apply one
// back. The file's shape and all the merge/replace logic live in ./backup (pure). Nothing here
// touches secure storage: no key, token or secret is read or written.
import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import app from '../app.json';
import { buildBackup, mergeBackupData, parseBackupText, type BackupData, type BackupFile } from './backup';
import { applyBackupSync, buildLocalDoc } from './sync';
import {
  loadUserScrapers, saveUserScrapers, loadDisabled, saveDisabled,
  loadEbookSearchUrl, saveEbookSearchUrl, loadReadalongServerUrl, saveReadalongServerUrl,
} from './storage';
import { loadHcLinks, saveHcLinks, type HcLink } from './hardcover';

async function readText(uri: string): Promise<string> {
  const fs: any = FS;
  try {
    if (typeof fs.File === 'function') {
      const f = new fs.File(uri);
      const t = f.text();
      return typeof t === 'string' ? t : await t;
    }
  } catch { /* fall through */ }
  try {
    if (typeof fs.readAsStringAsync === 'function') return await fs.readAsStringAsync(uri);
  } catch { /* fall through */ }
  const res = await fetch(uri);
  return res.text();
}

/** Everything on this device that a backup covers. */
async function deviceData(): Promise<BackupData> {
  const [sync, sources, disabled, ebookSearchUrl, readalongServerUrl, hardcoverLinks] = await Promise.all([
    buildLocalDoc(), loadUserScrapers(), loadDisabled(), loadEbookSearchUrl(), loadReadalongServerUrl(), loadHcLinks(),
  ]);
  return { sync, sources, disabled, ebookSearchUrl, readalongServerUrl, hardcoverLinks };
}

export async function makeBackupFile(): Promise<BackupFile> {
  return buildBackup(await deviceData(), app.expo.version);
}

/** Opens the document picker and parses the chosen backup; null if the user cancelled. */
export async function pickBackupFile(): Promise<BackupFile | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], multiple: false, copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.length) return null;
  return parseBackupText(await readText(res.assets[0].uri));
}

/**
 * Applies a backup to this device. Merge combines with what is here; Replace makes the file's data
 * the device's data, removing (tombstoning) anything the file did not carry. Returned so the caller
 * can refresh in-memory state.
 */
export async function applyBackupFile(file: BackupFile, mode: 'merge' | 'replace'): Promise<BackupData> {
  const next = mode === 'replace'
    ? file.data
    : mergeBackupData(await deviceData(), file.data);
  await applyBackupSync(next.sync, mode);
  await saveUserScrapers(next.sources);
  await saveDisabled(next.disabled);
  await saveEbookSearchUrl(next.ebookSearchUrl);
  await saveReadalongServerUrl(next.readalongServerUrl);
  await saveHcLinks(next.hardcoverLinks as Record<string, HcLink>);
  return next;
}

function stampNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Saves the backup. Web/desktop downloads a Blob through a temporary link (Electron's
 * setWindowOpenHandler only sees window.open, and will-navigate only fires for top-level
 * navigations, so neither swallows an <a download> click). Android uses the Storage Access
 * Framework directory picker and creates the file in the chosen folder.
 */
export async function exportBackupFile(file: BackupFile): Promise<'saved' | 'canceled'> {
  const json = JSON.stringify(file, null, 2);
  const name = `earmark-backup-${stampNow()}`;
  if (Platform.OS === 'web') {
    const doc = (globalThis as any).document;
    const blob = new (globalThis as any).Blob([json], { type: 'application/json' });
    const url = (globalThis as any).URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    (globalThis as any).setTimeout(() => (globalThis as any).URL.revokeObjectURL(url), 1000);
    return 'saved';
  }
  const dir = await LegacyFS.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!dir.granted) return 'canceled';
  const uri = await LegacyFS.StorageAccessFramework.createFileAsync(dir.directoryUri, name, 'application/json');
  await LegacyFS.StorageAccessFramework.writeAsStringAsync(uri, json);
  return 'saved';
}
