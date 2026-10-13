#!/usr/bin/env python3
"""Offline tests for the read-along job service.

Run:  python3 -m unittest -v test_server

No network: a fake ``readalong.py`` emits realistic ``--progress-json`` events and writes a
version-2 ``anchors.json``, and a tiny local HTTP server stands in for the GitHub API.  The service
runs in-process on random ports with a temporary ``DATA_DIR``.
"""

import hashlib
import http.client
import http.server
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server as sv  # noqa: E402
from gist import GistClient  # noqa: E402


API_TOKEN = "A" * 43
TORBOX_KEY = "torbox-secret-key-do-not-log"
GIST_TOKEN = "gist-secret-token-do-not-log"

# The request the tests send. The EPUB block points at a torrent the tool never touches (the fake
# script ignores TorBox), and the paragraph list drives the record's epub.paragraphs / sha1.
AUDIO_HASH = "1" * 40
EPUB_HASH = "2" * 40
EPUB_FILE_ID = 55
PARAGRAPHS = ["Alpha beta gamma.", "Delta epsilon zeta.", "Eta theta iota kappa."]
PARAGRAPHS_SHA1 = hashlib.sha1("\n".join(PARAGRAPHS).encode("utf-8")).hexdigest()

# The anchors the fake tool writes, including a couple of malformed entries the port must drop.
FAKE_ANCHORS_FILES = [
    {"id": 7, "name": "book-07.m4b", "duration": 123.5,
     # A Xing seek map must survive the server's record conversion and reach the gist.
     "seek": {"v": 1, "kind": "xing", "toc": [0, 1]},
     "anchors": [
        {"t": 30.5, "para": 1, "word": 5, "conf": 0.9},
        {"t": 10.25, "para": 2, "word": 9, "conf": 0.8},
    ]},
    {"id": 8, "name": "book-08.m4b", "duration": 60.0, "anchors": [
        {"t": 5.0, "para": 2, "word": 7, "conf": 0.7},
    ]},
    {"id": 9, "name": "book-09.m4b", "duration": None, "anchors": [
        {"t": 1.0, "para": 0, "word": 0, "conf": 0.5},
        {"t": "x", "para": 0, "word": 1},  # dropped: t is not a number
    ]},
    "not-a-dict",  # dropped: not an object
]

# The expected compact record, derived by reading `fromAnchorsJson` in src/readalong/anchors.ts:
#   * epub.hash / epub.fileId come from the request, the rest of the epub block from anchors.json
#   * file 7's anchors are sorted by time, file 9's null duration becomes 0, malformed entries drop
#   * version 2 / timing "word" adds `timing: 2`
EXPECTED_RECORD = {
    "epub": {
        "hash": EPUB_HASH,
        "fileId": EPUB_FILE_ID,
        "title": "Test Book",
        "paragraphs": len(PARAGRAPHS),
        "paragraphsSha1": PARAGRAPHS_SHA1,
    },
    "files": [
        {"id": 7, "duration": 123.5, "seek": {"v": 1, "kind": "xing", "toc": [0, 1]},
         "anchors": [[10.25, 2, 9], [30.5, 1, 5]]},
        {"id": 8, "duration": 60.0, "anchors": [[5.0, 2, 7]]},
        {"id": 9, "duration": 0, "anchors": [[1.0, 0, 0]]},
    ],
    "timing": 2,
}

