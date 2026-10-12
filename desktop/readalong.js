// Read-along job runner for the Electron shell.
//
// Plain Node (no `electron` import) so it can be smoke-tested from a terminal:
// `node --check desktop/readalong.js` and `desktop/scripts/smoke-readalong.mjs`.
// main.js does the Electron wiring (secrets, paths, IPC); this module only knows how
// to inspect the tool, download an EPUB, and spawn `readalong.py anchors`.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_EPUB_BYTES = 50 * 1024 * 1024; // 50 MB
const STDERR_TAIL_LINES = 50;
const SIGKILL_AFTER_MS = 5000;

// One anchors run at a time per process. The TorBox key lives only in a temporary
// config.json; it is never logged and is deleted when the job ends.
let activeJob = null;

function findExecutable(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const full = path.join(dir, name);
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Check that the read-along tool can run.
 * @returns {{ available: boolean, reason?: string, python: string, script: string }}
 */
function status({ python, script } = {}) {
  const missing = [];
  if (!python || !fileExists(python)) missing.push(`python (${python || 'unset'})`);
  if (!script || !fileExists(script)) missing.push(`script (${script || 'unset'})`);
  if (!findExecutable('ffmpeg')) missing.push('ffmpeg');
  if (!findExecutable('ffprobe')) missing.push('ffprobe');
  const result = { available: missing.length === 0, python, script };
  if (!result.available) result.reason = `missing: ${missing.join(', ')}`;
  return result;
}

/**
 * Download an EPUB over HTTPS to `destPath` (parent directories are created).
 * Returns the bytes as a Uint8Array. Refuses anything over 50 MB.
 */
async function fetchEpub(url, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchEpub: HTTP ${res.status} ${res.statusText}`.trim());
  const announced = Number(res.headers.get('content-length') || 0);
  if (announced && announced > MAX_EPUB_BYTES) {
    throw new Error(`fetchEpub: EPUB is larger than 50 MB (${announced} bytes)`);
  }
  const chunks = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_EPUB_BYTES) throw new Error('fetchEpub: EPUB is larger than 50 MB');
      chunks.push(chunk);
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_EPUB_BYTES) throw new Error('fetchEpub: EPUB is larger than 50 MB');
    total = buf.length;
    chunks.push(buf);
  }
  const out = Buffer.concat(chunks, total);
  await fsp.writeFile(destPath, out);
  return new Uint8Array(out);
}

/**
 * Bytes of an EPUB already saved on disk, or null when it isn't there (never downloaded, or removed).
 * Read-only: the view uses this to avoid re-downloading an EPUB the desktop already has.
 */
async function readEpub(epubPath) {
  try {
    const buf = await fsp.readFile(epubPath);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function normalizeFileIds(fileIds) {
  if (fileIds == null) return null;
  const parts = Array.isArray(fileIds) ? fileIds : String(fileIds).split(',');
  const out = [];
  for (const part of parts) {
    const text = String(part).trim();
    if (!text) continue;
    const n = Number(text);
    if (!Number.isInteger(n)) {
      throw new Error(`runJob: file id ${JSON.stringify(text)} is not an integer`);
    }
    out.push(n);
  }
  return out;
}

/**
 * Spawn `readalong.py anchors` for one audiobook.
 *
 * @returns {{ promise: Promise<object>, cancel: () => void }}
 *   `promise` resolves with the parsed anchors.json on the `done` event + exit 0, and
 *   rejects with the tool's `error` message (or the stderr tail) otherwise. `cancel()`
 *   sends SIGTERM (SIGKILL after 5 s) and rejects with `cancelled`; config.json and
 *   workDir/audio are always removed first.
 */
function runJob({ python, script, workDir, torboxKey, hash, fileIds, title, paragraphs, onEvent } = {}) {
  if (activeJob) throw new Error('readalong: a job is already running');
  if (!python) throw new Error('runJob: python is required');
  if (!script) throw new Error('runJob: script is required');
  if (!workDir) throw new Error('runJob: workDir is required');

  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const ids = normalizeFileIds(fileIds);

  fs.mkdirSync(workDir, { recursive: true });
  const paragraphsPath = path.join(workDir, 'paragraphs.json');
  const configPath = path.join(workDir, 'config.json');
  const outPath = path.join(workDir, 'anchors.json');
  const audioDir = path.join(workDir, 'audio');

  fs.writeFileSync(paragraphsPath,
    JSON.stringify({ title: title || '', paragraphs: paragraphs || [] }));
  // The key never leaves this 0600 file, which is removed when the job ends.
  fs.writeFileSync(configPath,
    JSON.stringify({ torbox_api_key: String(torboxKey) }), { mode: 0o600 });

  const args = [script, '--config', configPath, 'anchors', '--hash', hash];
  if (ids && ids.length) args.push('--file-ids', ids.join(','));
  args.push('--paragraphs', paragraphsPath, '--out', outPath,
    '--download', '--audio-dir', audioDir, '--progress-json');
  // EARMARK_READALONG_REST=2 idles between pieces so a laptop's fans stay down; a build then takes
  // about three times as long. Off by default.
  const rest = Number(process.env.EARMARK_READALONG_REST ?? 0);
  if (Number.isFinite(rest) && rest > 0) args.push('--rest', String(rest));

  let child;
  try {
    child = spawn(python, args, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    fs.rmSync(configPath, { force: true });
    throw err;
  }

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  let finished = false;
  let cancelRequested = false;
  let killTimer = null;
  let doneEvent = null;
  let errorMessage = null;
  const stderrTail = [];

  const pushStderr = (line) => {
    const text = line.replace(/\r$/, '');
    if (!text) return;
    stderrTail.push(text);
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
  };

  // Resolve/reject only after the key file and audio are gone, so a caller that has
  // awaited the result can trust that the workspace is clean.
  const finish = (settle) => {
    if (finished) return;
    finished = true;
    if (killTimer) clearTimeout(killTimer);
    Promise.all([
      fsp.rm(configPath, { force: true }).catch(() => {}),
      fsp.rm(audioDir, { recursive: true, force: true }).catch(() => {}),
    ]).then(() => {
      if (activeJob === job) activeJob = null;
      try {
        settle();
      } catch (err) {
        rejectPromise(err);
      }
    });
  };

  let stdoutBuf = '';
  const handleLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return; // `--progress-json` makes stdout pure NDJSON; ignore anything else
    }
    if (event && event.event === 'done') doneEvent = event;
    if (event && event.event === 'error' && event.message) errorMessage = event.message;
    try {
      emit(event);
    } catch {
      // A misbehaving listener must not take down the job.
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) handleLine(line);
  });
  child.stdout.on('end', () => {
    if (stdoutBuf) handleLine(stdoutBuf);
    stdoutBuf = '';
  });

  child.stderr.setEncoding('utf8');
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const line of lines) pushStderr(line);
  });
  child.stderr.on('end', () => {
    if (stderrBuf) pushStderr(stderrBuf);
    stderrBuf = '';
  });

  child.on('error', (err) => {
    errorMessage = `failed to start readalong: ${err.message}`;
  });

  child.on('close', (code) => {
    finish(() => {
      if (cancelRequested) {
        rejectPromise(new Error('cancelled'));
        return;
      }
      if (code === 0 && doneEvent) {
        fsp.readFile(outPath, 'utf8')
          .then((text) => resolvePromise(JSON.parse(text)))
          .catch((err) => rejectPromise(new Error(`runJob: could not read ${outPath}: ${err.message}`)));
        return;
      }
      const tail = stderrTail.slice(-10).join('\n');
      rejectPromise(new Error(errorMessage || tail || `readalong exited with code ${code}`));
    });
  });

  const cancel = () => {
    if (finished || cancelRequested) return;
    cancelRequested = true;
    if (child.exitCode !== null || child.signalCode) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, SIGKILL_AFTER_MS);
    if (killTimer.unref) killTimer.unref();
  };

  const job = { promise, cancel };
  activeJob = job;
  return job;
}

module.exports = { status, fetchEpub, readEpub, runJob };
