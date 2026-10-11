#!/usr/bin/env python3
"""Offline unit tests for readalong's matching and EPUB parsing (no GPU, no network).

Run:  python3 -m unittest test_match -v
"""

import contextlib
import io
import json
import os
import random
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import readalong  # noqa: E402


VOCAB = [f"w{i}" for i in range(900)]


def make_paragraphs(n_paras=60, words_per_para=22, seed=7, vocab=None):
    rng = random.Random(seed)
    vocab = vocab or VOCAB
    paras = []
    for i in range(n_paras):
        words = [rng.choice(vocab) for _ in range(words_per_para)]
        paras.append({"index": i, "spine": "ch", "tag": "p", "text": " ".join(words)})
    return paras


def make_book(**kw):
    return readalong.Book("synthetic", make_paragraphs(**kw))


def clip(words, start, length):
    return list(words[start:start + length])


def timed(words):
    """Build a transcribe()-shaped result from ``[(text, start, end), ...]``."""
    return {
        "text": " ".join(w for w, _, _ in words),
        "words": [{"word": w, "start": s, "end": e} for w, s, e in words],
    }


def inject_errors(words, rng, rate=0.15):
    out = []
    for w in words:
        r = rng.random()
        if r < rate / 3:                       # substitution
            out.append(rng.choice(VOCAB[:100]))
        elif r < 2 * rate / 3:                 # deletion
            continue
        elif r < rate:                         # insertion
            out.append(w)
            out.append(rng.choice(VOCAB[:100]))
        else:
            out.append(w)
    return out


class TestMatcher(unittest.TestCase):
    def test_exact_clip_found_at_right_paragraph(self):
        book = make_book()
        matcher = readalong.Matcher(book.words, word_para=book.word_para)
        start = 300
        hit = matcher.locate(clip(book.words, start, 60))
        self.assertIsNotNone(hit, "exact clip should be located")
        self.assertLessEqual(abs(hit["word"] - start), 1)
        self.assertEqual(hit["para"], book.para_of_word(start))
        self.assertGreater(hit["conf"], 0.8)

    def test_clip_with_15pct_errors_still_found(self):
        book = make_book(seed=11)
        matcher = readalong.Matcher(book.words, word_para=book.word_para)
        start = 500
        rng = random.Random(3)
        noisy = inject_errors(clip(book.words, start, 110), rng, rate=0.15)
        hit = matcher.locate(noisy)
        self.assertIsNotNone(hit, "a 15%-noisy clip should still be located")
        self.assertLessEqual(abs(hit["word"] - start), 12)
        self.assertLessEqual(abs(hit["para"] - book.para_of_word(start)), 2)

    def test_clip_not_in_book_rejected(self):
        book = make_book()
        matcher = readalong.Matcher(book.words)
        foreign = [f"zz{i}" for i in range(80)]
        self.assertIsNone(matcher.locate(foreign))

    def test_too_short_clip_rejected(self):
        book = make_book()
        matcher = readalong.Matcher(book.words)
        self.assertIsNone(matcher.locate([book.words[0], book.words[1]]))

    def test_repeated_passage_ambiguous_clip_rejected_by_margin(self):
        # A 40-word block appears verbatim in two places. A clip taken from it alone has two
        # equally good offsets, so the margin test must refuse it rather than guess.
        paras = make_paragraphs(n_paras=10, words_per_para=20, seed=5)
        block = ["rep%d" % i for i in range(40)]
        words = []
        for p in paras:
            words.extend(p["text"].split())
        first = len(words) // 3
        words[first:first + 40] = block
        second = (2 * len(words)) // 3
        words[second:second + 40] = block
        matcher = readalong.Matcher(words)
        self.assertIsNone(matcher.locate(block))


class TestOrdering(unittest.TestCase):
    def test_lis_drops_outlier(self):
        items = [{"word": 10}, {"word": 20}, {"word": 800}, {"word": 25}, {"word": 30}]
        kept, dropped = readalong.enforce_order(items, key="word")
        self.assertEqual([items[i]["word"] for i in kept], [10, 20, 25, 30])
        self.assertEqual([items[i]["word"] for i in dropped], [800])

    def test_repeated_passage_resolved_by_monotonic_pass(self):
        # Audio order: before the passage (word 50), a false anchor on the *second* copy of a
        # repeated passage (word 600), then text that really comes between the copies (word 420).
        # The monotonic (LIS) pass must drop the false later copy.
        items = [
            {"t": 10, "word": 50},
            {"t": 20, "word": 600},   # false: matched the wrong copy of the repeated block
            {"t": 30, "word": 420},
        ]
        kept, dropped = readalong.enforce_order(items, key="word")
        words = [items[i]["word"] for i in kept]
        self.assertEqual(words, sorted(words))
        self.assertIn(1, dropped)
        self.assertNotIn(1, kept)

    def test_lis_keeps_two_anchors_from_one_clip_in_order(self):
        items = [
            {"file_i": 0, "t": 10.0, "word": 100},  # one clip emits its earliest candidate
            {"file_i": 0, "t": 16.0, "word": 200},  # ... and its latest
            {"file_i": 0, "t": 12.0, "word": 50},   # false: word points back before the first
        ]
        kept, dropped = readalong.enforce_order(items, key="word")
        self.assertEqual([(items[i]["t"], items[i]["word"]) for i in kept],
                         [(10.0, 100), (16.0, 200)])
        self.assertEqual([items[i]["word"] for i in dropped], [50])