FAKE_TOOL = '''#!/usr/bin/env python3
import argparse, hashlib, json, os, sys, time

FILES = json.loads(os.environ["FAKE_ANCHORS_FILES"])

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=None)
    p.add_argument("cmd", nargs="?")
    p.add_argument("--hash"); p.add_argument("--filter"); p.add_argument("--file-ids")
    p.add_argument("--paragraphs"); p.add_argument("--epub"); p.add_argument("--out")
    p.add_argument("--download", action="store_true"); p.add_argument("--audio-dir")
    p.add_argument("--keep-audio", action="store_true"); p.add_argument("--progress-json", action="store_true")
    p.add_argument("--model", default="base.en"); p.add_argument("--device", default="cpu")
    p.add_argument("--threads", type=int, default=None)
    a = p.parse_args()

    sleep = float(os.environ.get("FAKE_SLEEP", "0"))
    marker = os.environ.get("FAKE_MARKER")
    if marker:
        with open(marker, "a") as fh:
            fh.write("started\\n")
            fh.write("secrets:" + ",".join(k for k in ("API_TOKEN", "TORBOX_API_KEY", "GITHUB_GIST_TOKEN") if k in os.environ) + "\\n")

    data = json.load(open(a.paragraphs))
    paras = data["paragraphs"]
    paragraphs_sha1 = hashlib.sha1("\\n".join(paras).encode("utf-8")).hexdigest()

    # Create the audio dir + a dummy file, like a real --download run would.
    os.makedirs(a.audio_dir, exist_ok=True)
    with open(os.path.join(a.audio_dir, "book-07.m4b"), "wb") as fh:
        fh.write(b"x" * 2048)
    # The temp config must exist while the tool runs; fail loudly if the server forgot it.
    assert os.path.exists(a.config), "temp config missing"
    assert os.stat(a.config).st_mode & 0o777 == 0o600, "temp config must be 0600"

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\\n")
        sys.stdout.flush()

    if sleep:
        time.sleep(sleep)
    total = 6
    emit({"event": "start", "files": 2, "clips": total})
    for i in range(total):
        if sleep:
            time.sleep(sleep)
        if i == 0:
            emit({"event": "download", "file": 0, "bytes": 1000, "total": 6000})
        emit({"event": "clip", "done": i + 1, "total": total, "t": i * 60.0,
              "file": 0, "transcribed": True})

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    doc = {"version": 2, "timing": "word", "hash": a.hash,
           "epub": {"title": data["title"], "paragraphs": len(paras),
                    "words": sum(len(x.split()) for x in paras), "source": "paragraphs",
                    "paragraphsSha1": paragraphs_sha1},
           "files": FILES}
    with open(a.out, "w") as fh:
        json.dump(doc, fh, indent=2)
    emit({"event": "done", "out": a.out, "clips": total, "matched": 5, "kept": 5,
          "wpm_median": 170.0})
    return 0

sys.exit(main())
'''


class FakeGistState:
    """The mutable document behind the fake GitHub API (shared with the handler)."""

    def __init__(self, doc):
        self.lock = threading.Lock()
        self.doc = doc
        self.requests = []


