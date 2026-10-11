// Update check: version ordering, GitHub release parsing and release-note summaries.
// Pure: no React Native, Expo or storage imports, so the Node test runner can exercise it.

export type Release = {
  version: string;
  notes: string;
  pageUrl: string;
  apkUrl?: string;
  debUrl?: string;
  appImageUrl?: string;
};

// X.Y.Z, with an optional leading v and an optional pre-release suffix.
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

type Parsed = { nums: [number, number, number]; pre: string[] };

function parseVersion(v: unknown): Parsed | null {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}

/** Orders two versions: negative when a is older, positive when newer, 0 when equal. Never throws. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? { nums: [0, 0, 0] as [number, number, number], pre: [] };
  const pb = parseVersion(b) ?? { nums: [0, 0, 0] as [number, number, number], pre: [] };
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return +x < +y ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Validates a GitHub release JSON and pulls out the version, notes and asset URLs; null when unusable. */
export function parseRelease(json: unknown): Release | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  const m = VERSION_RE.exec(tag);
  if (!m) return null;
  if (typeof r.html_url !== 'string' || !r.html_url) return null;
  if (r.assets !== undefined && !Array.isArray(r.assets)) return null;

  const urlFor = (ext: string) => {
    for (const a of (r.assets as unknown[]) ?? []) {
      const u = a && typeof a === 'object' ? (a as Record<string, unknown>).browser_download_url : null;
      if (typeof u === 'string' && u.toLowerCase().endsWith(ext)) return u;
    }
    return undefined;
  };
  return {
    version: `${m[1]}.${m[2]}.${m[3]}`,
    notes: typeof r.body === 'string' ? r.body : '',
    pageUrl: r.html_url,
    apkUrl: urlFor('.apk'),
    debUrl: urlFor('.deb'),
    appImageUrl: urlFor('.appimage'),
  };
}

/** True only when the release is strictly newer than the version running. */
export function updateAvailable(current: string, release: Release | null): boolean {
  return !!release && compareVersions(release.version, current) > 0;
}

/** True when there has never been a check, or the last one is more than 24 h old. */
export function shouldAutoCheck(lastCheckedAt: number | null | undefined, now: number): boolean {
  if (!lastCheckedAt) return true;
  return now - lastCheckedAt > 24 * 60 * 60 * 1000;
}

/** First maxLines non-empty lines of release notes, with markdown markers stripped. */
export function summary(notes: unknown, maxLines: number): string {
  if (typeof notes !== 'string' || maxLines <= 0) return '';
  const lines: string[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*]\s+/, '').replace(/^\s*#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (!line) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines.join('\n');
}