class TestEpub(unittest.TestCase):
    def _build_epub(self, path, spine_order):
        container = (
            '<?xml version="1.0"?>'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>'
        )
        opf = (
            '<?xml version="1.0"?>'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            '<dc:title>Test Book</dc:title><dc:identifier id="id">x</dc:identifier></metadata>'
            '<manifest>'
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>'
            '</manifest><spine>'
            + "".join(f'<itemref idref="{i}"/>' for i in spine_order)
            + '</spine></package>'
        )
        ch1 = ('<html><body><h1>Chapter One</h1><p>alpha beta gamma.</p>'
               '<div>delta epsilon</div></body></html>')
        ch2 = ('<html><body><p>zeta eta theta.</p><blockquote>iota kappa</blockquote>'
               '<p></p></body></html>')
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("mimetype", "application/epub+zip")
            z.writestr("META-INF/container.xml", container)
            z.writestr("OEBPS/content.opf", opf)
            z.writestr("OEBPS/ch1.xhtml", ch1)
            z.writestr("OEBPS/ch2.xhtml", ch2)

    def test_spine_order_and_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "tiny.epub")
            self._build_epub(p, ["ch2", "ch1"])   # deliberately spine=ch2 then ch1
            book = readalong.parse_epub(p)
        texts = [par["text"] for par in book.paragraphs]
        # ch2 first because that is the spine order, then ch1.
        self.assertEqual(texts[0], "zeta eta theta.")
        self.assertIn("iota kappa", texts)
        self.assertIn("alpha beta gamma.", texts)
        self.assertIn("Chapter One", texts)
        self.assertIn("delta epsilon", texts)     # div with direct text
        self.assertNotIn("", texts)               # empty paragraphs skipped
        self.assertEqual(book.title, "Test Book")
        self.assertEqual(book.meta()["paragraphs"], len(texts))

    def test_word_paragraph_map(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "tiny.epub")
            self._build_epub(p, ["ch1", "ch2"])
            book = readalong.parse_epub(p)
        # "Chapter One" then "alpha beta gamma." are paragraph 0 and 1.
        self.assertEqual(book.para_of_word(0), 0)
        self.assertEqual(book.para_of_word(2), 1)   # "alpha"
        self.assertEqual(readalong.normalize_words("Alpha, beta-gamma. It's 1984!"),
                         ["alpha", "beta", "gamma", "it", "s", "1984"])


class TestParagraphsJson(unittest.TestCase):
    def _write(self, d, data):
        p = os.path.join(d, "paras.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        return p

    def test_load_and_match_transcript(self):
        paras = [" ".join(f"w{i}" for i in range(j, j + 20)) for j in range(0, 400, 20)]
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, {"title": "My Book", "paragraphs": paras})
            book = readalong.parse_paragraphs_json(p)
        self.assertEqual(book.title, "My Book")
        self.assertEqual(book.source, "paragraphs")
        self.assertEqual(len(book.paragraphs), len(paras))
        self.assertEqual(book.meta()["source"], "paragraphs")
        self.assertEqual(book.meta()["paragraphsSha1"],
                         readalong.paragraphs_sha1(paras))
        matcher = readalong.Matcher(book.words, word_para=book.word_para)
        start = 100
        hit = matcher.locate(book.words[start:start + 60])
        self.assertIsNotNone(hit, "a clip from the JSON paragraphs should be located")
        self.assertLessEqual(abs(hit["word"] - start), 1)
        self.assertEqual(hit["para"], book.para_of_word(start))

    def test_title_defaults_when_missing(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, {"paragraphs": ["only one paragraph here"]})
            book = readalong.parse_paragraphs_json(p)
        self.assertEqual(len(book.paragraphs), 1)
        self.assertTrue(book.title)

    def test_bad_json_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, {"paragraphs": "not a list"})
            with self.assertRaises(ValueError):
                readalong.parse_paragraphs_json(p)


class TestParagraphsSha1(unittest.TestCase):
    def test_known_list(self):
        self.assertEqual(readalong.paragraphs_sha1(["a", "b", "c"]),
                         "2074e277e1b02db9a891a7242c9a4fe7054117a5")

    def test_joined_with_newline_and_utf8(self):
        self.assertEqual(
            readalong.paragraphs_sha1(["Hello, world.", "Second paragraph."]),
            "9af21727fcca3e269c3e643ae6098e88d8d17fac",
        )
        # empty list hashes the empty string
        self.assertEqual(readalong.paragraphs_sha1([]),
                         "da39a3ee5e6b4b0d3255bfef95601890afd80709")

    def test_epub_meta_has_source_and_sha1(self):
        book = make_book()
        meta = book.meta()
        self.assertEqual(meta["source"], "epub")
        self.assertEqual(meta["paragraphsSha1"],
                         readalong.paragraphs_sha1([p["text"] for p in book.paragraphs]))