class _FakeGistHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    @property
    def state(self):
        return self.server.state

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        with self.state.lock:
            self.state.requests.append(("GET", self.path))
            doc = json.loads(json.dumps(self.state.doc))
        if self.path.startswith("/gists?"):
            self._send(200, [{"id": "gist123", "files": {"earmark-sync.json": {"filename": "earmark-sync.json"}}}])
        elif self.path.startswith("/gists/"):
            self._send(200, {"id": "gist123", "files": {"earmark-sync.json": {
                "filename": "earmark-sync.json", "content": json.dumps(doc)}}})
        else:
            self._send(404, {"message": "not found"})

    def do_PATCH(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        with self.state.lock:
            self.state.requests.append(("PATCH", self.path))
            file = body.get("files", {}).get("earmark-sync.json", {})
            if "content" in file:
                self.state.doc = json.loads(file["content"])
        self._send(200, {"id": "gist123"})


class FakeGist:
    def __init__(self, doc=None):
        self.state = FakeGistState(doc if doc is not None else {})
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeGistHandler)
        self.httpd.state = self.state
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def get_doc(self):
        with self.state.lock:
            return json.loads(json.dumps(self.state.doc))

    def set_doc(self, doc):
        with self.state.lock:
            self.state.doc = json.loads(json.dumps(doc))

    def remove_readalong(self, key):
        with self.state.lock:
            self.state.doc.get("readalong", {}).pop(key, None)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def wait_for(predicate, timeout=10.0, interval=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return predicate()


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="readalong-test-")
        self.fake_gist = FakeGist()
        self.fake_script = os.path.join(self.tmp, "fake_readalong.py")
        with open(self.fake_script, "w", encoding="utf-8") as fh:
            fh.write(FAKE_TOOL)
        os.environ["FAKE_ANCHORS_FILES"] = json.dumps(FAKE_ANCHORS_FILES)
        os.environ["FAKE_SLEEP"] = "0"
        os.environ["FAKE_MARKER"] = os.path.join(self.tmp, "marker")
        os.environ["TORBOX_API_KEY"] = TORBOX_KEY
        os.environ["API_TOKEN"] = API_TOKEN
        os.environ["GITHUB_GIST_TOKEN"] = GIST_TOKEN

        self.config = sv.Config(
            api_token=API_TOKEN,
            torbox_api_key=TORBOX_KEY,
            github_gist_token=GIST_TOKEN,
            data_dir=self.tmp,
            model="base.en",
            cpu_threads=2,
            port=0,
            readalong_script=self.fake_script,
            github_api=self.fake_gist.base,
            gist_recheck_delays=(0.2, 0.4),
            gist_retries=2,
            gist_retry_delay=0.05,
            python=sys.executable,
        )
        self.app = sv.ReadalongServer(self.config)
        self.app.start()
        self.httpd = sv.make_server(self.app, host="127.0.0.1", port=0)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.app.stop()
        self.app.store.close()
        self.fake_gist.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers --------------------------------------------------------------------

    def request(self, method, path, body=None, token="default", headers=None, raw=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if raw is not None:
            data = raw
        if token is not None:
            hdrs["Authorization"] = f"Bearer {API_TOKEN if token == 'default' else token}"
        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def good_body(self, **overrides):
        body = {
            "audioHash": AUDIO_HASH,
            "fileIds": [7, 8],
            "epub": {"hash": EPUB_HASH, "fileId": EPUB_FILE_ID, "title": "Test Book"},
            "paragraphs": list(PARAGRAPHS),
            "paragraphsSha1": PARAGRAPHS_SHA1,
        }
        body.update(overrides)
        return body

    def post_job(self, **overrides):
        return self.request("POST", "/readalong/v1/jobs", body=self.good_body(**overrides))

    def get_job(self, job_id):
        return self.request("GET", f"/readalong/v1/jobs/{job_id}")

    # -- auth -----------------------------------------------------------------------

    def test_health_needs_no_auth(self):
        status, body = self.request("GET", "/readalong/v1/health", token=None)
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertIn("version", body)
        self.assertEqual(body["queue"], 0)

    def test_missing_token_is_401(self):
        status, body = self.request("GET", "/readalong/v1/jobs?hash=" + AUDIO_HASH, token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "unauthorized")

    def test_wrong_token_is_401(self):
        status, _ = self.request("GET", "/readalong/v1/health", token="nope")
        self.assertEqual(status, 200)  # health is public
        status, _ = self.request("POST", "/readalong/v1/jobs", body=self.good_body(), token="wrong")
        self.assertEqual(status, 401)

    def test_unknown_route_is_404(self):
        status, _ = self.request("GET", "/readalong/v1/nope")
        self.assertEqual(status, 404)
        status, _ = self.request("GET", "/nope")
        self.assertEqual(status, 404)

    # -- validation -----------------------------------------------------------------

    def test_bad_audio_hash(self):
        status, body = self.post_job(audioHash="zz")
        self.assertEqual(status, 400)
        self.assertIn("audioHash", body["error"])

    def test_bad_sha1(self):
        status, body = self.post_job(paragraphsSha1="0" * 40)
        self.assertEqual(status, 400)
        self.assertIn("paragraphsSha1", body["error"])

    def test_bad_file_ids(self):
        self.assertEqual(self.post_job(fileIds=[])[0], 400)
        self.assertEqual(self.post_job(fileIds=["7"])[0], 400)
        self.assertEqual(self.post_job(fileIds=list(range(201)))[0], 400)

    def test_bad_epub(self):
        self.assertEqual(self.post_job(epub={"hash": "x", "fileId": 1, "title": "t"})[0], 400)
        self.assertEqual(self.post_job(epub={"hash": EPUB_HASH, "fileId": "1", "title": "t"})[0], 400)
        self.assertEqual(self.post_job(epub={"hash": EPUB_HASH, "fileId": 1, "title": "t" * 301})[0], 400)

    def test_bad_paragraphs(self):
        self.assertEqual(self.post_job(paragraphs=[])[0], 400)
        self.assertEqual(self.post_job(paragraphs=[1, 2])[0], 400)

    def test_oversized_body_is_413_before_reading(self):
        # Advertise a body larger than the cap and never send it: the server must reject on the
        # headers alone.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.putrequest("POST", "/readalong/v1/jobs")
        conn.putheader("Authorization", f"Bearer {API_TOKEN}")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(sv.MAX_BODY + 1))
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)
        conn.close()

    # -- dedup / queue limit --------------------------------------------------------

    def test_dedup_returns_the_same_job(self):
        os.environ["FAKE_SLEEP"] = "30"
        status, first = self.post_job()
        self.assertEqual(status, 200)
        status, second = self.post_job()
        self.assertEqual(status, 200)
        self.assertEqual(first["id"], second["id"])
        self.app.cancel(first["id"])

    def test_queue_limit_is_10(self):
        os.environ["FAKE_SLEEP"] = "30"
        status, first = self.post_job()
        self.assertEqual(status, 200)
        wait_for(lambda: self.get_job(first["id"])[1]["status"] != "queued")
        for i in range(10):
            status, body = self.post_job(audioHash=f"{i:040x}")
            self.assertEqual(status, 200, body)
        status, body = self.post_job(audioHash="f" * 40)
        self.assertEqual(status, 429)
        self.assertIn("queued", body["error"])
        self.app.cancel(first["id"])

    # -- lifecycle ------------------------------------------------------------------

    def test_full_lifecycle_matches_from_anchors_json(self):
        status, created = self.post_job()
        self.assertEqual(status, 200)
        job_id = created["id"]
        self.assertEqual(created["position"], 1)

        view = wait_for(lambda: self.get_job(job_id)[1]["status"] == "done" and self.get_job(job_id)[1])
        self.assertEqual(view["status"], "done")
        self.assertEqual(view["total"], 6)
        self.assertEqual(view["matched"], 5)

        record = view["record"]
        self.assertIsNotNone(record)
        created_ms = record.pop("created")
        self.assertIsInstance(created_ms, int)
        self.assertLess(abs(created_ms - int(time.time() * 1000)), 60_000)
        self.assertEqual(record, EXPECTED_RECORD)

        # The record reached the gist too.
        key = AUDIO_HASH.lower()
        entry = wait_for(lambda: self.fake_gist.get_doc().get("readalong", {}).get(key))
        self.assertIsNotNone(entry)
        self.assertEqual(entry["value"], {**EXPECTED_RECORD, "created": created_ms})
        self.assertIsInstance(entry["updated"], int)

        # The chapter is cleaned up: audio dir and temp config are gone.
        job_dir = self.app.store.job_dir(job_id)
        self.assertFalse(os.path.exists(os.path.join(job_dir, "audio")))
        self.assertFalse(os.path.exists(os.path.join(job_dir, "config.json")))
        self.assertTrue(os.path.exists(os.environ["FAKE_MARKER"]),
                        "the fake tool should have created the audio dir")
        # The tool ran without the service's secrets in its environment.
        with open(os.environ["FAKE_MARKER"]) as fh:
            self.assertIn("secrets:\n", fh.read())

    def test_progress_statuses(self):
        os.environ["FAKE_SLEEP"] = "0.2"
        status, created = self.post_job()
        job_id = created["id"]
        seen = set()

        def track():
            view = self.get_job(job_id)[1]
            seen.add(view["status"])
            return view["status"] == "done"

        wait_for(track, timeout=15)
        self.assertIn("downloading", seen)
        self.assertIn("building", seen)
        self.assertEqual(self.get_job(job_id)[1]["status"], "done")

    # -- cancel ---------------------------------------------------------------------

    def test_cancel_running_job(self):
        os.environ["FAKE_SLEEP"] = "30"
        status, created = self.post_job()
        job_id = created["id"]
        wait_for(lambda: self.get_job(job_id)[1]["status"] != "queued")
        status, body = self.request("DELETE", f"/readalong/v1/jobs/{job_id}")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "cancelled")
        self.assertEqual(self.get_job(job_id)[1]["status"], "cancelled")
        self.assertIsNone(self.get_job(job_id)[1]["record"])
        # The child is terminated and the temp config / audio dir are gone.
        job_dir = self.app.store.job_dir(job_id)
        wait_for(lambda: not os.path.exists(job_dir))
        self.assertFalse(os.path.exists(os.path.join(job_dir, "audio")))
        self.assertFalse(os.path.exists(os.path.join(job_dir, "config.json")))

    def test_delete_unknown_job_is_404(self):
        status, _ = self.request("DELETE", "/readalong/v1/jobs/doesnotexist")
        self.assertEqual(status, 404)

    # -- crash recovery -------------------------------------------------------------

    def test_crash_recovery_running_to_queued(self):
        with tempfile.TemporaryDirectory() as d2:
            store = sv.Store(d2)
            store.create("jobx", {"audioHash": AUDIO_HASH, "fileIds": [7],
                                  "epub": {"hash": EPUB_HASH, "fileId": 1, "title": "t"},
                                  "paragraphs": ["p"]}, ["p"], int(time.time() * 1000))
            store.update("jobx", status="running")
            # A crash left a secret config and an audio dir on disk.
            with open(os.path.join(store.job_dir("jobx"), "config.json"), "w") as fh:
                fh.write('{"torbox_api_key": "x"}')
            os.makedirs(os.path.join(store.job_dir("jobx"), "audio"), exist_ok=True)

            self.assertEqual(store.recover(), 1)
            self.assertEqual(store.get("jobx")["status"], "queued")
            store.remove_stale_files()
            self.assertFalse(os.path.exists(os.path.join(store.job_dir("jobx"), "config.json")))
            self.assertFalse(os.path.exists(os.path.join(store.job_dir("jobx"), "audio")))
            store.close()

    # -- lookups --------------------------------------------------------------------

    def test_latest_job_for_hash(self):
        os.environ["FAKE_SLEEP"] = "30"
        status, created = self.post_job()
        job_id = created["id"]
        status, body = self.request("GET", "/readalong/v1/jobs?hash=" + AUDIO_HASH)
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], job_id)
        status, _ = self.request("GET", "/readalong/v1/jobs?hash=" + "9" * 40)
        self.assertEqual(status, 404)
        self.request("DELETE", f"/readalong/v1/jobs/{job_id}")

    # -- secrets --------------------------------------------------------------------

    def test_secrets_never_appear_in_logs(self):
        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        logger = logging.getLogger("readalong")
        old_level = logger.level
        logger.setLevel(logging.INFO)
        handler = Capture()
        logger.addHandler(handler)
        try:
            self.post_job()
            wait_for(lambda: self.app.store.latest_for_hash(AUDIO_HASH)["status"] == "done")
            self.request("GET", "/readalong/v1/jobs?hash=" + AUDIO_HASH)
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)

        text = "\n".join(records)
        self.assertTrue(records, "expected some logs to be captured")
        self.assertNotIn(TORBOX_KEY, text)
        self.assertNotIn(GIST_TOKEN, text)
        self.assertNotIn(API_TOKEN, text)
        self.assertNotIn(PARAGRAPHS[0], text)
        self.assertNotIn("paragraphsSha1", text)

    def test_requires_token_of_at_least_32_chars(self):
        with self.assertRaises(SystemExit):
            sv.Config.from_env({"API_TOKEN": "short"})


