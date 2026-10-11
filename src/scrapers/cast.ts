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

// Production notes a catalogue title can carry in brackets or parentheses: the recording style and
// disc numbering. Only known notes are stripped, so a real parenthetical in a title is left alone.
const PRODUCTION_NOTE = /[\[(]\s*(?:dramati[sz]ed(?:\s+adaptation)?|full[\s-]?cast(?:\s+edition)?|graphic\s?audio|audio\s+drama|radio\s+drama|unabridged|abridged|\d+\s+of\s+\d+)[^\])]*[\])]/gi;
// A trailing production subtitle such as ": Full cast dramatisation" or " - A dramatized adaptation".
const PRODUCTION_SUBTITLE = /\s*[:–—\-]\s*(?:a\s+)?(?:full[\s-]?cast|dramati[sz]ation|dramati[sz]ed|graphic\s?audio|audio\s+drama|radio\s+drama)\b.*$/i;

/**
 * The real title from a catalogue full-cast entry: "[Dramatized Adaptation]", "(Full-Cast Edition)",
 * "(1 of 2)" and a trailing ": Full cast dramatisation" note are dropped. Used when handing the title
 * to a sources search, which would not recognise the production notes.
 */
export function cleanFullCastTitle(raw: string): string {
  return String(raw ?? '')
    // A note in the middle of a title is followed by the series, as in
    // "Title (2 of 2) [Dramatized Adaptation] : Series 1 (Series)": the series goes with it.
    .replace(new RegExp(`(?:${PRODUCTION_NOTE.source})\\s*:\\s.*$`, PRODUCTION_NOTE.flags.replace('g', '')), ' ')
    .replace(PRODUCTION_NOTE, ' ')
    .replace(PRODUCTION_SUBTITLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The results a source chip and the full-cast toggle leave visible, before any ordering is applied. */
export function selectSourceResults<T extends { scraperId: string; title: string; narrator?: string; name?: string }>(
  results: readonly T[], source: string | null, fullCastOnly: boolean,
): T[] {
  return results.filter((r) => (!source || r.scraperId === source) && (!fullCastOnly || isFullCast(r)));
}