class TestFileIds(unittest.TestCase):
    def test_parse_file_ids(self):
        self.assertEqual(readalong.parse_file_ids("2,5,7"), [2, 5, 7])
        self.assertEqual(readalong.parse_file_ids(" 2 , 5 ,, 7 "), [2, 5, 7])
        self.assertEqual(readalong.parse_file_ids("5,2,5"), [5, 2])
        self.assertEqual(readalong.parse_file_ids(None), [])

    def test_parse_file_ids_rejects_non_integer(self):
        with self.assertRaises(SystemExit):
            readalong.parse_file_ids("2,abc")

    def test_filter_keeps_only_listed_ids_in_play_order(self):
        files = [{"id": 2}, {"id": 3}, {"id": 5}, {"id": 7}]
        # Listed out of order: the play order of the incoming list is preserved.
        self.assertEqual([f["id"] for f in readalong.filter_file_ids(files, [5, 2])], [2, 5])
        self.assertEqual(readalong.filter_file_ids(files, []), files)
        self.assertEqual(readalong.filter_file_ids(files, None), files)

    def test_file_ids_combines_with_filter(self):
        torrent = {"files": [
            {"id": 2, "name": "Book 1/part 1.m4b"},
            {"id": 3, "name": "Other Book/part 1.m4b"},
            {"id": 5, "name": "Book 1/part 2.mp3"},
            {"id": 7, "name": "Book 1/part 3.m4b"},
        ]}
        files = readalong.select_files(torrent, "Book 1")
        files = readalong.filter_file_ids(files, [7, 2])
        self.assertEqual([f["id"] for f in files], [2, 7])

    def test_parser_accepts_file_ids(self):
        args = readalong.build_parser().parse_args(
            ["anchors", "--hash", "h", "--paragraphs", "p.json", "--out", "a.json",
             "--file-ids", "2,5,7"])
        self.assertEqual(readalong.parse_file_ids(args.file_ids), [2, 5, 7])


class TestEbookSearch(unittest.TestCase):
    def _config(self, **values):
        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(values, fh)
        fh.close()
        self.addCleanup(os.remove, fh.name)
        return fh.name

    def test_load_ebook_search_url_reads_and_trims(self):
        path = self._config(torbox_api_key="K", ebook_search_url="  https://example.com/ebook/search  ")
        self.assertEqual(readalong.load_ebook_search_url(path), "https://example.com/ebook/search")

    def test_load_ebook_search_url_missing_or_blank(self):
        self.assertEqual(readalong.load_ebook_search_url("/nonexistent/config.json"), "")
        self.assertEqual(readalong.load_ebook_search_url(self._config(torbox_api_key="K")), "")

    def test_search_url_argument_wins_over_config(self):
        path = self._config(torbox_api_key="K", ebook_search_url="https://config.example/search")
        seen = {}

        def fake_http(url, method="GET", headers=None, body=None, timeout=60):
            seen["url"] = url
            return {"results": []}

        args = readalong.build_parser().parse_args(
            ["--config", path, "ebook-search", "--title", "T", "--author", "A",
             "--search-url", "https://arg.example/ebook/search"])
        with mock.patch.object(readalong, "_http_json", fake_http), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(readalong.cmd_ebook_search(args), 0)
        self.assertEqual(seen["url"], "https://arg.example/ebook/search")

    def test_config_fallback_and_missing_address_errors(self):
        path = self._config(torbox_api_key="K", ebook_search_url="https://example.com/ebook/search")
        seen = {}

        def fake_http(url, **kw):
            seen["url"] = url
            return {"results": []}

        args = readalong.build_parser().parse_args(
            ["--config", path, "ebook-search", "--title", "T", "--author", "A"])
        with mock.patch.object(readalong, "_http_json", fake_http), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(readalong.cmd_ebook_search(args), 0)
        self.assertEqual(seen["url"], "https://example.com/ebook/search")

        blank = self._config(torbox_api_key="K")
        args = readalong.build_parser().parse_args(
            ["--config", blank, "ebook-search", "--title", "T", "--author", "A"])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(readalong.cmd_ebook_search(args), 2)
        self.assertIn("--search-url", err.getvalue())


class TestProgressEvents(unittest.TestCase):
    def test_clip_event_shape(self):
        buf = io.StringIO()
        p = readalong.Progress(True, buf)
        p.emit("clip", done=3, total=10, t=180.0, file=1, transcribed=True)
        line = buf.getvalue()
        self.assertTrue(line.endswith("\n"), "each event must be a flushed line")
        self.assertEqual(json.loads(line),
                         {"event": "clip", "done": 3, "total": 10, "t": 180.0,
                          "file": 1, "transcribed": True})

    def test_all_event_shapes(self):
        buf = io.StringIO()
        p = readalong.Progress(True, buf)
        p.emit("start", files=2, clips=7)
        p.emit("download", file=0, bytes=1048576, total=8388608)
        p.emit("clip", done=1, total=7, t=0.5, file=0, transcribed=False)
        p.emit("done", out="anchors.json", clips=7, matched=5, kept=4, wpm_median=152.5)
        p.emit("error", message="boom")
        events = [json.loads(line) for line in buf.getvalue().splitlines()]
        self.assertEqual([e["event"] for e in events],
                         ["start", "download", "clip", "done", "error"])
        self.assertEqual(events[0], {"event": "start", "files": 2, "clips": 7})
        self.assertEqual(events[1], {"event": "download", "file": 0,
                                     "bytes": 1048576, "total": 8388608})
        self.assertEqual(events[3], {"event": "done", "out": "anchors.json", "clips": 7,
                                     "matched": 5, "kept": 4, "wpm_median": 152.5})
        self.assertEqual(events[4], {"event": "error", "message": "boom"})

    def test_disabled_emitter_is_silent(self):
        buf = io.StringIO()
        p = readalong.Progress(False, buf)
        self.assertIsNone(p.emit("start", files=1, clips=3))
        self.assertEqual(buf.getvalue(), "")


