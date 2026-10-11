"""Gist writer for the read-along job service.

The read-along record travels through the same private sync gist the app uses
(``earmark-sync.json``), under ``readalong[<audioHash>] = {value, updated}``.  This module finds
the user's gist, reads the document, sets (or re-sets) that one entry, and writes the whole
document back with nothing else touched -- unknown top-level keys and every other record are kept.

The sync gist is a shared last-write-wins document, so a device can overwrite our entry between
our read and our write (the "gist race" in SERVER-DESIGN.md).  After writing we re-read the gist
at a couple of delays and rewrite the entry if it is missing or older than ours.  All failures are
logged and retried a few times; none of them ever fails the build job -- the phone also fetches the
record straight from the job.

Only the standard library is used, and the API base URL is configurable so tests can point it at a
local fake instead of GitHub.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger("readalong.gist")

SYNC_FILE = "earmark-sync.json"


class GithubError(Exception):
    """A GitHub API call failed (network, HTTP error, or a malformed response)."""


class GistMissing(GithubError):
    """The cached gist id no longer resolves (deleted or no longer visible to the token)."""


def _as_ms(value) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


class GistClient:
    """Reads and writes one entry of the sync gist; safe to call from several threads."""

    def __init__(self, token: str, api_base: str = "https://api.github.com",
                 recheck_delays=(60.0, 300.0), retries: int = 3, retry_delay: float = 1.0,
                 timeout: float = 30.0, now=None):
        self.token = token
        self.api_base = api_base.rstrip("/")
        self.recheck_delays = tuple(float(d) for d in recheck_delays)
        self.retries = max(1, int(retries))
        self.retry_delay = float(retry_delay)
        self.timeout = float(timeout)
        self._now = now or (lambda: int(time.time() * 1000))
        self._gist_id: str | None = None
        self._lock = threading.Lock()
        self._timers: list[threading.Timer] = []

    # -- HTTP ---------------------------------------------------------------------------

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            # GitHub rejects requests without a User-Agent.
            "User-Agent": "Earmark-readalong-server",
        }

    def _request(self, method: str, url: str, body=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise GistMissing(f"GitHub 404 for {url}") from None
            raise GithubError(f"GitHub HTTP {e.code}") from None
        except urllib.error.URLError as e:
            raise GithubError(f"GitHub unreachable: {e.reason}") from None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            raise GithubError("GitHub returned invalid JSON") from None

    # -- gist / document -----------------------------------------------------------------

    def _find_gist(self) -> str:
        if self._gist_id:
            return self._gist_id
        for page in range(1, 11):
            url = f"{self.api_base}/gists?per_page=100&page={page}"
            items = self._request("GET", url)
            if not isinstance(items, list):
                break
            for g in items:
                files = g.get("files") if isinstance(g, dict) else None
                if isinstance(files, dict) and SYNC_FILE in files:
                    self._gist_id = str(g.get("id"))
                    return self._gist_id
            if len(items) < 100:
                break
        raise GithubError(f"no gist containing {SYNC_FILE}")

    def _read_doc(self):
        """Return ``(gist_id, document)``. Starts a fresh ``{}`` when the file is empty."""
        for _ in range(2):  # one retry when a cached gist id has gone stale
            gid = self._find_gist()
            try:
                gist = self._request("GET", f"{self.api_base}/gists/{gid}")
            except GistMissing:
                with self._lock:
                    self._gist_id = None
                continue
            file = (gist.get("files") or {}).get(SYNC_FILE) if isinstance(gist, dict) else None
            if not file:
                return gid, {}
            content = file.get("content")
            if file.get("truncated") and file.get("raw_url"):
                content = self._fetch_raw(str(file["raw_url"]))
            if not content:
                return gid, {}
            try:
                doc = json.loads(content)
            except ValueError:
                raise GithubError("the sync gist is not valid JSON") from None
            if not isinstance(doc, dict):
                raise GithubError("the sync gist is not a JSON object")
            return gid, doc
        raise GithubError("could not resolve the sync gist")

    def _fetch_raw(self, raw_url: str) -> str:
        # raw_url is pre-signed; deliberately no Authorization header on a different host.
        try:
            with urllib.request.urlopen(raw_url, timeout=self.timeout) as resp:
                return resp.read().decode("utf-8")
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            raise GithubError(f"could not read the raw sync gist: {e}") from None

    def _write_doc(self, gid: str, doc: dict) -> None:
        body = {"files": {SYNC_FILE: {"content": json.dumps(doc)}}}
        self._request("PATCH", f"{self.api_base}/gists/{gid}", body)

    # -- retries -------------------------------------------------------------------------

    def _with_retries(self, fn, what: str):
        last = None
        for attempt in range(1, self.retries + 1):
            try:
                return fn()
            except Exception as e:  # noqa: BLE001 - logged, never fatal to a job
                last = e
                if attempt < self.retries:
                    log.warning("%s failed (attempt %d/%d): %s", what, attempt, self.retries, e)
                    time.sleep(self.retry_delay)
                else:
                    log.error("%s failed after %d attempts: %s", what, self.retries, e)
        raise last

    # -- public API ----------------------------------------------------------------------

    def publish(self, audio_hash: str, record: dict) -> int:
        """Set ``readalong[audio_hash]`` and schedule the re-checks. Returns our ``updated`` (ms)."""
        key = audio_hash.lower()
        updated = self._now()

        def _do():
            gid, doc = self._read_doc()
            readalong = doc.get("readalong")
            if not isinstance(readalong, dict):
                readalong = {}
            readalong[key] = {"value": record, "updated": updated}
            doc["readalong"] = readalong
            self._write_doc(gid, doc)

        self._with_retries(_do, f"gist write for {key}")
        log.info("wrote readalong[%s] to the sync gist", key)
        self._schedule_rechecks(key, record, updated)
        return updated

    def publish_safe(self, audio_hash: str, record: dict) -> None:
        """``publish`` that swallows every failure (used by the worker, which must never fail)."""
        try:
            self.publish(audio_hash, record)
        except Exception as e:  # noqa: BLE001
            log.error("could not publish readalong[%s] to the gist (the job still succeeded): %s",
                      audio_hash.lower(), e)

    # -- re-check ------------------------------------------------------------------------

    def _schedule_rechecks(self, key: str, record: dict, updated: int) -> None:
        for delay in self.recheck_delays:
            if delay < 0:
                continue
            timer = threading.Timer(delay, self._recheck, args=(key, record, updated))
            timer.daemon = True
            with self._lock:
                self._timers.append(timer)
            timer.start()

    def _recheck(self, key: str, record: dict, updated: int) -> None:
        try:
            gid, doc = self._read_doc()
            readalong = doc.get("readalong") if isinstance(doc.get("readalong"), dict) else {}
            entry = readalong.get(key)
            if isinstance(entry, dict) and _as_ms(entry.get("updated")) >= updated:
                return  # still present and at least as new as ours
            new_updated = self._now()
            readalong[key] = {"value": record, "updated": new_updated}
            doc["readalong"] = readalong
            self._write_doc(gid, doc)
            log.info("re-wrote readalong[%s] (it was missing or older)", key)
        except Exception as e:  # noqa: BLE001 - a re-check must never crash
            log.warning("readalong re-check for %s failed: %s", key, e)

    def wait_for_rechecks(self, timeout: float) -> None:
        """Block until all scheduled re-checks finish (test helper; production never calls it)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                pending = [t for t in self._timers if t.is_alive()]
            if not pending:
                return
            time.sleep(0.02)
