/**
 * Turning a torrent name into a display title, and reading its audio-format tags.
 *
 * Pure on purpose: no react-native/expo imports, so the Node test runner can load it
 * (test/titles.test.ts). `prettyName` is re-exported from theme.ts so every existing caller keeps
 * working.
 */

// Codec names are stripped wherever they appear, bare or inside brackets.
const CODEC_RE = /\b(?:he-?aac|eac3|ac3|opus|aac|flac|mp3|m4b|m4a|ogg)\b/gi;
// Numeric channel layouts. The dot between digits is preserved by `dotsToSpaces` so these still match.
const CHANNEL_RE = /\b(?:5\.1|7\.1|2\.0)(?:ch)?\b/gi;
// Bitrates: "128 kbps", "64kbps", "64k".
const BITRATE_RE = /\b\d{2,3}\s?kbps\b|\b\d{2,3}\s?k\b/gi;
const ATMOS_RE = /\batmos\b/gi;
// A bracketed resolution tag ("[1080p]") was already dropped by the old logic; keep that.
const RES_RE = /\b\d{3,4}p\b/gi;
// These are tags wherever they sit.
const WORDS_RE = /\b(?:unabridged|abridged|audio\s?book)\b/gi;
// These are only tags when they are bracketed, come after a " - " separator, or sit at the very end:
// "Stereo Hearts" and "The 5 Love Languages" are titles, "Dune - Stereo" is a format.
const COND_SRC = '(?:stereo|mono|surround|retail|rip|encode|encoded)';
const COND_RE = new RegExp(COND_SRC, 'gi');
const COND_AFTER_RE = new RegExp(`\\s+-\\s+${COND_SRC}\\b`, 'gi');
const COND_END_RE = new RegExp(`\\b${COND_SRC}\\b\\s*$`, 'i');

/** The old behaviour, kept verbatim as the fallback when stripping would leave nothing behind. */
function legacyPrettyName(name: string) {
  return name
    .replace(/\.(m4b|mp3|zip|rar)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s*[\[(](?:mp3|m4b|aac|\d{2,3}\s?kbps|unabridged|audiobook|\d{3,4}p)[^\])]*[\])]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Separators (dots and underscores) become spaces, except the dot that makes a decimal like "5.1".
 * Keeping it long enough for the channel regex is what stops "Opus 5.1ch" reading as "5 1ch".
 */
function dotsToSpaces(s: string): string {
  return s.replace(/\d[._]\d|([._]+)/g, (m, seps) => (seps ? ' ' : m));
}

/** True when a bracketed group holds nothing but format tags ("[MP3 64kbps]", "(Unabridged)"). */
function isTagOnly(inner: string): boolean {
  const rest = inner
    .replace(CODEC_RE, ' ')
    .replace(CHANNEL_RE, ' ')
    .replace(BITRATE_RE, ' ')
    .replace(ATMOS_RE, ' ')
    .replace(RES_RE, ' ')
    .replace(WORDS_RE, ' ')
    .replace(COND_RE, ' ')
    .replace(/[^a-z0-9]/gi, '');
  return rest.length === 0;
}

/** Strip release-style noise from torrent names for display. */
export function prettyName(name: string): string {
  const legacy = legacyPrettyName(name);
  let s = name.replace(/\s+/g, ' ');
  s = s.replace(/\.(m4b|mp3|zip|rar)$/i, '');
  s = dotsToSpaces(s);
  // Drop bracketed groups that hold nothing but tags: [MP3], (Unabridged), (5.1ch), (64kbps)…
  s = s.replace(/[\[(]([^\[\]()]*)[\])]/g, (m, inner) => (isTagOnly(inner) ? ' ' : m));
  // Bare tags: codecs, numeric channels, bitrates and the always-tag words.
  s = s.replace(CODEC_RE, ' ').replace(CHANNEL_RE, ' ').replace(BITRATE_RE, ' ').replace(ATMOS_RE, ' ').replace(WORDS_RE, ' ');
  // The bare words that may be part of a sentence are only dropped after " - " or at the very end.
  s = s.replace(COND_AFTER_RE, ' ').replace(COND_END_RE, ' ');
  // Tidy up the separators the removals left behind.
  s = s.replace(/[\[(]\s*[\])]/g, ' ');
  s = s.replace(/\s{2,}/g, ' ');
  s = s.replace(/\s+(?:-\s+)+/g, ' - '); // "a - - b" -> "a - b"
  s = s.replace(/^[\s-]+|[\s-]+$/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || legacy || name;
}

/**
 * The user-facing format badges for a torrent name: channel layout first, then codec, deduplicated.
 * Nothing for stereo/mono/2.0. Empty when the name carries no recognisable format.
 */
export function audioTags(name: string): string[] {
  const channels: [RegExp, string][] = [
    [/\b5\.1(?:ch)?\b/i, '5.1'],
    [/\b7\.1(?:ch)?\b/i, '7.1'],
    [/\batmos\b/i, 'Atmos'],
  ];
  const codecs: [RegExp, string][] = [
    [/\bopus\b/i, 'Opus'],
    [/\bflac\b/i, 'FLAC'],
    [/\baac\b/i, 'AAC'],
    [/\bmp3\b/i, 'MP3'],
    [/\bm4b\b/i, 'M4B'],
  ];
  const out: string[] = [];
  for (const [re, label] of channels) if (re.test(name)) out.push(label);
  for (const [re, label] of codecs) if (re.test(name)) out.push(label);
  return [...new Set(out)];
}