class TestAnchorsCmd(unittest.TestCase):
    """cmd_anchors wiring with TorBox, ffmpeg, ffprobe and whisper mocked out."""

    TRANSCRIPT = "alpha beta gamma delta epsilon zeta eta theta"

    def _transcript(self):
        """A transcribe()-shaped result with word times that are not the clip midpoint."""
        words = self.TRANSCRIPT.split()
        return {
            "text": self.TRANSCRIPT,
            "words": [
                {"word": w, "start": 0.3 + i * 0.6, "end": 0.3 + i * 0.6 + 0.5}
                for i, w in enumerate(words)
            ],
        }

    def _run(self, book_dir, out_path, calls, *, duration=60.0, clip_error=False,
             progress=False, download=False, via_main=False, file_ids=None, extra_files=None,
             seek_map=None):
        calls.setdefault("cut", 0)
        calls.setdefault("requestdl", 0)
        paras_path = os.path.join(book_dir, "book.json")
        with open(paras_path, "w", encoding="utf-8") as fh:
            json.dump({"title": "T", "paragraphs": [self.TRANSCRIPT]}, fh)
        files = [{"id": 2, "name": "ch.m4b", "size": 10}] + list(extra_files or [])
        torrent = {"id": 1, "hash": "h", "files": files}
        transcript = self._transcript()

        def cutter(src, start, sec, wav, timeout=120):
            calls["cut"] += 1
            if clip_error:
                raise RuntimeError("boom: cannot cut")
            with open(wav, "w") as fh:
                fh.write("x")

        def reqdl(key, tid, fid):
            calls["requestdl"] += 1
            return "http://fake/audio"

        argv = ["anchors", "--hash", "h", "--paragraphs", paras_path, "--out", out_path,
                "--every", "10", "--clip", "5"]
        if progress:
            argv.append("--progress-json")
        if download:
            argv += ["--download", "--audio-dir", os.path.join(book_dir, "audio")]
        if file_ids is not None:
            argv += ["--file-ids", file_ids]

        patches = [
            mock.patch.object(readalong, "load_api_key", lambda *a, **k: "K"),
            mock.patch.object(readalong, "torbox_mylist", lambda k: [torrent]),
            mock.patch.object(readalong, "torbox_requestdl", reqdl),
            mock.patch.object(readalong, "ffprobe_duration", lambda s, timeout=60: duration),
            mock.patch.object(readalong, "load_model",
                              lambda m, device="auto": (object(), "cpu", "s")),
            mock.patch.object(readalong, "ffmpeg_clip", cutter),
            mock.patch.object(readalong, "transcribe", lambda m, w: transcript),
        ]
        if download:
            # Pretend the whole file is already on disk so no real download happens.
            patches += [
                mock.patch.object(readalong, "audio_is_complete", lambda p, s: True),
                mock.patch.object(readalong, "download_audio", lambda *a, **k: 0),
                mock.patch.object(readalong, "seek_map_for_path",
                                  lambda path, intervals=readalong.SEEK_TABLE_INTERVALS: seek_map),
            ]

        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            if via_main:
                return readalong.main(argv)
            return readalong.cmd_anchors(readalong.build_parser().parse_args(argv))

    def test_creates_out_parent_directory(self):
        # --out into a directory that does not exist yet must not fail on the cache write.
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "brand", "new", "dir", "anchors.json")
            calls = {}
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls)
            self.assertEqual(rc, 0)
            self.assertTrue(os.path.exists(out), "anchors.json should be written")
            self.assertTrue(os.path.exists(out + ".cache.json"), "cache should be written")
            self.assertGreater(calls["cut"], 0)

    def test_anchors_json_is_word_timed_v2(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls)
            self.assertEqual(rc, 0)
            with open(out, encoding="utf-8") as fh:
                docs = json.load(fh)
            self.assertEqual(docs["version"], 2)
            self.assertEqual(docs["timing"], "word")
            anchors = docs["files"][0]["anchors"]
            self.assertEqual(len(anchors), 1)  # every clip finds the same word, so LIS keeps one
            self.assertEqual(anchors[0]["word"], 4)
            # The anchor is always clip_start + the token start (2.7 s), never clip_start + clip/2.
            clip_start = anchors[0]["t"] - 2.7
            self.assertAlmostEqual(clip_start, round(clip_start), places=2)
            self.assertEqual(int(clip_start) % 10, 5)  # starts are every/2 = 5 s apart from a multiple of 10
            # The cache holds word times so a re-run doesn't transcribe again.
            with open(out + ".cache.json", encoding="utf-8") as fh:
                cache = json.load(fh)
            entry = next(iter(cache.values()))
            self.assertEqual(entry["v"], 2)
            self.assertTrue(entry["words"])

    def test_aborts_after_five_consecutive_failed_clips(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls, duration=100.0, clip_error=True,
                               progress=True, via_main=True)
            self.assertEqual(rc, 1, "fatal clip failures should exit 1")
            events = [json.loads(line) for line in buf.getvalue().splitlines()]
            clips = [e for e in events if e["event"] == "clip"]
            self.assertEqual(len(clips), 5, "should abort after 5 failed clips, not all 10")
            self.assertTrue(all(c["transcribed"] is False for c in clips))
            self.assertEqual(events[-1]["event"], "error")
            self.assertFalse(os.path.exists(out), "no anchors.json after a fatal abort")

    def test_local_download_clip_failure_does_not_refresh_link(self):
        # With --download the clip is local, so a cut failure must not call requestdl again.
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls, duration=40.0, clip_error=True, download=True)
            self.assertEqual(rc, 0)
            self.assertEqual(calls["requestdl"], 1, "only the probe should request a link")
            self.assertGreaterEqual(calls["cut"], 1)

    def test_progress_clip_event_uses_midpoint_and_transcribed(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls, duration=60.0, progress=True)
            self.assertEqual(rc, 0)
            events = [json.loads(line) for line in buf.getvalue().splitlines()]
            clips = [e for e in events if e["event"] == "clip"]
            self.assertTrue(clips)
            # first clip starts at every/2 = 5s, so its midpoint is 5 + 5/2 = 7.5s
            self.assertEqual(clips[0]["t"], 7.5)
            self.assertTrue(all(c["transcribed"] is True for c in clips))

    def test_file_ids_limits_processed_files(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            extra = [{"id": 3, "name": "ch2.m4b", "size": 10}]
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls, extra_files=extra, file_ids="3")
            self.assertEqual(rc, 0)
            with open(out, encoding="utf-8") as fh:
                docs = json.load(fh)
            self.assertEqual([f["id"] for f in docs["files"]], [3])

    def test_file_ids_out_of_range_still_runs_if_one_matches(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            extra = [{"id": 3, "name": "ch2.m4b", "size": 10}]
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls, extra_files=extra, file_ids="2,99")
            self.assertEqual(rc, 0)
            with open(out, encoding="utf-8") as fh:
                docs = json.load(fh)
            self.assertEqual([f["id"] for f in docs["files"]], [2])

    def test_download_attaches_seek_map_to_output(self):
        # A Xing MP3's seek map must survive into anchors.json next to id/duration/anchors.
        fake = {"v": 1, "kind": "xing", "toc": [0] * 100, "deltaCs": [1]}
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls, duration=40.0, download=True, seek_map=fake)
            self.assertEqual(rc, 0)
            with open(out, encoding="utf-8") as fh:
                docs = json.load(fh)
            self.assertEqual(docs["files"][0]["seek"], fake)

    def test_file_ids_no_match_is_error(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "anchors.json")
            calls = {}
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = self._run(d, out, calls, file_ids="99")
            self.assertEqual(rc, 2)
            self.assertFalse(os.path.exists(out))


