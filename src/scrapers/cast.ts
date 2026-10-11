// Pure helpers for spotting full-cast / dramatised audiobooks, so the sources list can badge them.
// No react-native/expo imports, so the Node test runner can exercise it.

// Word-boundary safe: "broadcast" and "forecast" must not match, and a bare "cast" never does.
const FULL_CAST = /\bfull[\s-]cast\b|\bmulti[\s-]?cast\b|\bdramati[sz](?:ation|ed)\b|\bgraphic\s?audio\b|a movie in your mind|\b(?:radio|audio) drama\b|\bbbc radio\b|\bcast recording\b|\bensemble cast\b/i;

/** The individual names in a narrator string, split on the usual separators. */
export function splitNarrators(narrator?: string): string[] {
  return String(narrator ?? '')
    .split(/,|&|;|\/|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** How many narrators a narrator string names, splitting on the usual separators. */
export function narratorCount(narrator?: string): number {
  return splitNarrators(narrator).length;
}

/** True when a title, narrator or raw name says the recording is full-cast or dramatised. */
export function isFullCast(r: { title: string; narrator?: string; name?: string }): boolean {
  const narrator = r.narrator ?? '';
  if (narratorCount(narrator) >= 4) return true;
  if (/^(?:a\s+)?(?:full[\s-]?cast|various)$/i.test(narrator.trim())) return true;
  return [r.title, narrator, r.name ?? ''].some((s) => !!s && FULL_CAST.test(s));
}
