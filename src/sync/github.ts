// Thin GitHub Gist client for sync. Only the documented REST endpoints are used, over fetch, so
// there is no new dependency. The token is supplied by the caller and never stored here.
const API = 'https://api.github.com';
export const SYNC_FILE = 'earmark-sync.json';

/** The cached gist id no longer resolves (deleted, or no longer visible to this token). */
export class GistMissing extends Error {}

const headers = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  // GitHub rejects requests without a User-Agent. Browsers overwrite this; that is fine.
  'User-Agent': 'Earmark-audiobook-app',
});

const call = (token: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> =>
  fetch(`${API}${path}`, { ...init, signal, headers: headers(token) });

/** Confirms the token works (and implicitly that it has access to the account's gists). */
export async function verifyToken(token: string, signal?: AbortSignal): Promise<void> {
  const res = await call(token, '/user', {}, signal);
  if (res.status === 401) throw new Error('GitHub rejected the token');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
}

/** The id of the user's gist that already contains our file, or null. Pages through 100 at a time. */
export async function findGist(token: string, signal?: AbortSignal): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    const res = await call(token, `/gists?per_page=100&page=${page}`, {}, signal);
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new Error('GitHub rejected the token; make sure it has the “gist” scope');
    if (!res.ok) throw new Error(`GitHub error ${res.status}`);
    const list = await res.json() as unknown;
    if (!Array.isArray(list)) break;
    const hit = (list as any[]).find((g) => g?.files && Object.prototype.hasOwnProperty.call(g.files, SYNC_FILE));
    if (hit) return String(hit.id);
    if (list.length < 100) break;
  }
  return null;
}

export async function createGist(token: string, content: string, signal?: AbortSignal): Promise<string> {
  const res = await call(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description: 'Earmark sync', public: false, files: { [SYNC_FILE]: { content } } }),
  }, signal);
  if (!res.ok) throw new Error(`Could not create the sync gist (GitHub ${res.status})`);
  const gist = await res.json() as any;
  return String(gist.id);
}

/** Raw file contents, or null when the gist has no sync file yet. Follows `truncated` to raw_url. */
export async function readGist(token: string, id: string, signal?: AbortSignal): Promise<string | null> {
  const res = await call(token, `/gists/${id}`, {}, signal);
  if (res.status === 404) throw new GistMissing('Sync gist not found');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  const gist = await res.json() as any;
  const file = gist?.files?.[SYNC_FILE];
  if (!file) return null;
  if (file.truncated && file.raw_url) {
    // raw_url is pre-signed; deliberately no Authorization header on a different host.
    const raw = await fetch(String(file.raw_url), { signal });
    if (!raw.ok) throw new Error(`Could not read the sync gist (HTTP ${raw.status})`);
    return raw.text();
  }
  return typeof file.content === 'string' ? file.content : null;
}

export async function writeGist(token: string, id: string, content: string, signal?: AbortSignal): Promise<void> {
  const res = await call(token, `/gists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [SYNC_FILE]: { content } } }),
  }, signal);
  if (res.status === 404) throw new GistMissing('Sync gist not found');
  if (!res.ok) throw new Error(`Could not update the sync gist (GitHub ${res.status})`);
}