class TestWordAnchors(unittest.TestCase):
    """Word-timed anchor selection: times come from clip tokens, not the clip midpoint."""

    def test_anchor_time_is_clip_start_plus_token_start(self):
        book_words = [f"w{i}" for i in range(40)]
        times = [i * 0.8 for i in range(20)]
        toks = readalong.word_tokens([
            {"word": book_words[10 + i], "start": times[i], "end": times[i] + 0.5}
            for i in range(20)
        ])
        anchors = readalong.clip_anchors(book_words, toks, 10, clip_start=300.0, clip_seconds=20.0)
        self.assertEqual(len(anchors), 2)  # 15.2 s span > 6 s
        self.assertEqual(anchors[0]["word"], 10)
        self.assertAlmostEqual(anchors[0]["t"], 300.0)  # clip_start + first token start
        self.assertEqual(anchors[1]["word"], 29)
        self.assertAlmostEqual(anchors[1]["t"], 300.0 + times[-1])

    def test_leading_silence_does_not_shift_anchor(self):
        book_words = [f"w{i}" for i in range(40)]
        times = [3.2 + i * 0.95 for i in range(8)]  # first token after 3.2 s of silence, span > 6
        toks = readalong.word_tokens([
            {"word": book_words[10 + i], "start": times[i], "end": times[i] + 0.4}
            for i in range(8)
        ])
        anchors = readalong.clip_anchors(book_words, toks, 10, clip_start=100.0, clip_seconds=20.0)
        self.assertEqual(len(anchors), 2)
        self.assertAlmostEqual(anchors[0]["t"], 100.0 + 3.2)  # not 100 + clip/2 == 110
        self.assertEqual(anchors[0]["word"], 10)

    def test_garbled_first_third_still_anchors_from_the_aligned_run(self):
        book_words = [f"w{i}" for i in range(60)]
        garbage = [{"word": "zzq", "start": i * 0.5, "end": i * 0.5 + 0.4} for i in range(6)]
        good = [
            {"word": book_words[16 + i], "start": 3.0 + i * 0.5, "end": 3.0 + i * 0.5 + 0.4}
            for i in range(14)
        ]
        toks = readalong.word_tokens(garbage + good)
        # best_off (the clip's first book word) is 10 even though the first six tokens are garbage.
        anchors = readalong.clip_anchors(book_words, toks, 10, clip_start=0.0, clip_seconds=20.0)
        self.assertTrue(anchors)
        self.assertTrue(all(10 <= a["word"] <= 29 for a in anchors))
        self.assertTrue(all(a["t"] >= 3.0 for a in anchors))  # times come from the aligned run

    def test_two_anchors_only_when_the_run_spans_six_seconds(self):
        book_words = [f"w{i}" for i in range(40)]

        def toks(starts, base=5):
            return readalong.word_tokens([
                {"word": book_words[base + i], "start": s, "end": s + 0.4}
                for i, s in enumerate(starts)
            ])

        one = readalong.clip_anchors(book_words, toks([1.0, 2.0, 3.0, 4.0, 5.0]), 5, 0.0, 20.0)
        self.assertEqual(len(one), 1)
        self.assertEqual(one[0]["word"], 9)  # i=4 (start 5) is nearest the 10 s middle

        two = readalong.clip_anchors(book_words, toks(list(range(9))), 5, 0.0, 20.0)
        self.assertEqual([a["word"] for a in two], [5, 13])  # 8 s span >= 6 s

    def test_no_three_token_run_yields_no_anchor(self):
        book_words = [f"w{i}" for i in range(40)]
        toks = readalong.word_tokens([
            {"word": book_words[5], "start": 0.5, "end": 0.6},
            {"word": "zz", "start": 1.0, "end": 1.1},
            {"word": book_words[8], "start": 2.0, "end": 2.1},
        ])
        self.assertEqual(readalong.clip_anchors(book_words, toks, 5, 0.0, 20.0), [])

    def test_multi_token_whisper_word_shares_times_and_empty_tokens_drop(self):
        toks = readalong.word_tokens([
            {"word": "thirty-nine", "start": 2.0, "end": 2.6},
            {"word": "—", "start": 2.6, "end": 2.7},
            {"word": "men", "start": 2.7, "end": 3.0},
        ])
        self.assertEqual([t["token"] for t in toks], ["thirty", "nine", "men"])
        self.assertEqual([t["start"] for t in toks], [2.0, 2.0, 2.7])
        # The flattened tokens are exactly what the book tokeniser sees for the whole transcript.
        self.assertEqual([t["token"] for t in toks], readalong.normalize_words("thirty-nine — men"))

    def test_transcript_cache_needs_word_times(self):
        self.assertIsNone(readalong.cache_get({}, "k"))
        self.assertIsNone(readalong.cache_get({"k": "old string transcript"}, "k"))
        self.assertIsNone(readalong.cache_get({"k": {"v": 1, "text": "t", "words": []}}, "k"))
        cache = {}
        readalong.cache_put(cache, "k", timed([("hi", 0.1, 0.4)]))
        got = readalong.cache_get(cache, "k")
        self.assertIsNotNone(got)
        self.assertEqual(got["words"][0]["word"], "hi")


