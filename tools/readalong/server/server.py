#!/usr/bin/env python3
"""Read-along job service: one HTTP API, one worker, one job at a time.

The phone POSTs a book (audiobook hash + TorBox file ids + the EPUB's paragraph list) and the
service runs ``readalong.py anchors --download --progress-json`` on CPU, then turns the resulting
``anchors.json`` into the app's compact record and stores it on the job.  The record is also
written into the shared sync gist so every device picks it up (see ``gist.py``).

Only the standard library is used.  ``readalong.py`` and its heavy dependencies (faster-whisper,
ffmpeg, ...) are only touched by the child process, so this file runs with a bare Python 3.11.

Endpoints (all under ``/readalong``; Nginx Proxy Manager forwards the path unchanged)::

    POST   /readalong/v1/jobs            queue a build (deduped per audiobook hash)
    GET    /readalong/v1/jobs/{id}       job status, with the record once done
    GET    /readalong/v1/jobs?hash=...   the latest job for a book
    DELETE /readalong/v1/jobs/{id}       cancel a queued/running job
    GET    /readalong/v1/health          up + version + queue length (no auth)

Everything else 404s.  Every endpoint except ``health`` needs ``Authorization: Bearer <API_TOKEN>``.

Run from the command line; configuration comes from the environment (see ``Config.from_env``).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from gist import GistClient

VERSION = "1.0.0"
PREFIX = "/readalong"
MAX_BODY = 5 * 1024 * 1024          # 5 MB; a long book's paragraphs are about 1 MB
MAX_FILE_IDS = 200
MAX_PARAGRAPHS = 50000
MAX_TITLE = 300
MAX_QUEUED = 10
HEX40 = re.compile(r"^[0-9a-fA-F]{40}$")
JOB_ID = re.compile(r"^[0-9a-f]{32}$")  # uuid4().hex, the only ids this server creates

log = logging.getLogger("readalong.server")

# Job statuses, in lifecycle order.
QUEUED, DOWNLOADING, BUILDING, DONE, FAILED, CANCELLED = (
    "queued", "downloading", "building", "done", "failed", "cancelled")
RUNNING = "running"  # the child process is launching, before the first progress event


# --------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------

def _default_script() -> str:
    """readalong.py sits beside server.py in the image, and one directory up in the repo."""
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (os.path.join(here, "readalong.py"),
                      os.path.join(os.path.dirname(here), "readalong.py")):
        if os.path.exists(candidate):
            return candidate
    return os.path.join(here, "readalong.py")


def _split_delays(raw: str) -> tuple:
    raw = (raw or "").strip()
    if not raw:
        return ()
    return tuple(float(part) for part in raw.split(",") if part.strip())


# Environment variables the service reads its secrets from; never passed on to the tool it runs.
CHILD_ENV_DROPPED = ("API_TOKEN", "TORBOX_API_KEY", "GITHUB_GIST_TOKEN")


@dataclass
class Config:
    api_token: str
    torbox_api_key: str
    github_gist_token: str
    data_dir: str = "/data"
    model: str = "base.en"
    cpu_threads: int = 2
    port: int = 8080
    readalong_script: str = field(default_factory=_default_script)
    github_api: str = "https://api.github.com"
    gist_recheck_delays: tuple = (60.0, 300.0)
    gist_retries: int = 3
    gist_retry_delay: float = 1.0
    python: str = field(default_factory=lambda: sys.executable)
    nice: tuple = ("nice", "-n", "19")

    @classmethod
    def from_env(cls, environ=None) -> "Config":
        env = os.environ if environ is None else environ
        token = env.get("API_TOKEN", "")
        if len(token) < 32:
            raise SystemExit("API_TOKEN must be at least 32 characters; refusing to start")
        return cls(
            api_token=token,
            torbox_api_key=env.get("TORBOX_API_KEY", ""),
            github_gist_token=env.get("GITHUB_GIST_TOKEN", ""),
            data_dir=env.get("DATA_DIR", "/data"),
            model=env.get("MODEL", "base.en"),
            cpu_threads=int(env.get("CPU_THREADS", "2")),
            port=int(env.get("PORT", "8080")),
            readalong_script=env.get("READALONG_SCRIPT") or _default_script(),
            github_api=env.get("GITHUB_API", "https://api.github.com"),
            gist_recheck_delays=_split_delays(env.get("GIST_RECHECK_DELAYS", "60,300")),
            gist_retries=int(env.get("GIST_RETRIES", "3")),
            gist_retry_delay=float(env.get("GIST_RETRY_DELAY", "1")),
        )


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------------------

def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_hex40(value) -> bool:
    return isinstance(value, str) and bool(HEX40.match(value))


def _paragraphs_sha1(paragraphs) -> str:
    """SHA-1 hex of the paragraphs joined with "\\n" (UTF-8). Mirrors `paragraphsSha1` in
    src/readalong/epub.ts and `paragraphs_sha1` in readalong.py."""
    joined = "\n".join("" if p is None else str(p) for p in paragraphs)
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()


def validate_request(body) -> dict:
    """Validate a POST /jobs body, returning a normalised copy or raising ``HttpError(400)``."""
    if not isinstance(body, dict):
        raise HttpError(400, "body must be a JSON object")

    audio_hash = body.get("audioHash")
    if not _is_hex40(audio_hash):
        raise HttpError(400, "audioHash must be 40 hex characters")

    file_ids = body.get("fileIds")
    if not isinstance(file_ids, list) or not file_ids:
        raise HttpError(400, "fileIds must be a non-empty list of integers")
    if len(file_ids) > MAX_FILE_IDS:
        raise HttpError(400, f"fileIds must contain at most {MAX_FILE_IDS} entries")
    if not all(_is_int(fid) for fid in file_ids):
        raise HttpError(400, "fileIds must contain only integers")

    epub = body.get("epub")
    if not isinstance(epub, dict):
        raise HttpError(400, "epub must be an object")
    if not _is_hex40(epub.get("hash")):
        raise HttpError(400, "epub.hash must be 40 hex characters")
    if not _is_int(epub.get("fileId")):
        raise HttpError(400, "epub.fileId must be an integer")
    title = epub.get("title")
    if not isinstance(title, str):
        raise HttpError(400, "epub.title must be a string")
    if len(title) > MAX_TITLE:
        raise HttpError(400, f"epub.title must be at most {MAX_TITLE} characters")

    paragraphs = body.get("paragraphs")
    if not isinstance(paragraphs, list):
        raise HttpError(400, "paragraphs must be a list of strings")
    if not 1 <= len(paragraphs) <= MAX_PARAGRAPHS:
        raise HttpError(400, f"paragraphs must contain between 1 and {MAX_PARAGRAPHS} entries")
    if not all(isinstance(p, str) for p in paragraphs):
        raise HttpError(400, "paragraphs must contain only strings")

    sent_sha1 = body.get("paragraphsSha1")
    if not isinstance(sent_sha1, str):
        raise HttpError(400, "paragraphsSha1 must be a string")
    if not hmac.compare_digest(_paragraphs_sha1(paragraphs), sent_sha1):
        raise HttpError(400, "paragraphsSha1 does not match the paragraphs")

    return {
        "audioHash": audio_hash.lower(),
        "fileIds": list(file_ids),
        "epub": {"hash": epub["hash"], "fileId": epub["fileId"], "title": title},
        "paragraphs": list(paragraphs),
        "paragraphsSha1": sent_sha1,
    }


# --------------------------------------------------------------------------------------
# The synced record (ported from the app)
# --------------------------------------------------------------------------------------

def record_from_anchors(anchors_json, epub_hash: str, epub_file_id: int, created_ms: int) -> dict:
    """Faithful port of ``fromAnchorsJson`` in ``src/readalong/anchors.ts``.

    Malformed files/anchors are dropped rather than raising; each file's anchors are sorted by
    time.  ``epub.hash``/``epub.fileId`` come from the request (the EPUB the user picked), while
    title/paragraphs/paragraphsSha1 come from ``anchors.json``'s ``epub`` block.  ``timing: 2`` is
    added for version-2 (word-timed) anchors, exactly as the TS code does.
    """
    files = []
    raw_files = anchors_json.get("files") if isinstance(anchors_json, dict) else None
    for f in raw_files or []:
        if not isinstance(f, dict) or not _is_number(f.get("id")):
            continue
        anchors = []
        for a in f.get("anchors") or []:
            if not isinstance(a, dict):
                continue
            if not (_is_number(a.get("t")) and _is_number(a.get("para")) and _is_number(a.get("word"))):
                continue
            anchors.append([a["t"], a["para"], a["word"]])
        anchors.sort(key=lambda x: x[0])
        duration = f.get("duration")
        entry = {
            "id": f["id"],
            "duration": duration if _is_number(duration) else 0,
            "anchors": anchors,
        }
        # A Xing seek map is opaque here (the app validates it with decodeSeekMap); copy it through
        # so it survives the record conversion and reaches the gist.
        if isinstance(f.get("seek"), dict):
            entry["seek"] = f["seek"]
        files.append(entry)

    epub_meta = anchors_json.get("epub") if isinstance(anchors_json, dict) else None
    if not isinstance(epub_meta, dict):
        epub_meta = {}
    title = epub_meta.get("title")
    paragraphs_count = epub_meta.get("paragraphs")
    paragraphs_sha1 = epub_meta.get("paragraphsSha1")
    version = anchors_json.get("version") if isinstance(anchors_json, dict) else None
    timing = anchors_json.get("timing") if isinstance(anchors_json, dict) else None
    word_timed = timing == "word" or (_is_number(version) and version >= 2)

    record = {
        "epub": {
            "hash": epub_hash,
            "fileId": epub_file_id,
            "title": title if isinstance(title, str) else "",
            "paragraphs": int(paragraphs_count) if _is_number(paragraphs_count) else 0,
            "paragraphsSha1": paragraphs_sha1 if isinstance(paragraphs_sha1, str) else "",
        },
        "files": files,
        "created": created_ms,
    }
    if word_timed:
        record["timing"] = 2
    return record


# --------------------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  audio_hash TEXT NOT NULL,
  status     TEXT NOT NULL,
  cls_done   INTEGER NOT NULL DEFAULT 0,
  cls_total  INTEGER NOT NULL DEFAULT 0,
  matched    INTEGER NOT NULL DEFAULT 0,
  dl_bytes   INTEGER NOT NULL DEFAULT 0,
  dl_total   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  record     TEXT,
  request    TEXT NOT NULL,
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_audio_hash_idx ON jobs(audio_hash);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
"""


