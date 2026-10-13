import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system';
import { validateScraper, ScraperDef } from './engine';
import { isProvider, providerToScraper } from './provider';
import { fetchWithTimeout } from '../fetch-timeout';

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

/** Accepts one scraper, an array of scrapers, { "scrapers": [...] }, or a provider.json search source. */
export function parseScrapers(text: string): ScraperDef[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e: any) { throw new Error(`Not valid JSON: ${e.message}`); }
  const list = Array.isArray(raw) ? raw : (raw as any)?.scrapers && Array.isArray((raw as any).scrapers) ? (raw as any).scrapers : [raw];
  return list.map((d: unknown) => validateScraper(isProvider(d) ? providerToScraper(d) : d));
}

export async function pickScraperFiles(): Promise<{ defs: ScraperDef[]; errors: string[] } | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], multiple: true, copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.length) return null;
  const defs: ScraperDef[] = [];
  const errors: string[] = [];
  for (const a of res.assets) {
    try { defs.push(...parseScrapers(await readText(a.uri))); }
    catch (e: any) { errors.push(`${a.name}: ${e.message}`); }
  }
  return { defs, errors };
}

export async function fetchScrapers(url: string) {
  const res = await fetchWithTimeout(url, {}, 20_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseScrapers(await res.text());
}

export const EXAMPLE_SCRAPER = `{
  "id": "my-source",
  "name": "My Source",
  "icon": "🎧",
  "type": "json",
  "search": { "url": "https://example.com/api/search?q={query|urlencode}" },
  "results": {
    "path": "data.items",
    "fields": {
      "title": "{name|clean}",
      "author": "{author}",
      "cover": "{image}",
      "size": "{bytes|bytes}",
      "seeders": "{seeds}",
      "magnet": "{magnet}"
    }
  }
}`;