class TestCheckMath(unittest.TestCase):
    """The `check` command's pure prediction and sampling maths."""

    def setUp(self):
        self.anchors = [
            {"t": 0.0, "word": 0},
            {"t": 10.0, "word": 20},
            {"t": 20.0, "word": 40},
        ]

    def test_predict_time_matches_time_for_word(self):
        duration = 30.0
        for word, expected in [(0, 0.0), (10, 5.0), (20, 10.0), (30, 15.0), (40, 20.0)]:
            self.assertAlmostEqual(
                readalong.predict_time_for_word(self.anchors, word, duration), expected)

    def test_predict_time_extrapolates_at_median_pace_and_clamps(self):
        # 2 words/s; duration 30
        self.assertAlmostEqual(readalong.predict_time_for_word(self.anchors, -10, 30.0), 0.0)
        self.assertAlmostEqual(readalong.predict_time_for_word(self.anchors, 60, 30.0), 30.0)
        self.assertAlmostEqual(readalong.predict_time_for_word(self.anchors, 80, 30.0), 30.0)
        # No duration -> only the 0 lower bound applies.
        self.assertAlmostEqual(readalong.predict_time_for_word(self.anchors, 80, 0.0), 40.0)

    def test_predict_time_holds_a_single_anchor(self):
        single = [{"t": 10.0, "word": 25}]
        self.assertAlmostEqual(readalong.predict_time_for_word(single, 0, 30.0), 10.0)
        self.assertAlmostEqual(readalong.predict_time_for_word(single, 100, 30.0), 10.0)
        self.assertIsNone(readalong.predict_time_for_word([], 0, 30.0))

    def test_pick_sample_times_respects_the_minimum_gap(self):
        rng = random.Random(1)
        times = readalong.pick_sample_times(100.0, [{"t": 50.0}], 5, rng)
        self.assertEqual(len(times), 5)
        self.assertTrue(all(0.0 <= t <= 88.0 for t in times))
        self.assertTrue(all(abs(t - 50.0) >= 15.0 for t in times))
        # Deterministic for a given seed.
        self.assertEqual(times, readalong.pick_sample_times(100.0, [{"t": 50.0}], 5, random.Random(1)))
        # Too short for a clip of this length: nothing to sample.
        self.assertEqual(readalong.pick_sample_times(5.0, [], 3, rng), [])

    def test_error_stats(self):
        errors = [{"error": e} for e in [1.0, -2.0, 3.0, -4.0, 0.0]]
        stats = readalong._error_stats(errors)
        self.assertEqual(stats["n"], 5)
        self.assertAlmostEqual(stats["mean"], -0.4)
        self.assertAlmostEqual(stats["median_abs"], 2.0)
        self.assertAlmostEqual(stats["p90_abs"], 4.0)
        self.assertAlmostEqual(stats["max_abs"], 4.0)
        self.assertIsNone(readalong._error_stats([]))

    def test_midpoint_aligned_token(self):
        toks = [{"token": "a", "start": 1.0, "end": 1.2},
                {"token": "b", "start": 5.0, "end": 5.2},
                {"token": "c", "start": 9.0, "end": 9.2}]
        self.assertEqual(readalong.midpoint_aligned_token(toks, [(0, 10), (1, 11), (2, 12)], 12.0), (1, 11))
        self.assertIsNone(readalong.midpoint_aligned_token(toks, [], 12.0))