class RecordConversionTestCase(unittest.TestCase):
    """Direct tests of record_from_anchors, including a large dense anchors.json."""

    def test_dense_anchors_are_all_kept_and_timing_stays_two(self):
        # A dense build has thousands of anchors per file; none may be capped or reordered.
        anchors = [{"t": round(i * 0.19, 2), "para": i // 3, "word": i * 4, "conf": 0.9}
                   for i in range(3000)]
        anchors_json = {
            "version": 2,
            "timing": "word",
            "hash": AUDIO_HASH,
            "epub": {"title": "Dense Book", "paragraphs": 1000, "words": 12000,
                     "source": "paragraphs", "paragraphsSha1": PARAGRAPHS_SHA1},
            "files": [{"id": 7, "name": "dense.m4b", "duration": 600.0, "anchors": anchors}],
        }
        record = sv.record_from_anchors(anchors_json, EPUB_HASH, EPUB_FILE_ID, 123)
        self.assertEqual(record["timing"], 2)
        self.assertEqual(record["epub"]["title"], "Dense Book")
        self.assertEqual(len(record["files"][0]["anchors"]), 3000)
        # Triples, sorted by time, with no fields added that the app does not expect.
        self.assertEqual(record["files"][0]["anchors"][0], [0.0, 0, 0])
        self.assertEqual(record["files"][0]["anchors"][-1], [round(2999 * 0.19, 2), 999, 11996])
        self.assertEqual(set(record["files"][0]["anchors"][0]), {0})
        self.assertEqual(len(record["files"][0]["anchors"][0]), 3)


class GistTestCase(unittest.TestCase):
    """Direct tests of the gist writer against the fake GitHub API."""

    def setUp(self):
        self.fake = FakeGist()

    def tearDown(self):
        self.fake.stop()

    def client(self, delays=()):
        return GistClient(GIST_TOKEN, api_base=self.fake.base, recheck_delays=delays,
                          retries=2, retry_delay=0.05)

    def test_publish_keeps_other_and_unknown_keys(self):
        other = {"value": {"epub": {}, "files": [], "created": 1}, "updated": 5}
        doc = {
            "v": 1,
            "progress": {"abc": {"fileId": 1, "position": 2, "updated": 9}},
            "meta": {"abc": {"value": {"title": "A"}, "updated": 3}},
            "readalong": {"otherhash": other},
            "weirdFutureKey": {"nested": [1, 2, 3]},
        }
        self.fake.set_doc(doc)
        record = {"epub": {"hash": EPUB_HASH}, "files": [], "created": 7}
        updated = self.client().publish(AUDIO_HASH, record)

        got = self.fake.get_doc()
        self.assertEqual(got["v"], 1)
        self.assertEqual(got["progress"], doc["progress"])
        self.assertEqual(got["meta"], doc["meta"])
        self.assertEqual(got["weirdFutureKey"], {"nested": [1, 2, 3]})
        self.assertEqual(got["readalong"]["otherhash"], other)
        self.assertEqual(got["readalong"][AUDIO_HASH.lower()], {"value": record, "updated": updated})

    def test_publish_preserves_empty_document_shape(self):
        self.fake.set_doc({"v": 1, "progress": {}, "meta": {}, "hidden": {}, "wishlist": {},
                           "settings": {"value": None, "updated": 0}, "readalong": {}})
        record = {"epub": {"hash": EPUB_HASH}, "files": [], "created": 7, "timing": 2}
        self.client().publish(AUDIO_HASH, record)
        got = self.fake.get_doc()
        for key in ("v", "progress", "meta", "hidden", "wishlist", "settings"):
            self.assertIn(key, got)
        self.assertEqual(got["readalong"][AUDIO_HASH.lower()]["value"], record)

    def test_recheck_rewrites_missing_entry(self):
        record = {"epub": {"hash": EPUB_HASH}, "files": [], "created": 7, "timing": 2}
        client = self.client(delays=(0.15, 0.3))
        client.publish(AUDIO_HASH, record)
        key = AUDIO_HASH.lower()
        self.assertIn(key, self.fake.get_doc()["readalong"])

        # A device's stale write drops our entry; the re-check must put it back.
        self.fake.remove_readalong(key)
        wait_for(lambda: key in self.fake.get_doc().get("readalong", {}), timeout=5)
        self.assertEqual(self.fake.get_doc()["readalong"][key]["value"], record)
        client.wait_for_rechecks(2)

    def test_recheck_rewrites_older_entry(self):
        record = {"epub": {"hash": EPUB_HASH}, "files": [], "created": 7}
        client = self.client(delays=(0.15,))
        client.publish(AUDIO_HASH, record)
        key = AUDIO_HASH.lower()
        # Simulate a device writing an older record for the same key.
        doc = self.fake.get_doc()
        doc["readalong"][key]["updated"] = 1
        doc["readalong"][key]["value"] = {"stale": True}
        self.fake.set_doc(doc)

        wait_for(lambda: self.fake.get_doc()["readalong"][key]["value"] == record, timeout=5)

    def test_missing_gist_is_logged_not_raised(self):
        # A bad API base is an ordinary failure: publish_safe logs it and returns.
        client = GistClient(GIST_TOKEN, api_base="http://127.0.0.1:1", recheck_delays=(),
                            retries=1, retry_delay=0.01)
        with self.assertLogs("readalong.gist", level="ERROR"):
            client.publish_safe(AUDIO_HASH, {"epub": {}, "files": []})


if __name__ == "__main__":
    unittest.main(verbosity=2)
