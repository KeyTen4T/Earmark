// Client for the read-along build server (tools/readalong/server). A phone or a desktop without
// the local GPU tool POSTs a book here and watches the job until it is done.
//
// The pure pieces — URL joining, error mapping, response validation and the build-path choice —
// live at the top so the Node tests can exercise them without React Native. Storage and `fetch`
// are only touched inside the async calls (storage is imported lazily) so importing this module
// on its own never pulls in platform code.

import type { ReadalongRecord } from './anchors';
import { fetchWithTimeout } from '../fetch-timeout';

/** The job lifecycle the server reports (see server.py's statuses). */
export type JobStatus =
  | 'queued' | 'running' | 'downloading' | 'building' | 'done' | 'failed' | 'cancelled';

export const JOB_STATUSES: readonly JobStatus[] = [
  'queued', 'running', 'downloading', 'building', 'done', 'failed', 'cancelled',
];

const RUNNING: readonly JobStatus[] = ['queued', 'running', 'downloading', 'building'];

/** True while the server is still working on a job. Pure. */
export const jobRunning = (status: JobStatus): boolean => RUNNING.includes(status);

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/** A job exactly as the server's `GET /v1/jobs/{id}` returns it, normalised. */
export type ServerJob = {
  id: string;
  status: JobStatus;
  position: number;
  done: number;
  total: number;
  matched: number;
  bytes: number;
  bytesTotal: number;
  error: string | null;
  record: ReadalongRecord | null;
  createdAt: number | null;
  updatedAt: number | null;
};

/** The `POST /v1/jobs` and `DELETE /v1/jobs/{id}` responses. */
export type ServerJobSummary = { id: string; position: number; status: JobStatus };

/** The body `POST /v1/jobs` expects. Mirrors `validate_request` in server.py. */
export type SubmitInput = {
  audioHash: string;
  fileIds: number[];
  epub: { hash: string; fileId: number; title: string };
  paragraphs: string[];
  paragraphsSha1: string;
};

/** The URL and token as configured in Settings. */
export type ServerConfig = { url: string; token: string };

// --------------------------------------------------------------------------------------
// Build path
// --------------------------------------------------------------------------------------

export type BuildPath = 'local' | 'server' | 'none';

/**
 * Which builder to use. The desktop's local GPU tool wins when it is available; otherwise a
 * configured server; otherwise there is nothing to build with. Pure.
 */
export function chooseBuildPath(localToolAvailable: boolean, serverConfigured: boolean): BuildPath {
  if (localToolAvailable) return 'local';
  if (serverConfigured) return 'server';
  return 'none';
}

// --------------------------------------------------------------------------------------
// URL joining
// --------------------------------------------------------------------------------------

/**
 * Normalise the URL entered in Settings: trim, drop trailing slashes, and append the `/readalong`
 * path when the user only gave the host. The server's routes already include that prefix, so a
 * URL with or without it ends up in the same place. Pure.
 */
export function normalizeServerUrl(raw: string): string {
  let url = (raw ?? '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/\/readalong$/i.test(url)) url = `${url}/readalong`;
  return url;
}

/** Join a normalised server URL and an endpoint path (`/v1/...`). Pure. */
export function serverEndpoint(rawUrl: string, path: string): string {
  const base = normalizeServerUrl(rawUrl);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

// --------------------------------------------------------------------------------------
// Error mapping
// --------------------------------------------------------------------------------------

export class ServerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
  }
}

/** A readable message for each HTTP status the server can return. Pure. */
export function errorForStatus(status: number, detail?: string | null): string {
  switch (status) {
    case 400:
      return detail
        ? `The read-along server rejected the request: ${detail}`
        : 'The read-along server rejected the request.';
    case 401:
      return 'The read-along server rejected the token. Check it in Settings.';
    case 404:
      return 'The read-along server has no job for that book.';
    case 411:
      return 'The read-along server rejected the request (no body size).';
    case 413:
      return 'That book is too large for the read-along server (5 MB limit).';
    case 429:
      return 'The read-along server is busy (10 jobs queued). Try again later.';
    default:
      return `The read-along server returned HTTP ${status}.`;
  }
}

/** A readable message for a request that never reached the server. Pure. */
export function networkErrorMessage(cause?: unknown): string {
  return `Could not reach the read-along server.${cause instanceof Error && cause.message ? ` ${cause.message}` : ''}`;
}

// --------------------------------------------------------------------------------------
// Response validation
// --------------------------------------------------------------------------------------

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    throw new ServerError(0, 'The read-along server sent an unexpected response.');
  }
  return raw as Record<string, unknown>;
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isReadalongRecord(value: unknown): value is ReadalongRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, any>;
  return !!r.epub && typeof r.epub === 'object'
    && typeof r.epub.hash === 'string'
    && Array.isArray(r.files)
    && typeof r.created === 'number';
}

/** Validate the `{id, position, status}` returned when a job is queued or cancelled. Throws on a
 * malformed payload. Pure. */
export function validateJobSummary(raw: unknown): ServerJobSummary {
  const o = asObject(raw);
  if (typeof o.id !== 'string' || !o.id) {
    throw new ServerError(0, 'The read-along server did not return a job id.');
  }
  if (!isJobStatus(o.status)) {
    throw new ServerError(0, 'The read-along server returned an unknown job status.');
  }
  return { id: o.id, status: o.status, position: numberOr(o.position, 0) };
}

/** Validate a full job payload. Throws on a malformed job (a missing id/status, or a `done` job
 * whose `record` is not a record). Pure. */