class TestCheckCmd(unittest.TestCase):
    """cmd_check wiring with TorBox, ffmpeg, ffprobe and whisper mocked out."""

    def test_check_reports_error_stats_for_aligned_samples(self):
        book_words = [f"w{i}" for i in range(2500)]
        paragraphs = [" ".join(book_words[i:i + 50]) for i in range(0, 2500, 50)]
        anchors_doc = {
            "version": 2,
            "timing": "word",
            "hash": "h",
            "epub": {"title": "T", "paragraphs": len(paragraphs), "words": 2500,
                     "source": "paragraphs", "paragraphsSha1": "x"},
            "files": [{"id": 2, "name": "ch.m4b", "duration": 200.0, "anchors": [
                {"t": 0.0, "para": 0, "word": 0, "conf": 0.9},
                {"t": 100.0, "para": 20, "word": 1000, "conf": 0.9},
                {"t": 200.0, "para": 40, "word": 2000, "conf": 0.9},
            ]}],
        }
        # A contiguous slice of the book, with word times inside the 12 s clip.
        slice_words = book_words[100:140]
        transcript = {
            "text": " ".join(slice_words),
            "words": [{"word": w, "start": i * 0.3, "end": i * 0.3 + 0.25}
                      for i, w in enumerate(slice_words)],
        }
        torrent = {"id": 1, "hash": "h", "files": [{"id": 2, "name": "ch.m4b", "size": 10}]}

        with tempfile.TemporaryDirectory() as d:
            paras_path = os.path.join(d, "book.json")
            with open(paras_path, "w", encoding="utf-8") as fh:
                json.dump({"title": "T", "paragraphs": paragraphs}, fh)
            anchors_path = os.path.join(d, "anchors.json")
            with open(anchors_path, "w", encoding="utf-8") as fh:
                json.dump(anchors_doc, fh)

            def cutter(src, start, sec, wav, timeout=120):
                with open(wav, "w") as fh:
                    fh.write("x")

            patches = [
                mock.patch.object(readalong, "load_api_key", lambda *a, **k: "K"),
                mock.patch.object(readalong, "torbox_mylist", lambda k: [torrent]),
                mock.patch.object(readalong, "torbox_requestdl", lambda k, t, f: "http://fake/audio"),
                mock.patch.object(readalong, "ffprobe_duration", lambda s, timeout=60: 200.0),
                mock.patch.object(readalong, "load_model",
                                  lambda m, device="auto": (object(), "cpu", "s")),
                mock.patch.object(readalong, "ffmpeg_clip", cutter),
                mock.patch.object(readalong, "transcribe", lambda m, w: transcript),
            ]
            argv = ["check", "--hash", "h", "--paragraphs", paras_path,
                    "--anchors", anchors_path, "--samples", "5", "--clip", "12"]
            buf = io.StringIO()
            with contextlib.ExitStack() as stack:
                for pt in patches:
                    stack.enter_context(pt)
                with contextlib.redirect_stdout(buf):
                    rc = readalong.cmd_check(readalong.build_parser().parse_args(argv))
            self.assertEqual(rc, 0)
            text = buf.getvalue()
            self.assertIn("READALONG CHECK", text)
            self.assertRegex(text, r"Samples aligned\s+: [1-5] / [1-5] attempted")
            self.assertIn("Mean error", text)


