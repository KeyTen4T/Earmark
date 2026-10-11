#!/usr/bin/env node
// Real smoke test for desktop/readalong.js: it drives the actual readalong.py against
// TorBox (read-only), then verifies cancellation. Run it from the repo root:
//
//   node desktop/scripts/smoke-readalong.mjs
//
// Defaults point at the Harry Potter audiobook used while developing this. Override any
// of them, e.g.:
//
//   node desktop/scripts/smoke-readalong.mjs --hash <infohash> --file-ids 2,5 \\
//     --paragraphs /path/to/paras.json --workdir /tmp/smoke --skip-cancel
//
// It downloads the selected audio into <workdir>/audio (which readalong.js deletes when
// the job ends), prints how many of each progress event arrived, and reports the anchor
// count and epub.paragraphsSha1. It only reads from TorBox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const readalong = require('../readalong.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SCRATCH = path.join(os.tmpdir(), 'earmark-smoke');

const DEFAULTS = {
  hash: process.env.EARMARK_SMOKE_HASH || '',
  fileIds: '2',
  paragraphs: path.join(SCRATCH, 'paras.json'),
  workdir: path.join(SCRATCH, 'smoke'),
  config: path.join(os.homedir(), '.config', 'earmark-readalong', 'config.json'),
  python: path.join(os.homedir(), '.local', 'share', 'earmark-readalong', 'venv', 'bin', 'python'),
  script: path.join(repoRoot, 'tools', 'readalong', 'readalong.py'),
  skipRun: false,
  skipCancel: false,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  const stringFlags = {
    '--hash': 'hash',
    '--file-ids': 'fileIds',
    '--paragraphs': 'paragraphs',
    '--workdir': 'workdir',
    '--config': 'config',
    '--python': 'python',
    '--script': 'script',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('usage: node desktop/scripts/smoke-readalong.mjs '
        + '[--hash H] [--file-ids IDS] [--paragraphs FILE] [--workdir DIR] '
        + '[--config FILE] [--python PATH] [--script PATH] [--skip-run] [--skip-cancel]');
      process.exit(0);
    } else if (arg === '--skip-run') {
      out.skipRun = true;
    } else if (arg === '--skip-cancel') {
      out.skipCancel = true;
    } else if (stringFlags[arg]) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      out[stringFlags[arg]] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const countString = (counts) => [...counts.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, n]) => `${name}=${n}`)
  .join(' ');

/**
 * Run one job and collect event counts.
 * @returns {Promise<{anchors?: object, error?: Error, counts: Map<string, number>}>}
 */
async function runOnce(opts, key, workDir, { cancelAfterStart }) {
  const counts = new Map();
  let job = null;
  job = readalong.runJob({
    python: opts.python,
    script: opts.script,
    workDir,
    torboxKey: key,
    hash: opts.hash,
    fileIds: opts.fileIds,
    title: opts.doc.title || '',
    paragraphs: opts.doc.paragraphs || [],
    onEvent: (ev) => {
      counts.set(ev.event, (counts.get(ev.event) || 0) + 1);
      if (ev.event === 'start') {
        console.log(`  start: files=${ev.files} clips=${ev.clips}`);
        if (cancelAfterStart) setImmediate(() => job.cancel());
      } else if (ev.event === 'error') {
        console.log(`  error: ${ev.message}`);
      }
    },
  });
  try {
    return { anchors: await job.promise, counts };
  } catch (error) {
    return { error, counts };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.hash) { console.error('Pass --hash <audiobook torrent hash> (or set EARMARK_SMOKE_HASH).'); process.exit(2); }

  const status = readalong.status({ python: opts.python, script: opts.script });
  console.log('status:', JSON.stringify(status));
  if (!status.available) {
    console.error(`readalong is not available: ${status.reason}`);
    process.exitCode = 2;
    return;
  }

  const key = JSON.parse(fs.readFileSync(opts.config, 'utf8')).torbox_api_key;
  if (!key) throw new Error(`no torbox_api_key in ${opts.config}`);
  opts.doc = JSON.parse(fs.readFileSync(opts.paragraphs, 'utf8'));
  console.log(`book: ${JSON.stringify(opts.doc.title)} (${opts.doc.paragraphs.length} paragraphs)`);

  let failed = false;

  if (!opts.skipRun) {
    console.log(`\n== run: hash=${opts.hash} file-ids=${opts.fileIds} workdir=${opts.workdir}`);
    const r = await runOnce(opts, key, opts.workdir, { cancelAfterStart: false });
    console.log('events:', countString(r.counts));
    if (r.error) {
      console.error('run failed:', r.error.message);
      failed = true;
    } else {
      const anchors = r.anchors.files.reduce((n, f) => n + f.anchors.length, 0);
      console.log(`anchors: ${anchors}`);
      console.log(`epub.paragraphsSha1: ${r.anchors.epub.paragraphsSha1}`);
    }
  }

  if (!opts.skipCancel) {
    const cancelWorkDir = path.join(opts.workdir, 'cancel');
    const audioDir = path.join(cancelWorkDir, 'audio');
    console.log(`\n== cancel: workdir=${cancelWorkDir}`);
    const r = await runOnce(opts, key, cancelWorkDir, { cancelAfterStart: true });
    console.log('events:', countString(r.counts));
    const rejected = Boolean(r.error) && r.error.message === 'cancelled';
    const audioGone = !fs.existsSync(audioDir);
    console.log(`cancel rejected with 'cancelled': ${rejected}`);
    console.log(`audio dir removed: ${audioGone}`);
    if (!rejected || !audioGone) failed = true;
  }

  console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE OK');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