export function validateJob(raw: unknown): ServerJob {
  const o = asObject(raw);
  if (typeof o.id !== 'string' || !o.id) {
    throw new ServerError(0, 'The read-along server did not return a job id.');
  }
  if (!isJobStatus(o.status)) {
    throw new ServerError(0, 'The read-along server returned an unknown job status.');
  }
  const record = o.status === 'done' ? o.record : null;
  if (o.status === 'done' && !isReadalongRecord(record)) {
    throw new ServerError(0, 'The read-along server finished but returned a malformed record.');
  }
  return {
    id: o.id,
    status: o.status,
    position: numberOr(o.position, 0),
    done: numberOr(o.done, 0),
    total: numberOr(o.total, 0),
    matched: numberOr(o.matched, 0),
    bytes: numberOr(o.bytes, 0),
    bytesTotal: numberOr(o.bytesTotal, 0),
    error: typeof o.error === 'string' && o.error ? o.error : null,
    record: (record as ReadalongRecord | null) ?? null,
    createdAt: nullableNumber(o.createdAt),
    updatedAt: nullableNumber(o.updatedAt),
  };
}

// --------------------------------------------------------------------------------------
// The client
// --------------------------------------------------------------------------------------

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Ordinary server requests. Large body transfers (the EPUB) do not go through here. */
const REQUEST_TIMEOUT_MS = 30_000;

export type RequestOptions = { config?: ServerConfig; fetchImpl?: Fetcher };

/** The server URL and token from Settings, or null when either is missing. */
export async function serverConfig(): Promise<ServerConfig | null> {
  const { loadReadalongServerUrl, getReadalongServerToken } = await import('../storage');
  const url = normalizeServerUrl(await loadReadalongServerUrl());
  const token = (await getReadalongServerToken()) ?? '';
  if (!url || !token) return null;
  return { url, token };
}

/** Whether a server is configured (both a URL and a token). */
export async function serverConfigured(): Promise<boolean> {
  return (await serverConfig()) !== null;
}

async function configOrThrow(opts: RequestOptions): Promise<{ cfg: ServerConfig; fetchImpl: Fetcher }> {
  const cfg = opts.config ?? await serverConfig();
  if (!cfg) throw new ServerError(0, 'No read-along server is set up. Add one in Settings.');
  return { cfg, fetchImpl: opts.fetchImpl ?? fetch };
}

async function send(cfg: ServerConfig, path: string, init: RequestInit, fetchImpl: Fetcher): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithTimeout(serverEndpoint(cfg.url, path), {
      ...init,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(init.headers ?? {}) },
    }, REQUEST_TIMEOUT_MS, fetchImpl);
  } catch (e) {
    throw new ServerError(0, networkErrorMessage(e));
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* an error body may be empty */ }
  if (!res.ok) {
    const detail = body && typeof (body as any).error === 'string' ? (body as any).error : null;
    throw new ServerError(res.status, errorForStatus(res.status, detail));
  }
  return body;
}

/** Queue a build; returns the job id and its queue position. */
export async function submitJob(input: SubmitInput, opts: RequestOptions = {}): Promise<ServerJobSummary> {
  const { cfg, fetchImpl } = await configOrThrow(opts);
  const body = await send(cfg, '/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, fetchImpl);
  return validateJobSummary(body);
}

/** The current state of one job. */
export async function getJob(id: string, opts: RequestOptions = {}): Promise<ServerJob> {
  const { cfg, fetchImpl } = await configOrThrow(opts);
  const body = await send(cfg, `/v1/jobs/${encodeURIComponent(id)}`, { method: 'GET' }, fetchImpl);
  return validateJob(body);
}

/** The latest job for a book, or null when the server has none (404). */
export async function jobForHash(hash: string, opts: RequestOptions = {}): Promise<ServerJob | null> {
  const { cfg, fetchImpl } = await configOrThrow(opts);
  try {
    const body = await send(cfg, `/v1/jobs?hash=${encodeURIComponent(hash.toLowerCase())}`, { method: 'GET' }, fetchImpl);
    return validateJob(body);
  } catch (e) {
    if (e instanceof ServerError && e.status === 404) return null;
    throw e;
  }
}

/** Cancel a queued or running job. */
export async function cancelJob(id: string, opts: RequestOptions = {}): Promise<ServerJobSummary> {
  const { cfg, fetchImpl } = await configOrThrow(opts);
  const body = await send(cfg, `/v1/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl);
  return validateJobSummary(body);
}

// --------------------------------------------------------------------------------------
// The Settings "Test" probe
// --------------------------------------------------------------------------------------

export type ServerProbe = 'reachable' | 'token-rejected' | 'unreachable';

/**
 * Check a server: first the unauthenticated health endpoint, then an authenticated request.
 * Tells "reachable", "token rejected" and "unreachable" apart. Never throws.
 */
export async function testServer(cfg: ServerConfig, fetchImpl: Fetcher = fetch): Promise<ServerProbe> {
  try {
    const health = await fetchWithTimeout(serverEndpoint(cfg.url, '/v1/health'), {}, REQUEST_TIMEOUT_MS, fetchImpl);
    if (!health.ok) return 'unreachable';
  } catch {
    return 'unreachable';
  }
  try {
    const authed = await fetchWithTimeout(serverEndpoint(cfg.url, `/v1/jobs?hash=${'0'.repeat(40)}`), {
      headers: { Authorization: `Bearer ${cfg.token}` },
    }, REQUEST_TIMEOUT_MS, fetchImpl);
    if (authed.status === 401) return 'token-rejected';
    return 'reachable'; // 200 or 404 both mean the token was accepted
  } catch {
    return 'unreachable';
  }
}