def make_xing_frame(toc, frame_count, data_size, flags=0xF, bitrate=128000,
                    sample_rate=44100, padding=0, channel_mode=1):
    """Build an MPEG1 Layer III frame carrying a Xing tag (frames/bytes/TOC/quality flags)."""
    bitrate_index = readalong._MPEG1_L3_BITRATES.index(bitrate // 1000)
    sr_index = {44100: 0, 48000: 1, 32000: 2}[sample_rate]
    frame_size = 144 * bitrate // sample_rate + padding
    frame = bytearray(frame_size)
    frame[0] = 0xFF
    frame[1] = 0xFB  # MPEG1, Layer III, no CRC
    frame[2] = (bitrate_index << 4) | (sr_index << 2) | (padding << 1)
    frame[3] = channel_mode << 6
    xing_base = 21 if channel_mode == 3 else 36
    frame[xing_base:xing_base + 4] = b"Xing"
    frame[xing_base + 4:xing_base + 8] = flags.to_bytes(4, "big")
    off = xing_base + 8
    if flags & 1:
        frame[off:off + 4] = frame_count.to_bytes(4, "big")
        off += 4
    if flags & 2:
        frame[off:off + 4] = data_size.to_bytes(4, "big")
        off += 4
    if flags & 4:
        frame[off:off + 100] = bytes(toc)
    return bytes(frame)


class TestMp3Seek(unittest.TestCase):
    """The pure Xing seek-map helpers (no audio, no ffprobe)."""

    def test_id3v2_size(self):
        # A syncsafe size of 2171080 == the real Dune tag; total length includes the 10-byte header.
        header = b"ID3\x03\x00\x00" + bytes([1, 4, 65, 72])
        self.assertEqual(readalong.id3v2_size(header), 2171090)
        self.assertEqual(readalong.id3v2_size(b"\xff\xfb\x90\x64"), 0)  # no ID3

    def test_parse_mp3_frame_reads_xing_fields(self):
        toc = list(range(100))
        frame = make_xing_frame(toc, frame_count=3154913, data_size=1128507515)
        info = readalong.parse_mp3_frame(frame)
        self.assertEqual(info["tag"], "Xing")
        self.assertEqual(info["frame_size"], 417)
        self.assertEqual(info["sample_rate"], 44100)
        self.assertEqual(info["samples_per_frame"], 1152)
        self.assertEqual(info["frame_count"], 3154913)
        self.assertEqual(info["data_size"], 1128507515)
        self.assertEqual(info["toc"], toc)

    def test_parse_mp3_frame_distinguishes_info_and_garbage(self):
        toc = list(range(100))
        frame = bytearray(make_xing_frame(toc, 1, 100))
        frame[36:40] = b"Info"
        self.assertEqual(readalong.parse_mp3_frame(bytes(frame))["tag"], "Info")
        self.assertIsNone(readalong.parse_mp3_frame(b"\x00\x01\x02\x03"))
        self.assertIsNone(readalong.parse_mp3_frame(b"\xff\xfb\x90"))

    def test_xing_duration_matches_media3(self):
        # XingFrame.computeDurationUs(): (frames*1152 - 1) * 1e6 / 44100, floored.
        self.assertEqual(readalong.xing_duration_us(3154913, 44100), 82414053854)

    def test_build_seek_table_uniform(self):
        pairs = [(100, 0.0), (200, 1.0), (300, 2.0), (400, 3.0), (500, 4.0)]
        self.assertEqual(readalong.build_seek_table(pairs, 100, 500, intervals=4),
                         (0, [100, 100, 100, 100]))

    def test_build_seek_table_takes_first_frame_at_or_after(self):
        pairs = [(100, 0.0), (350, 1.0), (500, 2.0)]
        # points 100,200,300,400,500 land on frames at 0,1,1,2,2 s
        self.assertEqual(readalong.build_seek_table(pairs, 100, 500, intervals=4),
                         (0, [100, 0, 100, 0]))

    def test_seek_map_from_frame_shape(self):
        toc = list(range(100))
        frame = make_xing_frame(toc, frame_count=1000, data_size=100000)
        pairs = [(517 + i * 10000, float(i)) for i in range(11)]
        m = readalong.seek_map_from_frame(frame, 100, pairs, intervals=4)
        self.assertEqual(m["v"], 1)
        self.assertEqual(m["kind"], "xing")
        self.assertEqual(m["xingFramePosition"], 100)
        self.assertEqual(m["xingFrameSize"], 417)
        self.assertEqual(m["dataStartPosition"], 517)
        self.assertEqual(m["dataSize"], 100000)
        self.assertEqual(m["durationUs"], readalong.xing_duration_us(1000, 44100))
        self.assertEqual(m["tableStartByte"], 517)
        self.assertEqual(m["tableEndByte"], 100 + 100000 - 1)
        self.assertEqual(m["intervals"], 4)
        self.assertEqual(len(m["deltaCs"]), 4)
        self.assertTrue(all(d >= 0 for d in m["deltaCs"]))
        self.assertEqual(len(m["toc"]), 100)

    def test_seek_map_from_frame_requires_xing_with_toc(self):
        toc = list(range(100))
        pairs = [(517 + i * 10000, float(i)) for i in range(11)]
        info = bytearray(make_xing_frame(toc, 1000, 100000))
        info[36:40] = b"Info"
        self.assertIsNone(readalong.seek_map_from_frame(bytes(info), 100, pairs, intervals=4))
        no_toc = make_xing_frame(toc, 1000, 100000, flags=0x3)  # frames + bytes only
        self.assertIsNone(readalong.seek_map_from_frame(no_toc, 100, pairs, intervals=4))
        self.assertIsNone(readalong.seek_map_from_frame(b"\x00" * 500, 0, pairs, intervals=4))


class TestSeekmapCmd(unittest.TestCase):
    """cmd_seekmap wiring: downloads/reuses audio and writes only {files: [{id, seek}]}."""

    def test_writes_seek_only_for_xing_files(self):
        fake = {"v": 1, "kind": "xing", "toc": [0] * 100, "intervals": 1, "deltaCs": [1]}
        torrent = {"id": 1, "hash": "h", "files": [
            {"id": 2, "name": "book.mp3", "size": 10},
            {"id": 3, "name": "other.mp3", "size": 20},
        ]}
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "seek.json")
            argv = ["seekmap", "--hash", "h", "--out", out]

            def fake_seek(path, intervals=readalong.SEEK_TABLE_INTERVALS):
                return fake if "-2." in path else None

            patches = [
                mock.patch.object(readalong, "load_api_key", lambda *a, **k: "K"),
                mock.patch.object(readalong, "torbox_mylist", lambda k: [torrent]),
                mock.patch.object(readalong, "audio_is_complete", lambda p, s: True),
                mock.patch.object(readalong, "seek_map_for_path", fake_seek),
            ]
            with contextlib.ExitStack() as stack:
                for p in patches:
                    stack.enter_context(p)
                with contextlib.redirect_stderr(io.StringIO()):
                    rc = readalong.cmd_seekmap(readalong.build_parser().parse_args(argv))
            self.assertEqual(rc, 0)
            with open(out, encoding="utf-8") as fh:
                docs = json.load(fh)
            self.assertEqual(docs, {"files": [{"id": 2, "seek": fake}, {"id": 3}]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
