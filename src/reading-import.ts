// Platform glue for "Import reading history": open a Goodreads CSV through the document picker, and
// write the plan the pure ./reading-history module produced. The sheet itself lives in
// SettingsScreen; the decisions and parsing are pure and tested.
import * as DocumentPicker from 'expo-document-picker';
import { readText } from './backup-io';
import { parseGoodreadsExport } from './goodreads';
import { saveMeta, saveReadElsewhere, type BookMeta } from './storage';
import type { ImportPlan, ReadElsewhere } from './reading-history';

/** Opens the document picker for a Goodreads export; null when the user cancelled. Throws readably. */
export async function pickGoodreadsExport(): Promise<ReadElsewhere[] | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['text/csv', 'text/comma-separated-values', 'text/plain', '*/*'], multiple: false, copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.length) return null;
  return parseGoodreadsExport(await readText(res.assets[0].uri));
}

/**
 * Applies an import plan: blank ratings and finish dates onto matched finished library books (the same
 * saveMeta a rating tap uses, so they sync), then the shelf entries. Never touches progress.
 */
export async function applyReadingPlan(plan: ImportPlan): Promise<void> {
  for (const f of plan.fills) {
    const patch: BookMeta = {};
    if (f.rating != null) patch.rating = f.rating;
    if (f.finishedAt != null) patch.finishedAt = f.finishedAt;
    await saveMeta(f.hash, patch);
  }
  await saveReadElsewhere(plan.entries);
}