class Store:
    """SQLite-backed job queue. All access is serialised on one lock (small, low-traffic)."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.jobs_root, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(os.path.join(self.data_dir, "jobs.db"),
                                     check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    @property
    def jobs_root(self) -> str:
        return os.path.join(self.data_dir, "jobs")

    def job_dir(self, job_id: str) -> str:
        return os.path.join(self.jobs_root, job_id)

    def paragraphs_path(self, job_id: str) -> str:
        return os.path.join(self.job_dir(job_id), "paragraphs.json")

    # -- writes ---------------------------------------------------------------------

    def create(self, job_id: str, request: dict, paragraphs: list, created_ms: int) -> None:
        jd = self.job_dir(job_id)
        os.makedirs(jd, exist_ok=True)
        with open(self.paragraphs_path(job_id), "w", encoding="utf-8") as fh:
            json.dump({"title": request["epub"]["title"], "paragraphs": paragraphs}, fh,
                      ensure_ascii=False)
        request_blob = json.dumps({k: v for k, v in request.items() if k != "paragraphs"})
        with self._lock:
            self._conn.execute(
                "INSERT INTO jobs (id, audio_hash, status, request, created, updated) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (job_id, request["audioHash"], QUEUED, request_blob, created_ms, created_ms))
            self._conn.commit()

    def update(self, job_id: str, **fields) -> None:
        if not fields:
            return
        fields["updated"] = int(time.time() * 1000)
        cols = ", ".join(f"{k} = ?" for k in fields)
        with self._lock:
            self._conn.execute(f"UPDATE jobs SET {cols} WHERE id = ?", (*fields.values(), job_id))
            self._conn.commit()

    def claim(self, job_id: str) -> bool:
        """Move a job queued -> running atomically; False if it is no longer queued (e.g. cancelled)."""
        now = int(time.time() * 1000)
        with self._lock:
            cur = self._conn.execute(
                "UPDATE jobs SET status = ?, updated = ? WHERE id = ? AND status = ?",
                (RUNNING, now, job_id, QUEUED))
            self._conn.commit()
            return cur.rowcount == 1

    def finish(self, job_id: str, status: str, record=None, error=None, matched=None,
               cls_total=None) -> None:
        fields = {"status": status, "error": error,
                  "record": json.dumps(record) if record is not None else None}
        if matched is not None:
            fields["matched"] = matched
        if cls_total is not None:
            fields["cls_total"] = cls_total
        self.update(job_id, **fields)

    def recover(self) -> int:
        """Any in-progress job left behind by a crash goes back to ``queued`` (incl. ``running``)."""
        with self._lock:
            cur = self._conn.execute(
                "UPDATE jobs SET status = ? WHERE status IN (?, ?, ?)",
                (QUEUED, RUNNING, DOWNLOADING, BUILDING))
            self._conn.commit()
            return cur.rowcount

    def remove_stale_files(self) -> None:
        """Remove leftover temp configs and audio dirs for queued jobs (e.g. after a crash)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT id FROM jobs WHERE status = ?", (QUEUED,)).fetchall()
        for row in rows:
            jd = self.job_dir(row["id"])
            try:
                os.remove(os.path.join(jd, "config.json"))
            except OSError:
                pass
            shutil.rmtree(os.path.join(jd, "audio"), ignore_errors=True)

    # -- reads ----------------------------------------------------------------------

    def _row(self, sql: str, params=()) -> dict | None:
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return self._to_job(row) if row else None

    def get(self, job_id: str) -> dict | None:
        return self._row("SELECT * FROM jobs WHERE id = ?", (job_id,))

    def latest_for_hash(self, audio_hash: str) -> dict | None:
        return self._row(
            "SELECT * FROM jobs WHERE audio_hash = ? ORDER BY created DESC, id DESC LIMIT 1",
            (audio_hash,))

    def find_active(self, audio_hash: str) -> dict | None:
        return self._row(
            "SELECT * FROM jobs WHERE audio_hash = ? AND status IN (?, ?, ?, ?) "
            "ORDER BY created DESC, id DESC LIMIT 1",
            (audio_hash, RUNNING, QUEUED, DOWNLOADING, BUILDING))

    def next_queued(self) -> dict | None:
        return self._row("SELECT * FROM jobs WHERE status = ? ORDER BY created ASC, id ASC LIMIT 1",
                         (QUEUED,))

    def count_queued(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM jobs WHERE status = ?",
                                     (QUEUED,)).fetchone()
        return int(row["n"])

    def has_running(self) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM jobs WHERE status IN (?, ?, ?)",
                (RUNNING, DOWNLOADING, BUILDING)).fetchone()
        return int(row["n"]) > 0

    def position(self, job: dict) -> int:
        """1-based queue position (a running job is #1)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS n FROM jobs WHERE status IN (?, ?, ?, ?) "
                "AND (created < ? OR (created = ? AND id < ?))",
                (RUNNING, QUEUED, DOWNLOADING, BUILDING,
                 job["created"], job["created"], job["id"])).fetchone()
        return int(row["n"]) + 1

    def _to_job(self, row: sqlite3.Row) -> dict:
        job = dict(row)
        job["record"] = json.loads(job["record"]) if job.get("record") else None
        job["request"] = json.loads(job["request"]) if job.get("request") else {}
        return job

    def close(self) -> None:
        with self._lock:
            self._conn.close()


# --------------------------------------------------------------------------------------
# The service
# --------------------------------------------------------------------------------------

class ReadalongServer:
    """Holds the queue, the single worker, and the gist writer."""

    def __init__(self, config: Config, gist: GistClient | None = None, store: Store | None = None):
        self.config = config
        self.store = store or Store(config.data_dir)
        if gist is not None:
            self.gist = gist
        elif config.github_gist_token:
            self.gist = GistClient(
                config.github_gist_token, api_base=config.github_api,
                recheck_delays=config.gist_recheck_delays,
                retries=config.gist_retries, retry_delay=config.gist_retry_delay)
        else:
            self.gist = None
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self._procs: dict[str, subprocess.Popen] = {}
        self._cancelled: set[str] = set()
        self._last_status: dict[str, str] = {}

    # -- lifecycle ------------------------------------------------------------------

    def start(self) -> None:
        recovered = self.store.recover()
        if recovered:
            log.info("recovered %d in-progress job(s) back to queued", recovered)
        self.store.remove_stale_files()
        self._stop.clear()
        self._worker = threading.Thread(target=self._work_loop, name="readalong-worker", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._lock:
            procs = list(self._procs.values())
        for proc in procs:
            self._terminate(proc)
        if self._worker:
            self._worker.join(timeout=10)

    # -- HTTP-facing operations -----------------------------------------------------

    def authorized(self, header: str | None) -> bool:
        if not header:
            return False
        parts = header.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return False
        try:
            return hmac.compare_digest(parts[1].encode("utf-8"),
                                       self.config.api_token.encode("utf-8"))
        except (UnicodeError, TypeError):
            return False

    def health(self) -> dict:
        return {"status": "ok", "version": VERSION, "queue": self.store.count_queued(),
                "running": self.store.has_running()}

    def enqueue(self, request: dict) -> tuple[dict, bool]:
        """Dedup, enforce the queue limit, and persist the job. Returns ``(job, created)``."""
        audio_hash = request["audioHash"]
        with self._lock:
            existing = self.store.find_active(audio_hash)
            if existing:
                return existing, False
            if self.store.count_queued() >= MAX_QUEUED:
                raise HttpError(429, "too many queued jobs; try again later")
            job_id = uuid.uuid4().hex
            created = int(time.time() * 1000)
            self.store.create(job_id, request, request["paragraphs"], created)
            job = self.store.get(job_id)
        log.info("job %s queued for %s", job_id, audio_hash)
        self._wake.set()
        return job, True

    def cancel(self, job_id: str) -> dict | None:
        job = self.store.get(job_id)
        if not job:
            return None
        if job["status"] in (QUEUED, DOWNLOADING, BUILDING, RUNNING):
            with self._lock:
                self._cancelled.add(job_id)
                proc = self._procs.get(job_id)
            if proc is not None:
                self._terminate(proc)
            self.store.update(job_id, status=CANCELLED)
            if proc is None:
                # The worker may never pick up a job cancelled while queued; clean it here.
                self._cleanup_job(job_id)
            log.info("job %s cancelled", job_id)
            self._wake.set()
        return self.store.get(job_id)

    def _is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._cancelled

    def _cleanup_job(self, job_id: str) -> None:
        jd = self.store.job_dir(job_id)
        self._cleanup(job_id, os.path.join(jd, "config.json"), os.path.join(jd, "audio"), jd)

    # -- worker ---------------------------------------------------------------------

    def _work_loop(self) -> None:
        while not self._stop.is_set():
            job = self.store.next_queued()
            if job is None:
                self._wake.wait(timeout=1.0)
                self._wake.clear()
                continue
            try:
                self._run_job(job)
            except Exception:  # noqa: BLE001 - a worker must never die
                log.exception("job %s crashed in the worker", job["id"])
                self.store.update(job["id"], status=FAILED, error="internal error")

    def _run_job(self, job: dict) -> None:
        job_id = job["id"]
        # Re-read: it may have been cancelled between selection and here.
        current = self.store.get(job_id)
        if not current or current["status"] != QUEUED:
            if current and current["status"] == CANCELLED:
                self._cleanup_job(job_id)
            return
        if not self.store.claim(job_id):
            self._cleanup_job(job_id)
            return
        self._last_status[job_id] = RUNNING
        log.info("job %s -> %s", job_id, RUNNING)

        jd = self.store.job_dir(job_id)
        os.makedirs(jd, exist_ok=True)
        audio_dir = os.path.join(jd, "audio")
        config_path = os.path.join(jd, "config.json")
        anchors_path = os.path.join(jd, "anchors.json")
        stderr_path = os.path.join(jd, "stderr.log")
        request = current["request"]

        if not current["request"] or not os.path.exists(self.store.paragraphs_path(job_id)):
            self.store.finish(job_id, FAILED, error="job input is missing")
            self._cleanup(job_id, config_path, audio_dir, jd)
            return

        self._write_secret_config(config_path)
        cmd = self._build_command(request, self.store.paragraphs_path(job_id), anchors_path, audio_dir)
        log.info("job %s launching readalong.py", job_id)

        proc = None
        try:
            with open(stderr_path, "wb") as errfh:
                # Launch while holding the lock so a concurrent cancel either sees no process (and
                # cleans up) or sees the registered process (and terminates it).
                with self._lock:
                    if job_id in self._cancelled:
                        return
                    proc = self._popen(cmd, errfh)
                    self._procs[job_id] = proc
                for line in proc.stdout:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    self._handle_event(job_id, event, anchors_path)
                proc.wait()
            if self._is_cancelled(job_id):
                log.info("job %s stopped after cancel", job_id)
            elif proc.returncode != 0:
                self._fail_from_process(job_id, proc.returncode, stderr_path)
        except FileNotFoundError as e:
            self.store.update(job_id, status=FAILED, error=f"could not launch readalong.py: {e}")
        finally:
            if proc is not None and proc.stdout is not None:
                try:
                    proc.stdout.close()
                except OSError:
                    pass
            with self._lock:
                self._procs.pop(job_id, None)
                self._cancelled.discard(job_id)
                self._last_status.pop(job_id, None)
            self._cleanup(job_id, config_path, audio_dir, jd)

    def _build_command(self, request, paragraphs_path, anchors_path, audio_dir) -> list:
        job_dir = os.path.dirname(anchors_path)
        cmd = [
            self.config.python, self.config.readalong_script,
            "--config", os.path.join(job_dir, "config.json"),
            "anchors",
            "--hash", request["audioHash"],
            "--file-ids", ",".join(str(fid) for fid in request["fileIds"]),
            "--paragraphs", paragraphs_path,
            "--out", anchors_path,
            "--download",
            "--audio-dir", audio_dir,
            "--progress-json",
            "--model", self.config.model,
            "--device", "cpu",
            "--threads", str(self.config.cpu_threads),
        ]
        if self.config.nice:
            cmd = list(self.config.nice) + cmd
        return cmd

    def _popen(self, cmd: list, errfh):
        try:
            return self._spawn(cmd, errfh)
        except FileNotFoundError:
            # `nice` may not be installed in an unusual image; retry without the prefix.
            nice = list(self.config.nice)
            if nice and cmd[:len(nice)] == nice:
                return self._spawn(cmd[len(nice):], errfh)
            raise

    @staticmethod
    def _spawn(cmd: list, errfh):
        # The tool gets its TorBox key from the job's config.json and needs none of the service's
        # secrets, so they are kept out of its environment.
        env = {k: v for k, v in os.environ.items() if k not in CHILD_ENV_DROPPED}
        return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errfh,
                                text=True, bufsize=1, close_fds=True, env=env)

    def _handle_event(self, job_id: str, event: dict, anchors_path: str) -> None:
        if self._is_cancelled(job_id):
            return
        kind = event.get("event")
        if kind == "start":
            self._set_status(job_id, DOWNLOADING, cls_total=int(event.get("clips") or 0))
        elif kind == "download":
            self._set_status(job_id, DOWNLOADING,
                             dl_bytes=int(event.get("bytes") or 0),
                             dl_total=int(event.get("total") or 0))
        elif kind == "clip":
            self._set_status(job_id, BUILDING,
                             cls_done=int(event.get("done") or 0),
                             cls_total=int(event.get("total") or 0))
        elif kind == "error":
            self.store.finish(job_id, FAILED, error=str(event.get("message") or "build failed"))
            log.info("job %s -> failed: %s", job_id, event.get("message"))
        elif kind == "done":
            self._complete(job_id, event, anchors_path)

    def _set_status(self, job_id: str, status: str, **fields) -> None:
        self.store.update(job_id, status=status, **fields)
        if self._last_status.get(job_id) != status:
            self._last_status[job_id] = status
            log.info("job %s -> %s", job_id, status)

    def _complete(self, job_id: str, event: dict, anchors_path: str) -> None:
        if self._is_cancelled(job_id):
            return
        try:
            with open(anchors_path, encoding="utf-8") as fh:
                anchors_json = json.load(fh)
        except (OSError, ValueError) as e:
            self.store.finish(job_id, FAILED, error=f"could not read anchors.json: {e}")
            return
        job = self.store.get(job_id)
        request = job["request"]
        record = record_from_anchors(anchors_json, request["epub"]["hash"],
                                     request["epub"]["fileId"], int(time.time() * 1000))
        self.store.finish(job_id, DONE, record=record,
                          matched=int(event.get("matched") or 0),
                          cls_total=int(event.get("clips") or 0))
        log.info("job %s done (%d/%d clips matched)", job_id,
                 int(event.get("matched") or 0), int(event.get("clips") or 0))
        if self.gist is not None:
            audio_hash = request["audioHash"]
            threading.Thread(target=self.gist.publish_safe, args=(audio_hash, record),
                             daemon=True).start()

    def _fail_from_process(self, job_id: str, returncode: int, stderr_path: str) -> None:
        message = f"readalong.py exited with code {returncode}"
        tail = self._stderr_tail(stderr_path)
        if tail:
            message = f"{message}: {tail}"
        self.store.finish(job_id, FAILED, error=self._redact(message))
        log.info("job %s failed: %s", job_id, message)

    def _stderr_tail(self, path: str, limit: int = 500) -> str:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                data = fh.read()
        except OSError:
            return ""
        lines = [ln.strip() for ln in data.splitlines() if ln.strip()]
        return (lines[-1] if lines else "")[:limit]

    def _redact(self, text: str) -> str:
        for secret in (self.config.torbox_api_key, self.config.github_gist_token,
                       self.config.api_token):
            if secret:
                text = text.replace(secret, "***")
        return text

    # -- helpers --------------------------------------------------------------------

    def _write_secret_config(self, path: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"torbox_api_key": self.config.torbox_api_key}, fh)
        finally:
            os.chmod(path, 0o600)

    def _cleanup(self, job_id: str, config_path: str, audio_dir: str, job_dir: str) -> None:
        """Always remove the secret temp config and the audio dir; drop the rest of the job dir."""
        try:
            os.remove(config_path)
        except OSError:
            pass
        shutil.rmtree(audio_dir, ignore_errors=True)
        shutil.rmtree(job_dir, ignore_errors=True)

    @staticmethod
    def _terminate(proc) -> None:
        if proc.poll() is not None:
            return
        try:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        except OSError:
            pass


# --------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "readalong/" + VERSION
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> ReadalongServer:
        return self.server.app  # type: ignore[attr-defined]

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")

    def log_message(self, fmt, *args):  # silence the default stderr access log
        return

    def _route(self, method: str) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        close = False
        try:
            status, payload, close = self._dispatch(method, path, query)
        except HttpError as e:
            status, payload, close = e.status, {"error": e.message}, True
        except Exception:  # noqa: BLE001
            log.exception("unhandled error for %s %s", method, path)
            status, payload, close = 500, {"error": "internal error"}, True
        self._send_json(status, payload, close=close)
        log.info("%s %s -> %d", method, path, status)

    def _dispatch(self, method, path, query):
        if method == "GET" and path == PREFIX + "/v1/health":
            return 200, self.app.health(), False

        if not self.app.authorized(self.headers.get("Authorization")):
            # Do not read the body on a failed auth; close so the connection cannot desync.
            return 401, {"error": "unauthorized"}, True

        if method == "POST" and path == PREFIX + "/v1/jobs":
            return self._post_job()

        if method == "GET" and path == PREFIX + "/v1/jobs":
            hashes = query.get("hash")
            if not hashes or not _is_hex40(hashes[0]):
                raise HttpError(400, "hash must be 40 hex characters")
            job = self.app.store.latest_for_hash(hashes[0].lower())
            if not job:
                raise HttpError(404, "no job for that hash")
            return 200, self._job_view(job), False

        if path.startswith(PREFIX + "/v1/jobs/"):
            job_id = path[len(PREFIX) + len("/v1/jobs/"):]
            if not JOB_ID.match(job_id):
                raise HttpError(404, "not found")
            if method == "GET":
                job = self.app.store.get(job_id)
                if not job:
                    raise HttpError(404, "job not found")
                return 200, self._job_view(job), False
            if method == "DELETE":
                job = self.app.cancel(job_id)
                if not job:
                    raise HttpError(404, "job not found")
                return 200, {"id": job["id"], "status": job["status"]}, False
            raise HttpError(404, "not found")

        raise HttpError(404, "not found")

    def _post_job(self):
        body = self._read_json_body()
        request = validate_request(body)
        job, created = self.app.enqueue(request)
        return 200, {"id": job["id"], "position": self.app.store.position(job),
                     "status": job["status"]}, False

    def _read_json_body(self):
        header = self.headers.get("Content-Length")
        if header is None:
            raise HttpError(411, "Content-Length required")
        try:
            length = int(header)
        except ValueError:
            raise HttpError(400, "invalid Content-Length") from None
        if length < 0:
            raise HttpError(400, "invalid Content-Length")
        if length > MAX_BODY:
            raise HttpError(413, "request body too large")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise HttpError(400, "body must be valid JSON") from None

    def _job_view(self, job: dict) -> dict:
        return {
            "id": job["id"],
            "status": job["status"],
            "position": self.app.store.position(job),
            "done": job["cls_done"],
            "total": job["cls_total"],
            "matched": job["matched"],
            "bytes": job["dl_bytes"],
            "bytesTotal": job["dl_total"],
            "error": job["error"],
            "record": job["record"] if job["status"] == DONE else None,
            "createdAt": job["created"],
            "updatedAt": job["updated"],
        }

    def _send_json(self, status: int, payload: dict, close: bool = False) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


class _Httpd(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, app):
        self.app = app
        super().__init__(address, handler)


def make_server(app: ReadalongServer, host: str = "127.0.0.1", port: int = 0) -> _Httpd:
    return _Httpd((host, port), Handler, app)


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        stream=sys.stderr)


def main(argv=None) -> int:
    configure_logging()
    config = Config.from_env()
    app = ReadalongServer(config)
    httpd = make_server(app, host="0.0.0.0", port=config.port)
    app.start()
    log.info("readalong-server %s listening on :%d (data %s, model %s, threads %d)",
             VERSION, config.port, config.data_dir, config.model, config.cpu_threads)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
        app.stop()
        app.store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
