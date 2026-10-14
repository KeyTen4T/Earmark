// Thin GitHub Gist client for sync. Only the documented REST endpoints are used, over fetch, so
// there is no new dependency. The token is supplied by the caller and never stored here.
import { fetchWithTimeout } from '../fetch-timeout';

const API = 'https://api.github.com';
export const SYNC_FILE = 'earmark-sync.json';

/** Plenty for a small gist; a dead socket must not hold a sync cycle forever. */
const SYNC_TIMEOUT_MS = 20_000;

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
  fetchWithTimeout(`${API}${path}`, { ...init, signal, headers: headers(token) }, SYNC_TIMEOUT_MS);

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
    const raw = await fetchWithTimeout(String(file.raw_url), { signal }, SYNC_TIMEOUT_MS);
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

// ---- Revision history, for dating listening that predates the log ----

/** One commit in a gist's history. */
export type GistCommit = { version: string; committed_at: string };

/** HTTP requests one history reconstruction may make; past this, older revisions are left unknown. */
export const HISTORY_REQUEST_CAP = 1500;

/** A mutable counter shared across one history run. */
export type RequestBudget = { remaining: number };
export const makeBudget = (total = HISTORY_REQUEST_CAP): RequestBudget => ({ remaining: total });

/** Thrown once a history run has spent its whole request budget. */
export class BudgetExhausted extends Error {}

/** Counts one HTTP request; throws once the budget is gone so the caller can keep what it has. */
function spend(budget?: RequestBudget): void {
  if (!budget) return;
  if (budget.remaining <= 0) throw new BudgetExhausted('history request budget exhausted');
  budget.remaining--;
}

/**
 * The gist's commits, newest first. Pages 100 at a time until a short page or the budget runs out, so
 * a caller with a limited budget still gets the recent revisions. The token is a header, never a URL.
 */
export async function listGistCommits(token: string, id: string, signal?: AbortSignal, budget?: RequestBudget): Promise<GistCommit[]> {
  const out: GistCommit[] = [];
  for (let page = 1; page <= 100; page++) {
    if (budget && budget.remaining <= 0) break;
    spend(budget);
    const res = await call(token, `/gists/${id}/commits?per_page=100&page=${page}`, {}, signal);
    if (res.status === 404) throw new GistMissing('Sync gist not found');
    if (!res.ok) throw new Error(`GitHub error ${res.status}`);
    const list = await res.json() as unknown;
    if (!Array.isArray(list)) break;
    for (const c of list as any[]) {
      const version = c?.version;
      const at = c?.committed_at;
      if (typeof version === 'string' && version && typeof at === 'string' && at) out.push({ version, committed_at: at });
    }
    if (list.length < 100) break;
  }
  return out;
}

/** The sync file at one revision, or null when that revision has no sync file. Follows `truncated`. */
export async function readGistVersion(token: string, id: string, sha: string, signal?: AbortSignal, budget?: RequestBudget): Promise<string | null> {
  spend(budget);
  const res = await call(token, `/gists/${id}/${sha}`, {}, signal);
  if (res.status === 404) throw new GistMissing('Sync revision not found');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  const gist = await res.json() as any;
  const file = gist?.files?.[SYNC_FILE];
  if (!file) return null;
  if (file.truncated && file.raw_url) {
    // raw_url is pre-signed; deliberately no Authorization header on a different host.
    spend(budget);
    const raw = await fetchWithTimeout(String(file.raw_url), { signal }, SYNC_TIMEOUT_MS);
    if (!raw.ok) throw new Error(`Could not read the sync revision (HTTP ${raw.status})`);
    return raw.text();
  }
  return typeof file.content === 'string' ? file.content : null;
}
