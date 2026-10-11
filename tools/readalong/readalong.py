#!/usr/bin/env python3
"""readalong - locate sampled audiobook clips in an EPUB, producing time -> paragraph anchors.

Standalone proof of concept. It does not import anything from the Earmark JS app and does
not need the app to build. Subcommands:

    list          list the audio files of a TorBox torrent by info-hash (play order)
    ebook-search  search an EPUB search endpoint for a book (search only, no download)
    anchors       cut small clips from TorBox stream URLs, transcribe them, and match the
                  transcripts against an EPUB's text to emit anchors.json

Heavy dependencies (faster-whisper, beautifulsoup4) are imported lazily so that --help and the
offline unit tests work with a bare Python install.
"""

from __future__ import annotations

import argparse
import ctypes
import glob
import hashlib
import json
import os
import posixpath
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from bisect import bisect_left
from collections import Counter, defaultdict

# --------------------------------------------------------------------------------------
# Constants (the TorBox and scraper endpoints mirror src/torbox.ts and the provider file)
# --------------------------------------------------------------------------------------

TORBOX_BASE = "https://api.torbox.app/v1/api"
CONFIG_PATH = os.path.expanduser("~/.config/earmark-readalong/config.json")
DEFAULT_AUDIO_DIR = os.path.expanduser("~/.cache/earmark-readalong/audio")

# Same audio extension filter as src/torbox.ts.
AUDIO_EXT = re.compile(r"\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav|wma)$", re.IGNORECASE)

SHINGLE = 4          # words per indexed shingle
BIN_WIDTH = 4        # offset votes are binned to tolerate insertions/deletions
MIN_CONF = 0.32      # votes / clip shingles: reject below this
MIN_MARGIN = 0.45    # (winner - runner) / winner: reject below this
MIN_SHINGLES = 4
FAIL_FAST_CLIPS = 5  # abort after this many consecutive clips fail to cut

# Anchor selection (word-timed anchors; version 2 of anchors.json).
MIN_ANCHOR_RUN = 3        # aligned tokens must form a run this long before any becomes an anchor
ANCHOR_GAP_SECONDS = 6.0  # emit two anchors from one clip when candidates span at least this
CACHE_VERSION = 2         # transcript cache entries before this had no word timestamps

# The `check` command samples held-out audio far enough from every anchor to be a fair test.
CHECK_CLIP_SECONDS = 12.0
CHECK_MIN_GAP_SECONDS = 15.0

USER_AGENT = "readalong/0.1 (+https://github.com/)"


class TorBoxError(Exception):
    pass


# --------------------------------------------------------------------------------------
# Progress events (newline-delimited JSON on stdout, for the desktop app to consume)
# --------------------------------------------------------------------------------------

class Progress:
    """Emit newline-delimited JSON events on ``stream`` when enabled.

    Disabled instances are cheap no-ops, so call sites never need to branch. Each line
    is flushed immediately so a parent process reading the pipe sees events live.
    """

    def __init__(self, enabled: bool = False, stream=None):
        self.enabled = bool(enabled)
        self.stream = stream if stream is not None else sys.stdout

    def emit(self, event: str, **fields):
        if not self.enabled:
            return None
        payload = {"event": event}
        payload.update(fields)
        self.stream.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.stream.flush()
        return payload


def download_progress_callback(progress: "Progress", file_index: int, interval: float = 0.25):
    """Throttled ``download`` events: at most ~4/s, plus a final one at 100%."""
    state = {"next": 0.0}

    def _cb(got: int, total: int):
        now = time.monotonic()
        if now >= state["next"] or (total and got >= total):
            state["next"] = now + interval
            progress.emit("download", file=file_index, bytes=got, total=total)

    return _cb


# --------------------------------------------------------------------------------------
# Text normalisation and matching
# --------------------------------------------------------------------------------------

# Curly quotes, dashes and spaces are folded before tokenising so the book and the
# transcript disagree only on real word differences.
_FOLD = {
    0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'",
    0x201C: '"', 0x201D: '"', 0x201E: '"', 0x201F: '"',
    0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2013: "-", 0x2014: "-", 0x2015: "-",
    0x2026: " ", 0x00A0: " ", 0x202F: " ", 0x2009: " ",
}

# letters + digits, unicode-aware; punctuation (including apostrophes) is dropped.
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def normalize_words(text: str) -> list[str]:
    """Lowercase, fold quotes/dashes, strip punctuation, keep numbers."""
    if not text:
        return []
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(_FOLD)
    text = text.lower()
    return _WORD_RE.findall(text)


def words_join(words, n=8) -> str:
    return " ".join(words[:n])


def build_shingle_index(words: list[str], k: int = SHINGLE) -> dict[tuple, list[int]]:
    """Map every k-word shingle of ``words`` to the list of positions it starts at."""
    index: dict[tuple, list[int]] = defaultdict(list)
    for i in range(len(words) - k + 1):
        index[tuple(words[i:i + k])].append(i)
    return dict(index)


def enforce_order(items, key="word"):
    """Keep a longest strictly-increasing subsequence.

    Returns ``(kept_indices, dropped_indices)`` as lists of positions into ``items``.
    Used to drop false anchors (e.g. the wrong copy of a repeated passage).

    Items that are dicts carrying both ``t`` and ``word`` (i.e. anchors) are ordered on *both*:
    the timeline (``file_i`` then ``t``) and the word index must each increase, which is what keeps
    two anchors emitted from one clip in the right order. Anything else is ordered on ``key`` alone.
    """
    n = len(items)
    if n == 0:
        return [], []

    def field(item, name, default=0):
        if isinstance(item, dict):
            return item.get(name, default)
        return item if name == key else default

    two_d = all(isinstance(x, dict) and "t" in x and "word" in x for x in items)
    if not two_d:
        seq = [field(items[i], key) for i in range(n)]
        tails: list = []
        tails_idx: list[int] = []
        prev = [-1] * n
        for i, x in enumerate(seq):
            j = bisect_left(tails, x)
            if j == len(tails):
                tails.append(x)
                tails_idx.append(i)
            else:
                tails[j] = x
                tails_idx[j] = i
            prev[i] = tails_idx[j - 1] if j > 0 else -1
        kept: list[int] = []
        k = tails_idx[-1]
        while k != -1:
            kept.append(k)
            k = prev[k]
        kept.reverse()
        keep = set(kept)
        dropped = [i for i in range(n) if i not in keep]
        return kept, dropped

    # A timeline stamp orders anchors within a file and across files; word index must also rise.
    def stamp(item):
        return (field(item, "file_i"), item["t"])

    dp = [1] * n
    prev = [-1] * n
    for i in range(n):
        si, wi = stamp(items[i]), items[i]["word"]
        best, bj = 0, -1
        for j in range(i):
            if stamp(items[j]) < si and items[j]["word"] < wi and dp[j] > best:
                best, bj = dp[j], j
        dp[i] = best + 1
        prev[i] = bj
    longest = max(dp)
    k = max(i for i, length in enumerate(dp) if length == longest)
    kept: list[int] = []
    while k != -1:
        kept.append(k)
        k = prev[k]
    kept.reverse()
    keep = set(kept)
    dropped = [i for i in range(n) if i not in keep]
    return kept, dropped


class Matcher:
    """Shingle-vote locator: find where a clip's words sit in the book's word list."""

    def __init__(self, words, shingle_index=None, k=SHINGLE, bin_width=BIN_WIDTH,
                 min_conf=MIN_CONF, min_margin=MIN_MARGIN, min_shingles=MIN_SHINGLES,
                 word_para=None):
        self.words = words
        self.k = k
        self.bin_width = bin_width
        self.min_conf = min_conf
        self.min_margin = min_margin
        self.min_shingles = min_shingles
        self.word_para = word_para
        self.index = shingle_index if shingle_index is not None else build_shingle_index(words, k)

    def locate(self, clip_words):
        """Return {'word','conf','votes','margin','n'} or None if the clip is not found."""
        n_clip = len(clip_words)
        if n_clip < self.k:
            return None
        grams = [tuple(clip_words[i:i + self.k]) for i in range(n_clip - self.k + 1)]
        n_shingles = len(grams)
        if n_shingles < self.min_shingles:
            return None

        # offset = book position - clip position. Every correctly placed shingle votes for the
        # clip's true start offset, so the peak is that offset (indels just shift later votes a bit).
        votes: Counter[int] = Counter()
        for c, gram in enumerate(grams):
            for b in self.index.get(gram, ()):  # each shingle contributes at most one vote per offset
                votes[b - c] += 1
        if not votes:
            return None

        # Bin to cluster offsets shifted by insertions/deletions.
        bins: dict[int, int] = defaultdict(int)
        for off, v in votes.items():
            bins[round(off / self.bin_width)] += v
        ranked = sorted(bins.items(), key=lambda kv: (-kv[1], kv[0]))
        win_bin, win_votes = ranked[0]

        # Runner-up must be a *different* region (ignore neighbouring bins of the winner).
        runner = 0
        for b, v in ranked[1:]:
            if abs(b - win_bin) > 1:
                runner = v
                break

        conf = win_votes / n_shingles
        margin = (win_votes - runner) / win_votes if win_votes else 0.0
        if conf < self.min_conf or margin < self.min_margin:
            return None

        # Representative offset: the most-voted exact offset inside the winning bin (ties -> smaller).
        best_off, best_v = None, -1
        for off, v in votes.items():
            if round(off / self.bin_width) == win_bin and v > best_v:
                best_off, best_v = off, v
        if best_off is None:
            return None
        hit = {
            "word": best_off,
            "conf": round(conf, 4),
            "votes": win_votes,
            "margin": round(margin, 4),
            "n": n_shingles,
        }
        if self.word_para:
            p = best_off
            p = 0 if p < 0 else p
            p = min(p, len(self.word_para) - 1)
            hit["para"] = self.word_para[p]
        return hit


def word_tokens(words) -> list[dict]:
    """Flatten whisper word dicts into matcher tokens that carry their clip times.

    Each whisper word is normalised with the same tokeniser the book uses. One that normalises to
    several tokens gives every token that word's start/end; one that normalises to nothing is
    dropped. The token strings are exactly what ``normalize_words`` would produce for the whole
    transcript, so ``Matcher.locate`` can vote on them as before.
    """
    tokens: list[dict] = []
    for w in words or []:
        if not isinstance(w, dict):
            continue
        try:
            start = float(w.get("start", 0.0) or 0.0)
            end = float(w.get("end", 0.0) or 0.0)
        except (TypeError, ValueError):
            start = end = 0.0
        for tok in normalize_words(str(w.get("word", ""))):
            tokens.append({"token": tok, "start": start, "end": end})
    return tokens


def align_clip_tokens(book_words, clip_tokens, best_off, bin_width=BIN_WIDTH):
    """Monotonically align clip tokens to book words after a winning vote.

    A clip token ``i`` may align to a book index ``j`` holding the same token with
    ``|j - (best_off + i)| <= bin_width``. Chosen book indices strictly increase. Returns
    ``[(clip_index, book_index), ...]`` in clip order.
    """
    aligned: list[tuple[int, int]] = []
    last = best_off - 1
    n = len(book_words)
    for i, tok in enumerate(clip_tokens):
        expect = best_off + i
        lo = max(0, last + 1, expect - bin_width)
        hi = min(n - 1, expect + bin_width)
        for j in range(lo, hi + 1):
            if book_words[j] == tok["token"]:
                aligned.append((i, j))
                last = j
                break
    return aligned


def _anchor_runs(aligned, min_run=MIN_ANCHOR_RUN):
    """Aligned pairs that sit inside a run of >= ``min_run`` consecutive clip tokens."""
    candidates: list[tuple[int, int]] = []
    run: list[tuple[int, int]] = []
    for pair in aligned:
        if run and pair[0] == run[-1][0] + 1:
            run.append(pair)
        else:
            if len(run) >= min_run:
                candidates.extend(run)
            run = [pair]
    if len(run) >= min_run:
        candidates.extend(run)
    return candidates


def select_anchor_tokens(clip_tokens, aligned, clip_seconds,
                         min_run=MIN_ANCHOR_RUN, gap_seconds=ANCHOR_GAP_SECONDS):
    """Pick which aligned ``(clip_index, book_index)`` pairs become anchors for one clip.

    Candidates are the aligned tokens inside a run of at least ``min_run``. The earliest and the
    latest candidate are both used when their clip times are at least ``gap_seconds`` apart;
    otherwise the single candidate nearest the clip's middle is used.
    """
    candidates = _anchor_runs(aligned, min_run)
    if not candidates:
        return []
    earliest, latest = candidates[0], candidates[-1]
    if clip_tokens[latest[0]]["start"] - clip_tokens[earliest[0]]["start"] >= gap_seconds:
        return [earliest, latest]
    middle = clip_seconds / 2.0
    return [min(candidates, key=lambda p: abs(clip_tokens[p[0]]["start"] - middle))]


def clip_anchors(book_words, clip_tokens, best_off, clip_start, clip_seconds,
                 bin_width=BIN_WIDTH, min_run=MIN_ANCHOR_RUN, gap_seconds=ANCHOR_GAP_SECONDS):
    """Anchors for one matched clip: ``t = clip_start + the token's START time``.

    No clip-midpoint term is involved. Returns dicts ``{"t", "word", "start"}``; the caller fills
    in ``para`` from the book.
    """
    aligned = align_clip_tokens(book_words, clip_tokens, best_off, bin_width)
    return [
        {"t": clip_start + clip_tokens[i]["start"], "word": j, "start": clip_tokens[i]["start"]}
        for (i, j) in select_anchor_tokens(clip_tokens, aligned, clip_seconds, min_run, gap_seconds)
    ]


class Book:
    """Paragraphs in reading order plus the flat, normalised word stream."""

    def __init__(self, title: str, paragraphs: list[dict], source: str = "epub"):
        self.title = title
        self.source = source
        self.paragraphs = paragraphs
        self.texts = [str(p.get("text", "")) for p in paragraphs]
        self.words: list[str] = []
        self.word_para: list[int] = []
        for p in paragraphs:
            toks = normalize_words(p.get("text", ""))
            self.words.extend(toks)
            self.word_para.extend([p["index"]] * len(toks))

    def para_of_word(self, pos: int):
        if not self.word_para:
            return None
        if pos < 0:
            pos = 0
        if pos >= len(self.word_para):
            pos = len(self.word_para) - 1
        return self.word_para[pos]

    def meta(self):
        return {
            "title": self.title,
            "paragraphs": len(self.paragraphs),
            "words": len(self.words),
            "source": self.source,
            "paragraphsSha1": paragraphs_sha1(self.texts),
        }


# --------------------------------------------------------------------------------------
# EPUB parsing (zip -> container.xml -> OPF -> spine -> XHTML) with no epub library
# --------------------------------------------------------------------------------------

_BLOCK_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "div"]


def _zip_open(zf: zipfile.ZipFile, path: str) -> bytes:
    """Read a zip entry, tolerating spaces/percent-encoding/leading ./ in hrefs."""
    want = posixpath.normpath(urllib.parse.unquote(path)).lstrip("./")
    for name in zf.namelist():
        if posixpath.normpath(urllib.parse.unquote(name)).lstrip("./") == want:
            return zf.read(name)
    raise KeyError(f"EPUB is missing {path}")


def _extract_blocks(soup):
    """Yield (tag, text) for block-level nodes in document order, skipping nested duplicates."""
    for el in soup.find_all(_BLOCK_TAGS):
        # If this node contains another block, that inner block carries the text.
        if el.find(_BLOCK_TAGS):
            continue
        if el.name == "div":
            # Only treat a div as a paragraph when it has direct text.
            if not any(str(s).strip() for s in el.find_all(string=True, recursive=False)):
                continue
        text = re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()
        if text:
            yield el.name, text


def parse_epub(path: str) -> Book:
    from bs4 import BeautifulSoup

    with zipfile.ZipFile(path) as zf:
        container = BeautifulSoup(_zip_open(zf, "META-INF/container.xml"), "xml")
        rootfile = container.find("rootfile")
        if not rootfile or not rootfile.get("full-path"):
            raise ValueError("container.xml has no rootfile")
        opf_path = rootfile["full-path"]
        opf = BeautifulSoup(_zip_open(zf, opf_path), "xml")

        title = f"EPUB {os.path.basename(path)}"
        for tag in opf.find_all(re.compile(r"(^|:)title$")):
            if tag.get_text(strip=True):
                title = tag.get_text(strip=True)
                break

        base = posixpath.dirname(opf_path)
        manifest = {}
        for item in opf.find_all("item"):
            if item.get("id") and item.get("href"):
                manifest[item["id"]] = urllib.parse.unquote(item["href"])

        paragraphs: list[dict] = []
        for itemref in opf.find_all("itemref"):
            idref = itemref.get("idref")
            if not idref or idref not in manifest:
                continue
            href = manifest[idref].split("#", 1)[0]
            full = posixpath.normpath(posixpath.join(base, href)) if base else href
            try:
                data = _zip_open(zf, full)
            except KeyError:
                continue
            try:
                soup = BeautifulSoup(data, "lxml")
            except Exception:
                soup = BeautifulSoup(data, "html.parser")
            for tag, text in _extract_blocks(soup):
                paragraphs.append({
                    "index": len(paragraphs),
                    "spine": idref,
                    "tag": tag,
                    "text": text,
                })
    return Book(title, paragraphs)


def paragraphs_sha1(texts) -> str:
    """SHA-1 hex of the paragraph strings joined with ``"\\n"`` (UTF-8)."""
    joined = "\n".join("" if t is None else str(t) for t in texts)
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()


def parse_paragraphs_json(path: str) -> Book:
    """Build a Book from ``{"title": "...", "paragraphs": ["...", ...]}``.

    The app owns EPUB parsing; this lets it pass the already-extracted paragraph list
    in. Paragraph text goes through the same tokeniser as ``parse_epub``, so the ``para``
    indices in anchors.json are indices into this list.
    """
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("paragraphs file must be a JSON object")
    raw = data.get("paragraphs")
    if not isinstance(raw, list):
        raise ValueError('paragraphs file needs a "paragraphs" array')
    title = data.get("title") or f"paragraphs {os.path.basename(path)}"
    paragraphs = [{"index": i, "spine": None, "tag": "p", "text": str(t)}
                  for i, t in enumerate(raw)]
    return Book(title, paragraphs, source="paragraphs")


# --------------------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------------------

def _http_json(url, method="GET", headers=None, body=None, timeout=60):
    data = body
    if isinstance(data, (dict, list)):
        data = json.dumps(data).encode("utf-8")
    elif isinstance(data, str):
        data = data.encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    req.add_header("Accept-Encoding", "identity")
    req.add_header("User-Agent", USER_AGENT)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw)
        except Exception:
            raise TorBoxError(f"HTTP {e.code}") from None
        msg = payload.get("detail") or payload.get("error") or f"HTTP {e.code}"
        raise TorBoxError(str(msg)) from None
    except urllib.error.URLError as e:
        raise TorBoxError(f"could not reach the server: {e.reason}") from None
    return json.loads(raw)


def load_api_key(config_path: str = CONFIG_PATH) -> str:
    with open(config_path) as fh:
        cfg = json.load(fh)
    key = (cfg.get("torbox_api_key") or "").strip()
    if not key:
        raise SystemExit(f"No torbox_api_key in {config_path}")
    return key


def load_ebook_search_url(config_path: str = CONFIG_PATH) -> str:
    """The EPUB search endpoint from the config file, or "" when unset/unreadable."""
    try:
        with open(config_path) as fh:
            cfg = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return ""
    return (cfg.get("ebook_search_url") or "").strip()


def _torbox(key: str, path: str):
    payload = _http_json(TORBOX_BASE + path, headers={"Authorization": f"Bearer {key}"})
    if not payload.get("success"):
        raise TorBoxError(payload.get("detail") or payload.get("error") or "TorBox error")
    return payload.get("data")


def torbox_mylist(key: str):
    return _torbox(key, "/torrents/mylist?bypass_cache=true") or []


def torbox_requestdl(key: str, torrent_id: int, file_id: int) -> str:
    """Fresh direct URL. Mirrors getStreamUrl in src/torbox.ts (redirect=false)."""
    q = (
        f"?token={urllib.parse.quote(key, safe='')}"
        f"&torrent_id={torrent_id}&file_id={file_id}&redirect=false"
    )
    return _torbox(key, f"/torrents/requestdl{q}")


# --------------------------------------------------------------------------------------
# Torrent / file selection (mirrors src/torbox.ts)
# --------------------------------------------------------------------------------------

def is_audio(f: dict) -> bool:
    return bool(AUDIO_EXT.search(f.get("name", ""))) or str(f.get("mimetype", "")).startswith("audio/")


def _natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name or "")]


def audio_files(torrent: dict) -> list[dict]:
    """Audio files in natural play order ('Chapter 2' before 'Chapter 10')."""
    return sorted((f for f in (torrent.get("files") or []) if is_audio(f)),
                  key=lambda f: _natural_key(f.get("name", "")))


def find_torrent(torrents, info_hash: str):
    want = info_hash.strip().lower()
    for t in torrents:
        if str(t.get("hash", "")).strip().lower() == want:
            return t
    return None


def select_files(torrent: dict, text_filter: str | None):
    files = audio_files(torrent)
    if text_filter:
        needle = text_filter.lower()
        files = [f for f in files if needle in f.get("name", "").lower()]
    return files


def parse_file_ids(text) -> list[int]:
    """Parse ``--file-ids 2,5,7`` into a list of ints, deduped, input order kept."""
    if text is None:
        return []
    if isinstance(text, (list, tuple, set)):
        parts = list(text)
    else:
        parts = str(text).split(",")
    ids: list[int] = []
    seen: set[int] = set()
    for part in parts:
        part = str(part).strip()
        if not part:
            continue
        try:
            fid = int(part)
        except ValueError:
            raise SystemExit(f"--file-ids: {part!r} is not an integer") from None
        if fid not in seen:
            seen.add(fid)
            ids.append(fid)
    return ids


def filter_file_ids(files, file_ids) -> list[dict]:
    """Keep only files whose id is in ``file_ids``, preserving the incoming play order."""
    if not file_ids:
        return list(files)
    wanted = {int(i) for i in file_ids}
    return [f for f in files if f.get("id") in wanted]


def human_size(n) -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return "-"


def redact(text, key=None) -> str:
    """Never let the API key reach stdout/stderr, even via ffmpeg error text."""
    if not text:
        return ""
    text = str(text)
    if key:
        text = text.replace(key, "***")
    return re.sub(r"(?i)(token=)[^&\s]+", r"\1***", text)


# --------------------------------------------------------------------------------------
# Whole-file audio download (avoids per-clip HTTP range requests on non-seekable Ogg/Opus)
# --------------------------------------------------------------------------------------

def audio_cache_path(audio_dir: str, info_hash: str, f: dict) -> str:
    """``<dir>/<hash>-<fileid><ext>`` for a TorBox file dict."""
    ext = os.path.splitext(f.get("name", "") or "")[1]
    return os.path.join(audio_dir, f"{info_hash}-{f.get('id')}{ext}")


def audio_is_complete(path: str, expected_size) -> bool:
    """True when ``path`` exists and matches the TorBox file size exactly."""
    if not expected_size:
        return False
    try:
        return os.path.exists(path) and os.path.getsize(path) == int(expected_size)
    except (TypeError, ValueError, OSError):
        return False


def download_audio(url: str, dest: str, expected_size=None, on_progress=None,
                   timeout: int = 120) -> int:
    """Stream ``url`` to ``dest`` in 1 MB chunks, via ``dest.part`` then rename.

    ``on_progress(bytes_so_far, total)`` is called as the download advances. Raises if
    the byte count does not match the TorBox file size (when known).
    """
    import requests

    parent = os.path.dirname(dest)
    if parent:
        os.makedirs(parent, exist_ok=True)
    part = dest + ".part"
    got = 0
    try:
        with requests.get(url, stream=True, timeout=timeout,
                          headers={"Accept-Encoding": "identity"}) as res:
            res.raise_for_status()
            total = int(expected_size) if expected_size else 0
            length = res.headers.get("Content-Length")
            if length and str(length).isdigit():
                total = int(length)
            with open(part, "wb") as fh:
                for chunk in res.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    got += len(chunk)
                    if on_progress:
                        on_progress(got, total or got)
        if expected_size and got != int(expected_size):
            raise RuntimeError(f"downloaded {got} bytes, expected {expected_size}")
        os.replace(part, dest)
    except Exception:
        try:
            os.remove(part)
        except OSError:
            pass
        raise
    return got


# --------------------------------------------------------------------------------------
# Audio: ffprobe duration and ffmpeg clip extraction from a URL or a local file
# --------------------------------------------------------------------------------------

def _source_is_url(source: str) -> bool:
    return source.startswith("http://") or source.startswith("https://")


def ffprobe_duration(url: str, timeout: int = 60) -> float | None:
    cmd = ["ffprobe", "-v", "error"]
    if _source_is_url(url):
        cmd += ["-user_agent", USER_AGENT]
    cmd += ["-show_entries", "format=duration", "-of", "default=nw=1:nk=1", url]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    txt = out.stdout.strip()
    try:
        return float(txt)
    except ValueError:
        return None


def ffmpeg_clip(src: str, start: float, seconds: float, out_path: str, timeout: int = 120):
    """Cut a mono 16 kHz WAV. ``-ss`` before ``-i`` so ffmpeg seeks efficiently."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
    if _source_is_url(src):
        cmd += ["-user_agent", USER_AGENT]
    cmd += [
        "-ss", f"{start:.3f}", "-i", src, "-t", f"{seconds:.3f}",
        "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-y", out_path,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError((out.stderr or "ffmpeg failed").strip()[:300])


# --------------------------------------------------------------------------------------
# Xing seek map (media3 XingSeeker-compatible) for VBR MP3s
# --------------------------------------------------------------------------------------
# media3's Mp3Extractor builds a XingSeeker from the first frame's Xing tag and turns a time
# into a byte offset with the tag's table of contents. On a VBR file that offset is only as
# good as the coarse (1/256) TOC, so the audio a player really starts on after a seek can be
# seconds to minutes from the requested time. The app needs a true time <-> byte map to
# translate the player's reported position back to real audio time; we emit one from the exact
# frame index so the phone never has to touch the file. See the app's src/readalong/mp3seek.ts.

SEEK_MAP_VERSION = 1
# 4096 equal byte intervals. Measured on a 23 h VBR audiobook (bitrate varies on a ~2 s scale), a
# table this size interpolated linearly is at most ~0.9 s off the true frame time and adds about
# 20 KB to the synced record. 32768 intervals gets under 0.3 s but costs 165 KB per file, which is
# too much for the gist; under a second is plenty for highlighting a paragraph.
SEEK_TABLE_INTERVALS = 4096

_MPEG1_L3_BITRATES = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_MPEG_SAMPLE_RATES = {0: 44100, 1: 48000, 2: 32000}


def id3v2_size(header: bytes) -> int:
    """Length of a leading ID3v2 tag (header + syncsafe size), or 0 when there is none."""
    if len(header) >= 10 and header[:3] == b"ID3":
        b = header[6:10]
        return 10 + ((b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3])
    return 0


def parse_mp3_frame(frame: bytes) -> dict | None:
    """Parse the MPEG audio frame at the start of ``frame`` (an MPEG1 Layer III frame).

    Returns the header fields plus the Xing/Info tag when present, or ``None`` for anything that
    is not a plain MPEG1 Layer III frame. Tag fields are ``None`` when the tag is absent or the
    matching flag is unset. ``frame_size`` mirrors media3's ``MpegAudioUtil.Header``.
    """
    if len(frame) < 4 or frame[0] != 0xFF or (frame[1] & 0xE0) != 0xE0:
        return None
    version = (frame[1] >> 3) & 0x3
    layer = (frame[1] >> 1) & 0x3
    bitrate_index = (frame[2] >> 4) & 0xF
    sr_index = (frame[2] >> 2) & 0x3
    padding = (frame[2] >> 1) & 0x1
    channel_mode = (frame[3] >> 6) & 0x3
    if version != 3 or layer != 1:  # only MPEG1 Layer III, like media3's Xing handling
        return None
    bitrate = _MPEG1_L3_BITRATES[bitrate_index] * 1000
    sample_rate = _MPEG_SAMPLE_RATES.get(sr_index)
    if not bitrate or not sample_rate:
        return None
    info = {
        "bitrate": bitrate,
        "sample_rate": sample_rate,
        "frame_size": 144 * bitrate // sample_rate + padding,
        "samples_per_frame": 1152,
        "tag": None,
        "flags": 0,
        "frame_count": None,
        "data_size": None,
        "toc": None,
    }
    xing_base = 21 if channel_mode == 3 else 36  # MPEG1 mono vs stereo/joint (media3's xingBase)
    if len(frame) >= xing_base + 8:
        tag = frame[xing_base:xing_base + 4]
        if tag in (b"Xing", b"Info"):
            flags = int.from_bytes(frame[xing_base + 4:xing_base + 8], "big")
            off = xing_base + 8
            info["tag"] = tag.decode("ascii")
            info["flags"] = flags
            if flags & 1 and len(frame) >= off + 4:
                info["frame_count"] = int.from_bytes(frame[off:off + 4], "big")
                off += 4
            if flags & 2 and len(frame) >= off + 4:
                info["data_size"] = int.from_bytes(frame[off:off + 4], "big")
                off += 4
            if flags & 4 and len(frame) >= off + 100:
                info["toc"] = list(frame[off:off + 100])
    return info


def xing_duration_us(frame_count: int, sample_rate: int, samples_per_frame: int = 1152) -> int:
    """media3's ``XingFrame.computeDurationUs``: floor((frames*samplesPerFrame - 1) * 1e6 / rate)."""
    return (frame_count * samples_per_frame - 1) * 1_000_000 // sample_rate


def build_seek_table(pairs, start_byte: int, end_byte: int,
                     intervals: int = SEEK_TABLE_INTERVALS):
    """True start time (centiseconds) of the first frame at/after ``intervals``+1 uniformly
    spaced byte positions across ``[start_byte, end_byte]``, delta-encoded.

    ``pairs`` is a sequence of ``(byte_position, time_seconds)`` sorted by position. Returns
    ``(t0_cs, deltas_cs)`` where ``deltas_cs[i]`` is ``time[i+1] - time[i]``.
    """
    positions = [p for p, _ in pairs]
    times_cs = [int(round(t * 100.0)) for _, t in pairs]
    span = end_byte - start_byte
    values = []
    for i in range(intervals + 1):
        b = start_byte + (span * i) // intervals
        j = bisect_left(positions, b)
        if j >= len(times_cs):
            j = len(times_cs) - 1
        values.append(times_cs[j])
    for i in range(1, len(values)):  # keep the table non-decreasing even if the index is not
        if values[i] < values[i - 1]:
            values[i] = values[i - 1]
    return values[0], [values[i + 1] - values[i] for i in range(len(values) - 1)]


def seek_map_from_frame(frame: bytes, frame_position: int, pairs,
                        intervals: int = SEEK_TABLE_INTERVALS) -> dict | None:
    """Build the ``seek`` object for a Xing-tagged MP3, or ``None`` when the first frame is not
    an MPEG1 Layer III frame carrying a ``Xing`` tag with a TOC.

    ``frame`` is the raw bytes of the frame at ``frame_position``; ``pairs`` is the exact
    ``(byte_position, time_seconds)`` index (from ``ffprobe`` packets). Everything media3 needs to
    reproduce its ``XingSeeker.getSeekPoints`` arithmetic is included.
    """
    info = parse_mp3_frame(frame)
    if not info or info["tag"] != "Xing" or not info["toc"]:
        return None
    if not info["frame_count"] or not info["data_size"]:
        return None
    duration_us = xing_duration_us(info["frame_count"], info["sample_rate"],
                                   info["samples_per_frame"])
    xing_frame_size = info["frame_size"]
    data_start_position = frame_position + xing_frame_size
    table_end = frame_position + info["data_size"] - 1
    if not pairs or table_end <= data_start_position:
        return None
    t0_cs, deltas = build_seek_table(pairs, data_start_position, table_end, intervals)
    return {
        "v": SEEK_MAP_VERSION,
        "kind": "xing",
        "xingFramePosition": frame_position,       # media3's `dataStartPosition` ctor argument
        "xingFrameSize": xing_frame_size,
        "dataStartPosition": data_start_position,  # first audio frame (media3 getDataStartPosition)
        "dataSize": info["data_size"],
        "durationUs": duration_us,
        "toc": info["toc"],
        "tableStartByte": data_start_position,
        "tableEndByte": table_end,
        "intervals": intervals,
        "t0cs": t0_cs,
        "deltaCs": deltas,
    }


def ffprobe_packet_index(path: str, timeout: int = 1800):
    """Exact ``(byte_position, time_seconds)`` for every audio packet, in file order.

    Streams ``ffprobe -show_entries packet=pos,pts_time`` so a 23-hour file's ~3M packets never
    have to be held in memory as one string.
    """
    cmd = ["ffprobe", "-v", "error", "-select_streams", "a:0",
           "-show_entries", "packet=pos,pts_time", "-of", "csv=p=0", path]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    pairs = []
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            parts = line.split(",")
            if len(parts) < 2:
                continue
            # ffprobe picks its own column order; a timestamp always has a decimal point.
            if "." in parts[0]:
                t, p = float(parts[0]), int(parts[1])
            else:
                p, t = int(parts[0]), float(parts[1])
            pairs.append((p, t))
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        proc.wait(timeout=timeout)
    return pairs


def seek_map_for_path(path: str, intervals: int = SEEK_TABLE_INTERVALS) -> dict | None:
    """Read ``path`` and, when it is a Xing-tagged MP3, build its seek map; else ``None``.

    Raises on IO/ffprobe failure; callers that must not fail the read-along build wrap this.
    """
    with open(path, "rb") as fh:
        frame_position = id3v2_size(fh.read(10))
        fh.seek(frame_position)
        frame = fh.read(2048)
    info = parse_mp3_frame(frame)
    if not info or info["tag"] != "Xing" or not info["toc"]:
        return None
    return seek_map_from_frame(frame, frame_position, ffprobe_packet_index(path), intervals)


# --------------------------------------------------------------------------------------
# faster-whisper with CUDA-libs handling and clean CPU fallback
# --------------------------------------------------------------------------------------

_MODELS: dict = {}
_NVIDIA_DONE = False


def preload_nvidia_libs() -> list[str]:
    """ctypes-preload the pip ``nvidia-*-cu12`` libraries so ctranslate2 can see them.

    Process-wide LD_LIBRARY_PATH cannot be changed after start, so load each .so with
    RTLD_GLOBAL before ctranslate2 dlopens cudnn by soname. Multiple passes settle the
    cudnn sub-library dependency order.
    """
    global _NVIDIA_DONE
    if _NVIDIA_DONE:
        return []
    _NVIDIA_DONE = True

    import site
    bases: list[str] = []
    try:
        bases.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        bases.append(site.getusersitepackages())
    except Exception:
        pass
    bases.append(os.path.join(sys.prefix, "lib"))

    cands: set[str] = set()
    for base in bases:
        for pat in ("nvidia/*/lib/*.so*", "nvidia/*/bin/*.so*"):
            cands.update(glob.glob(os.path.join(base, pat)))

    def rank(p: str):
        low = p.lower()
        if "cublas" in low:
            return (0, low)
        if "cudnn_ops" in low:
            return (1, low)
        if "cudnn" in low:
            return (2, low)
        return (3, low)

    ordered = sorted(cands, key=rank)

    # Make the lib dirs visible to any dlopen that consults the environment.
    lib_dirs = sorted({os.path.dirname(p) for p in ordered})
    if lib_dirs:
        cur = os.environ.get("LD_LIBRARY_PATH", "")
        os.environ["LD_LIBRARY_PATH"] = ":".join(lib_dirs + ([cur] if cur else []))

    loaded: list[str] = []
    remaining = list(ordered)
    for _ in range(6):
        progressed = False
        still = []
        for p in remaining:
            try:
                ctypes.CDLL(p, mode=ctypes.RTLD_GLOBAL)
                loaded.append(p)
                progressed = True
            except OSError:
                still.append(p)
        remaining = still
        if not progressed or not remaining:
            break
    return loaded


def load_model(model_name: str, device: str = "auto", threads: int | None = None):
    """Return ``(WhisperModel, device_used, note)``; raises only if the caller forced CUDA.

    ``threads`` maps to faster-whisper's ``cpu_threads`` and limits the CPU threads used when
    running on CPU; ``None`` keeps faster-whisper's default (all cores).
    """
    key = (model_name, device, threads)
    if key in _MODELS:
        return _MODELS[key]

    from faster_whisper import WhisperModel

    extra = {} if threads is None else {"cpu_threads": int(threads)}
    error = None
    if device in ("auto", "cuda"):
        loaded = preload_nvidia_libs()
        try:
            model = WhisperModel(model_name, device="cuda", compute_type="int8_float16", **extra)
            note = f"cuda (int8_float16, {len(loaded)} nvidia libs preloaded)"
            _MODELS[key] = (model, "cuda", note)
            return _MODELS[key]
        except Exception as e:  # noqa: BLE001 - report the exact reason
            error = e
            if device == "cuda":
                raise
    model = WhisperModel(model_name, device="cpu", compute_type="int8", **extra)
    note = f"cpu (int8); cuda failed: {type(error).__name__}: {error}" if error else "cpu (int8)"
    _MODELS[key] = (model, "cpu", note)
    return _MODELS[key]


def _wav_to_float32(path: str):
    """Decode a PCM WAV to a mono float32 array at 16 kHz (stdlib wave + numpy).

    We decode here rather than handing faster-whisper a file path because some
    faster-whisper/PyAV version combinations disagree on ``av.open``'s keywords
    (e.g. faster-whisper 1.2.1 passing ``metadata_errors`` to PyAV 19). Passing an
    array skips the PyAV decode path entirely.
    """
    import wave
    import numpy as np

    with wave.open(path, "rb") as w:
        n, ch, sw, fr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    if sw == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sw == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {sw}")
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if fr != 16000:
        raise ValueError(f"expected 16 kHz, got {fr}")
    return np.ascontiguousarray(a, dtype=np.float32)


def transcribe(model, wav_path: str) -> dict:
    """Transcribe a clip into ``{"text": str, "words": [{"word","start","end"}, ...]}``.

    Word-level timestamps are required by the anchor builder: a clip's start word used to be paired
    with the clip *midpoint*, which put every anchor about 10 s late. The ``words`` are the raw
    faster-whisper words (before normalisation); ``word_tokens`` flattens them for matching.
    """
    try:
        audio = _wav_to_float32(wav_path)
    except Exception:  # noqa: BLE001 - fall back to letting faster-whisper decode it
        audio = wav_path
    segments, _info = model.transcribe(
        audio, language="en", beam_size=1, vad_filter=False,
        condition_on_previous_text=False, word_timestamps=True,
    )
    texts: list[str] = []
    words: list[dict] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            texts.append(text)
        for w in (getattr(seg, "words", None) or []):
            word = (getattr(w, "word", "") or "").strip()
            if not word:
                continue
            words.append({
                "word": word,
                "start": float(getattr(w, "start", 0.0) or 0.0),
                "end": float(getattr(w, "end", 0.0) or 0.0),
            })
    return {"text": " ".join(texts).strip(), "words": words}


# --------------------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------------------

def cache_path_for(out_path: str) -> str:
    return out_path + ".cache.json"


def load_cache(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            pass
    return {}


def save_cache(path: str, cache: dict):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(cache, fh)
    os.replace(tmp, path)


def cache_get(cache: dict, key: str):
    """Return a cached transcript with word times, or None.

    Entries written before word timestamps existed (a bare string) or without a ``words`` list are
    treated as missing, so they are re-transcribed rather than misused for word-timed anchors.
    """
    entry = cache.get(key)
    if isinstance(entry, dict) and entry.get("v") == CACHE_VERSION and isinstance(entry.get("words"), list):
        return {"text": entry.get("text", ""), "words": entry["words"]}
    return None


def cache_put(cache: dict, key: str, transcript: dict):
    cache[key] = {
        "v": CACHE_VERSION,
        "text": transcript.get("text", ""),
        "words": transcript.get("words", []),
    }


# --------------------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------------------

def cmd_list(args) -> int:
    key = load_api_key(args.config)
    torrents = torbox_mylist(key)
    torrent = find_torrent(torrents, args.hash)
    if torrent is None:
        print(f"No torrent with info-hash {args.hash} in your TorBox list.", file=sys.stderr)
        return 2
    files = select_files(torrent, args.filter)
    print(f"{torrent.get('name', '(unnamed)')}  [{torrent.get('hash', '')}]")
    if not files:
        print("  (no audio files matched)")
        return 0
    print(f"  {'idx':>3}  {'id':>10}  {'size':>10}  path")
    for i, f in enumerate(files):
        print(f"  {i:>3}  {f.get('id', ''):>10}  {human_size(f.get('size')):>10}  {f.get('name', '')}")
    return 0


def cmd_ebook_search(args) -> int:
    url = (args.search_url or load_ebook_search_url(args.config)).strip()
    if not url:
        print(
            f"No EPUB search address. Pass --search-url URL or set \"ebook_search_url\" in {args.config}.",
            file=sys.stderr,
        )
        return 2
    body = {"title": args.title, "author": args.author, "limit": args.limit, "contentType": "ebook"}
    data = _http_json(
        url, method="POST",
        headers={"Content-Type": "application/json"},
        body=body, timeout=args.timeout,
    )
    results = data.get("results") or []
    if not results:
        print(f"No ebook results (provider status: {data.get('providerStatus')}).")
        return 0

    print(f"{len(results)} ebook candidate(s) for {args.title!r} / {args.author!r}:")
    print()
    hdr = (f"{'#':>3}  {'title':<58}  {'format':<7}  {'size':>9}  {'source':<14}  "
           f"{'seeds':>5}  locator")
    print(hdr)
    print("-" * len(hdr))
    for i, r in enumerate(results):
        title = r.get("cleanTitle") or r.get("originalTitle") or r.get("title") or "(untitled)"
        fmt = r.get("format") or r.get("fileFormat") or r.get("extension") or r.get("mediaKind") or "-"
        size = r.get("sizeLabel") or human_size(r.get("sizeBytes") or r.get("size"))
        source = r.get("sourceLabel") or r.get("source") or r.get("indexer") or "-"
        seeders = r.get("seeders", r.get("seedCount", r.get("seeds")))
        if seeders is None:
            seeders = r.get("seedersDisplay") or "-"
        magnet = r.get("magnetUrl")
        info = r.get("infoHash")
        direct = r.get("url")
        if magnet:
            locator = f"magnet {str(info or '').lower() or '(no hash)'}"
        elif info:
            locator = f"infohash {str(info).lower()}"
        elif direct:
            locator = f"url {str(direct)[:64]}"
        else:
            locator = "none"
        if len(title) > 58:
            title = title[:55] + "..."
        print(f"{i:>3}  {title:<58}  {str(fmt):<7}  {str(size):>9}  {str(source):<14}  "
              f"{str(seeders):>5}  {locator}")
    return 0


def _parse_time_range(duration: float, every: float, clip: float):
    """Clip start times: every/2, every/2+every, ... (the exact anchor time within a clip comes from
    the word timestamps, not a fixed offset)."""
    t = every / 2.0
    starts = []
    while t < duration:
        starts.append(t)
        t += every
    return starts


def _probe_source(fi, f, key, torrent, log, n_files, timings) -> dict:
    """Resolve a fresh TorBox URL and its duration, logging per-file progress."""
    fid = f.get("id")
    name = f.get("name", "")
    log(f"\n[{fi + 1}/{n_files}] {name} (id {fid})")
    url = None

    def fresh_url():
        nonlocal url
        url = torbox_requestdl(key, torrent.get("id"), fid)
        return url

    try:
        fresh_url()
        t0 = time.time()
        duration = ffprobe_duration(url)
        timings["download"] += time.time() - t0
        if not duration or duration <= 0:
            raise RuntimeError("no duration in ffprobe output")
    except Exception as e:  # noqa: BLE001
        log(f"  probe failed ({redact(e, key)[:100]}); refreshing link")
        try:
            fresh_url()
            t0 = time.time()
            duration = ffprobe_duration(url)
            timings["download"] += time.time() - t0
        except Exception as e2:  # noqa: BLE001
            log(f"  could not probe duration: {redact(e2, key)[:120]}")
            return {"url": url, "duration": None}
    if not duration or duration <= 0:
        log("  unknown/empty duration, skipping file")
        return {"url": url, "duration": None}
    log(f"  duration {duration:.1f}s")
    return {"url": url, "duration": duration}


def cmd_anchors(args) -> int:
    if args.every <= 0 or args.clip <= 0:
        raise SystemExit("--every and --clip must be positive")

    # The app may point --out at a directory that does not exist yet; the cache file is
    # written next to it, so create the parent before any clip is processed.
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    progress = Progress(args.progress_json)
    out = sys.stderr if args.progress_json else sys.stdout

    def log(*parts, **kw):
        print(*parts, file=out, **kw)

    key = load_api_key(args.config)
    torrents = torbox_mylist(key)
    torrent = find_torrent(torrents, args.hash)
    if torrent is None:
        msg = f"No torrent with info-hash {args.hash}."
        log(msg)
        if args.progress_json:
            progress.emit("error", message=msg)
            return 1
        return 2
    files = select_files(torrent, args.filter)
    files = filter_file_ids(files, parse_file_ids(getattr(args, "file_ids", None)))
    if args.limit_files:
        files = files[:args.limit_files]
    if not files:
        msg = "No audio files matched the selection."
        log(msg)
        if args.progress_json:
            progress.emit("error", message=msg)
            return 1
        return 2

    if args.paragraphs:
        log(f"Parsing paragraphs: {args.paragraphs}")
        book = parse_paragraphs_json(args.paragraphs)
    else:
        log(f"Parsing EPUB: {args.epub}")
        book = parse_epub(args.epub)
    log(f"  {book.title!r}: {len(book.paragraphs)} paragraphs, {len(book.words)} words")
    matcher = Matcher(book.words, min_conf=args.min_conf, min_margin=args.min_margin,
                      word_para=book.word_para)

    cache_file = cache_path_for(args.out)
    cache = load_cache(cache_file)

    threads = getattr(args, "threads", None)
    if threads is None:
        model, device_used, note = load_model(args.model, args.device)
    else:
        model, device_used, note = load_model(args.model, args.device, threads)
    log(f"Whisper: {args.model} on {device_used} - {note}")

    info_hash = str(torrent.get("hash") or args.hash)
    timings = {"download": 0.0, "transcribe": 0.0, "match": 0.0}
    total_clips = 0

    # With --progress-json the app needs the total clip count before work starts, so probe
    # every selected file's duration up front (remote ffprobe + a fresh link; no download).
    planned = None
    if args.progress_json:
        planned = []
        for fi, f in enumerate(files):
            entry = _probe_source(fi, f, key, torrent, log, len(files), timings)
            planned.append(entry)
            if entry["duration"] and entry["duration"] > 0:
                total_clips += len(_parse_time_range(entry["duration"], args.every, args.clip))
        progress.emit("start", files=len(files), clips=total_clips)

    files_out = []
    all_anchors = []          # dicts: file_i, t, word, para, conf, transcript
    clips_cut = 0
    clips_used = 0            # clips that produced a transcript (fresh or cached)
    clips_matched = 0         # clips whose transcript located in the book (>= 1 anchor candidate)
    clips_done = 0
    consecutive_failures = 0  # reset on any transcript; fatal at FAIL_FAST_CLIPS
    downloaded: list[str] = []

    tmpdir_obj = tempfile.TemporaryDirectory(prefix="readalong-")
    tmpdir = tmpdir_obj.name
    try:
        for fi, f in enumerate(files):
            fid = f.get("id")
            name = f.get("name", "")

            if planned is not None:
                entry = planned[fi]
            else:
                entry = _probe_source(fi, f, key, torrent, log, len(files), timings)
            url = entry["url"]
            duration = entry["duration"]

            def fresh_url():
                nonlocal url
                url = torbox_requestdl(key, torrent.get("id"), fid)
                return url

            if not duration or duration <= 0:
                files_out.append({"id": fid, "name": name, "duration": duration, "anchors": []})
                continue

            src = url
            seek_map = None
            if args.download:
                dest = audio_cache_path(args.audio_dir, info_hash, f)
                if audio_is_complete(dest, f.get("size")):
                    log(f"  using cached audio ({human_size(f.get('size'))})")
                else:
                    log(f"  downloading {human_size(f.get('size'))} -> {dest}")
                    t0 = time.time()
                    try:
                        download_audio(url, dest, f.get("size"),
                                       on_progress=download_progress_callback(progress, fi))
                    except Exception as e:  # noqa: BLE001
                        log(f"  download failed ({redact(e, key)[:100]}); refreshing link")
                        try:
                            url = fresh_url()
                            download_audio(url, dest, f.get("size"),
                                           on_progress=download_progress_callback(progress, fi))
                        except Exception as e2:  # noqa: BLE001
                            log(f"  download failed: {redact(e2, key)[:160]}")
                            files_out.append({"id": fid, "name": name, "duration": duration,
                                              "anchors": []})
                            continue
                    timings["download"] += time.time() - t0
                    downloaded.append(dest)
                    log(f"  downloaded {human_size(os.path.getsize(dest))}")
                src = dest
                t0 = time.time()
                local_duration = ffprobe_duration(dest)
                timings["download"] += time.time() - t0
                if local_duration and local_duration > 0:
                    duration = local_duration
                # A Xing/VBR MP3 needs a true time<->byte map so the app can undo the player's
                # TOC-based seek error. Never fail the build if this goes wrong.
                try:
                    seek_map = seek_map_for_path(dest)
                    if seek_map:
                        log(f"  Xing seek map: {seek_map.get('intervals')} intervals, "
                            f"{human_size(seek_map.get('dataSize'))} data")
                except Exception as e:  # noqa: BLE001
                    log(f"  seek map failed ({redact(e, key)[:120]}); continuing without it")
                    seek_map = None

            def cut_and_transcribe(source):
                nonlocal clips_cut
                wav = os.path.join(tmpdir, "clip.wav")
                t0 = time.time()
                ffmpeg_clip(source, t, args.clip, wav)
                timings["download"] += time.time() - t0
                clips_cut += 1
                t0 = time.time()
                text = transcribe(model, wav)
                timings["transcribe"] += time.time() - t0
                return text

            for t in _parse_time_range(duration, args.every, args.clip):
                ckey = f"{fid}|{t:.3f}|{args.clip}"
                transcript = cache_get(cache, ckey)   # cached transcripts count as done
                if transcript is None:
                    try:
                        transcript = cut_and_transcribe(src)
                        cache_put(cache, ckey, transcript)
                        save_cache(cache_file, cache)
                    except Exception as e:  # noqa: BLE001
                        if args.download:
                            # A local file cannot be repaired by a fresh remote link.
                            log(f"    t={t:.0f}s: clip failed ({redact(e, key)[:120]})")
                        else:
                            # Links expire; refresh once and retry the same clip.
                            log(f"    t={t:.0f}s failed ({redact(e, key)[:80]}); refreshing link")
                            try:
                                src = fresh_url()
                                transcript = cut_and_transcribe(src)
                                cache_put(cache, ckey, transcript)
                                save_cache(cache_file, cache)
                            except Exception as e2:  # noqa: BLE001
                                log(f"    t={t:.0f}s: giving up ({redact(e2, key)[:120]})")

                if transcript is None:
                    consecutive_failures += 1
                    clips_done += 1
                    progress.emit("clip", done=clips_done, total=total_clips,
                                  t=round(t + args.clip / 2.0, 2), file=fi, transcribed=False)
                    if consecutive_failures >= FAIL_FAST_CLIPS:
                        raise RuntimeError(
                            f"{consecutive_failures} consecutive clips failed to cut; aborting")
                    continue

                consecutive_failures = 0
                clips_done += 1
                progress.emit("clip", done=clips_done, total=total_clips,
                              t=round(t + args.clip / 2.0, 2), file=fi, transcribed=True)
                clips_used += 1
                clip_tokens = word_tokens(transcript.get("words", ()))
                t0 = time.time()
                hit = matcher.locate([tok["token"] for tok in clip_tokens])
                timings["match"] += time.time() - t0
                if not hit:
                    continue
                clips_matched += 1
                for anchor in clip_anchors(book.words, clip_tokens, hit["word"], t, args.clip):
                    all_anchors.append({
                        "file_i": fi,
                        "t": round(anchor["t"], 2),
                        "word": anchor["word"],
                        "para": book.para_of_word(anchor["word"]),
                        "conf": hit["conf"],
                        "transcript": transcript.get("text", ""),
                    })

            file_entry = {"id": fid, "name": name, "duration": duration, "anchors": []}
            if seek_map:
                file_entry["seek"] = seek_map
            files_out.append(file_entry)

        # ----- order enforcement across the whole book -----
        all_anchors.sort(key=lambda a: (a["file_i"], a["t"]))
        kept, dropped = enforce_order(all_anchors, key="word")

        for i in kept:
            a = all_anchors[i]
            files_out[a["file_i"]]["anchors"].append(
                {"t": a["t"], "para": a["para"], "word": a["word"], "conf": a["conf"]}
            )

        # ----- write anchors.json (no book text) -----
        docs = {
            "version": 2,
            "timing": "word",
            "hash": torrent.get("hash", args.hash),
            "epub": book.meta(),
            "files": [
                {"id": fo["id"], "name": fo["name"], "duration": fo["duration"],
                 "anchors": fo["anchors"], **({"seek": fo["seek"]} if fo.get("seek") else {})}
                for fo in files_out
            ],
        }
        with open(args.out, "w") as fh:
            json.dump(docs, fh, indent=2)
        log(f"\nWrote {args.out}")

        kept_anchors = sorted((all_anchors[i] for i in kept), key=lambda a: (a["file_i"], a["t"]))
        stats = _wpm_stats(kept_anchors) if kept_anchors else None
        progress.emit("done", out=args.out, clips=total_clips, matched=clips_matched,
                      kept=len(kept_anchors),
                      wpm_median=stats["median"] if stats else None)

        _print_report(book, files, files_out, all_anchors, kept, dropped,
                      clips_cut, clips_used, clips_matched, timings, device_used, out=out)

        if args.download and not args.keep_audio:
            for path in downloaded:
                try:
                    os.remove(path)
                except OSError:
                    pass
        return 0
    finally:
        tmpdir_obj.cleanup()


def cmd_seekmap(args) -> int:
    """Write a Xing seek map for a torrent's MP3 files without transcribing anything.

    Downloads (or reuses ``--audio-dir``) each selected file and emits ``{"files": [{"id", "seek"}]}``
    so an existing record can be given a map. Files that are not Xing MP3s get no ``seek`` key.
    """
    key = load_api_key(args.config)
    torrents = torbox_mylist(key)
    torrent = find_torrent(torrents, args.hash)
    if torrent is None:
        print(f"No torrent with info-hash {args.hash}.", file=sys.stderr)
        return 2
    files = filter_file_ids(select_files(torrent, args.filter),
                            parse_file_ids(getattr(args, "file_ids", None)))
    if not files:
        print("No audio files matched the selection.", file=sys.stderr)
        return 2

    info_hash = str(torrent.get("hash") or args.hash)
    results = []
    for fi, f in enumerate(files):
        fid = f.get("id")
        print(f"[{fi + 1}/{len(files)}] {f.get('name', '')} (id {fid})", file=sys.stderr)
        entry = {"id": fid}
        try:
            dest = audio_cache_path(args.audio_dir, info_hash, f)
            if audio_is_complete(dest, f.get("size")):
                print("  using cached audio", file=sys.stderr)
            else:
                print(f"  downloading {human_size(f.get('size'))} -> {dest}", file=sys.stderr)
                url = torbox_requestdl(key, torrent.get("id"), fid)
                try:
                    download_audio(url, dest, f.get("size"))
                except Exception:  # noqa: BLE001 - links expire; refresh once
                    download_audio(torbox_requestdl(key, torrent.get("id"), fid),
                                   dest, f.get("size"))
            seek = seek_map_for_path(dest)
            if seek:
                entry["seek"] = seek
                print(f"  Xing seek map ({seek['intervals']} intervals)", file=sys.stderr)
            else:
                print("  not a Xing MP3; no seek map", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  failed: {redact(e, key)[:160]}", file=sys.stderr)
        results.append(entry)

    parent = os.path.dirname(os.path.abspath(args.out))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump({"files": results}, fh)
    print(f"Wrote {args.out}", file=sys.stderr)
    return 0


def _wpm_stats(anchors_sorted):
    wpms = []
    for a, b in zip(anchors_sorted, anchors_sorted[1:]):
        dt = b["t"] - a["t"]
        dw = b["word"] - a["word"]
        if dt > 0 and dw >= 0:
            wpms.append(dw / (dt / 60.0))
    if not wpms:
        return None
    return {
        "median": statistics.median(wpms),
        "p25": statistics.quantiles(wpms, n=4)[0] if len(wpms) > 1 else wpms[0],
        "p75": statistics.quantiles(wpms, n=4)[2] if len(wpms) > 1 else wpms[0],
    }


def median_pace_points(anchors):
    """Median words/second between consecutive anchors (0 with fewer than two useful pairs)."""
    rates = []
    for a, b in zip(anchors, anchors[1:]):
        dt = b["t"] - a["t"]
        if dt > 0:
            rates.append((b["word"] - a["word"]) / dt)
    if not rates:
        return 0.0
    return statistics.median(rates)


def predict_time_for_word(anchors, word, duration):
    """The playback time the anchors predict for ``word``.

    Faithful port of ``timeForWord`` in ``src/readalong/anchors.ts``: piecewise-linear in word index
    between the surrounding anchors, median-pace extrapolation before the first / after the last
    anchor, clamped to ``[0, duration]``. Anchors are dicts with ``t`` and ``word`` (order does not
    matter). Returns ``None`` for an empty anchor list so the caller can skip the sample.
    """
    if not anchors:
        return None
    ordered = sorted(anchors, key=lambda a: a["t"])
    first, last = ordered[0], ordered[-1]
    hi = duration if duration and duration > 0 else float("inf")

    def clamp(x: float) -> float:
        return max(0.0, min(hi, x))

    pace = median_pace_points(ordered)
    if word <= first["word"]:
        if pace <= 0:
            return clamp(first["t"])
        return clamp(first["t"] - (first["word"] - word) / pace)
    if word >= last["word"]:
        if pace <= 0:
            return clamp(last["t"])
        return clamp(last["t"] + (word - last["word"]) / pace)
    for a, b in zip(ordered, ordered[1:]):
        if a["word"] <= word <= b["word"]:
            dw = b["word"] - a["word"]
            if dw <= 0:
                return clamp(a["t"])
            return clamp(a["t"] + (b["t"] - a["t"]) * ((word - a["word"]) / dw))
    return clamp(last["t"])


def midpoint_aligned_token(clip_tokens, aligned, clip_seconds):
    """The aligned ``(clip_index, book_index)`` pair nearest the middle of the clip, or None."""
    if not aligned:
        return None
    middle = clip_seconds / 2.0
    return min(aligned, key=lambda p: abs(clip_tokens[p[0]]["start"] - middle))


def pick_sample_times(duration, anchors, count, rng,
                      clip_seconds=CHECK_CLIP_SECONDS, min_gap=CHECK_MIN_GAP_SECONDS,
                      max_attempts=None):
    """Random clip start times for one file, each at least ``min_gap`` from every anchor time.

    Returns times in ``[0, duration - clip_seconds]`` (empty when the file is too short). Uses
    rejection sampling with a bounded number of attempts, so a badly covered file returns fewer.
    """
    hi = duration - clip_seconds
    if hi <= 0:
        return []
    anchor_times = [a["t"] for a in anchors]
    out: list[float] = []
    attempts = 0
    limit = max_attempts if max_attempts is not None else max(50, count * 50)
    while len(out) < count and attempts < limit:
        attempts += 1
        t = rng.uniform(0.0, hi)
        if any(abs(t - at) < min_gap for at in anchor_times):
            continue
        out.append(t)
    return out


def _error_stats(errors):
    """Summary of signed errors (``predicted - true``): mean, median |.|, p90 |.|, max |.|."""
    vals = [e["error"] for e in errors]
    if not vals:
        return None
    absvals = sorted(abs(v) for v in vals)
    n = len(absvals)
    p90_index = max(0, (9 * n + 9) // 10 - 1)  # nearest-rank p90
    return {
        "n": n,
        "mean": statistics.fmean(vals),
        "median_abs": statistics.median(absvals),
        "p90_abs": absvals[p90_index],
        "max_abs": absvals[-1],
    }


def cmd_check(args) -> int:
    if args.samples <= 0:
        raise SystemExit("--samples must be positive")
    if args.clip <= 0:
        raise SystemExit("--clip must be positive")

    out = sys.stdout

    def log(*parts, **kw):
        print(*parts, file=out, **kw)

    with open(args.anchors, encoding="utf-8") as fh:
        anchors_doc = json.load(fh)
    if anchors_doc.get("timing") != "word":
        log("Warning: these anchors are not word-timed (version 1); their errors include the old "
            "~10 s clip-midpoint lag.")

    key = load_api_key(args.config)
    torrents = torbox_mylist(key)
    torrent = find_torrent(torrents, args.hash)
    if torrent is None:
        log(f"No torrent with info-hash {args.hash}.")
        return 2
    files = select_files(torrent, args.filter)
    files = filter_file_ids(files, parse_file_ids(getattr(args, "file_ids", None)))
    if args.limit_files:
        files = files[:args.limit_files]
    if not files:
        log("No audio files matched the selection.")
        return 2

    if args.paragraphs:
        log(f"Parsing paragraphs: {args.paragraphs}")
        book = parse_paragraphs_json(args.paragraphs)
    else:
        log(f"Parsing EPUB: {args.epub}")
        book = parse_epub(args.epub)
    log(f"  {book.title!r}: {len(book.paragraphs)} paragraphs, {len(book.words)} words")
    matcher = Matcher(book.words, min_conf=args.min_conf, min_margin=args.min_margin,
                      word_para=book.word_para)

    anchors_by_file: dict = {}
    for f in anchors_doc.get("files", []) or []:
        if not isinstance(f, dict) or not isinstance(f.get("id"), int):
            continue
        kept = []
        for a in f.get("anchors", []) or []:
            if not isinstance(a, dict):
                continue
            if not all(isinstance(a.get(k), (int, float)) for k in ("t", "word")):
                continue
            kept.append({"t": float(a["t"]), "word": int(a["word"])})
        anchors_by_file[f["id"]] = sorted(kept, key=lambda a: a["t"])

    threads = getattr(args, "threads", None)
    if threads is None:
        model, device_used, note = load_model(args.model, args.device)
    else:
        model, device_used, note = load_model(args.model, args.device, threads)
    log(f"Whisper: {args.model} on {device_used} - {note}")
    log(f"Checking up to {args.samples} held-out samples (seed {args.seed})")

    timings = {"download": 0.0, "transcribe": 0.0, "match": 0.0}
    rng = random.Random(args.seed)

    # Probe durations up front so the per-file sample budget can be proportional to length.
    planned = []
    for fi, f in enumerate(files):
        entry = _probe_source(fi, f, key, torrent, log, len(files), timings)
        planned.append(entry)
    total_duration = sum((e["duration"] or 0.0) for e in planned)

    attempted = 0
    errors: list[dict] = []
    tmpdir_obj = tempfile.TemporaryDirectory(prefix="readalong-check-")
    tmpdir = tmpdir_obj.name
    try:
        for fi, f in enumerate(files):
            entry = planned[fi]
            url, duration = entry["url"], entry["duration"]
            if not duration or duration <= 0:
                continue
            fid = f.get("id")
            name = f.get("name", "")
            file_anchors = anchors_by_file.get(fid, [])
            share = (duration / total_duration) if total_duration else 0.0
            budget = int(round(args.samples * share))
            times = pick_sample_times(duration, file_anchors, budget, rng, clip_seconds=args.clip)
            if not times:
                continue
            log(f"\n[{fi + 1}/{len(files)}] {name} (id {fid}) - {len(times)} samples")
            src = url

            def fresh_url():
                nonlocal src
                src = torbox_requestdl(key, torrent.get("id"), fid)
                return src

            def cut_and_transcribe(source, start):
                wav = os.path.join(tmpdir, "check.wav")
                t0 = time.time()
                ffmpeg_clip(source, start, args.clip, wav)
                timings["download"] += time.time() - t0
                t0 = time.time()
                text = transcribe(model, wav)
                timings["transcribe"] += time.time() - t0
                return text

            for t in times:
                attempted += 1
                try:
                    transcript = cut_and_transcribe(src, t)
                except Exception as e:  # noqa: BLE001
                    log(f"    t={t:.0f}s failed ({redact(e, key)[:80]}); refreshing link")
                    try:
                        src = fresh_url()
                        transcript = cut_and_transcribe(src, t)
                    except Exception as e2:  # noqa: BLE001
                        log(f"    t={t:.0f}s: giving up ({redact(e2, key)[:120]})")
                        continue
                clip_tokens = word_tokens(transcript.get("words", ()))
                t0 = time.time()
                hit = matcher.locate([tok["token"] for tok in clip_tokens])
                timings["match"] += time.time() - t0
                if not hit or not clip_tokens:
                    continue
                aligned = align_clip_tokens(book.words, clip_tokens, hit["word"])
                pick = midpoint_aligned_token(clip_tokens, aligned, args.clip)
                if pick is None:
                    continue
                i, j = pick
                true_time = t + clip_tokens[i]["start"]
                predicted = predict_time_for_word(file_anchors, j, duration)
                if predicted is None:
                    continue
                errors.append({
                    "file_i": fi,
                    "name": name,
                    "t": t,
                    "word": j,
                    "true": true_time,
                    "error": predicted - true_time,
                })
    finally:
        tmpdir_obj.cleanup()

    stats = _error_stats(errors)
    print("\n" + "=" * 78, file=out)
    print("READALONG CHECK", file=out)
    print("=" * 78, file=out)
    print(f"Anchors           : {args.anchors}", file=out)
    print(f"Samples aligned   : {len(errors)} / {attempted} attempted", file=out)
    if stats:
        print(f"Mean error        : {stats['mean']:+.2f} s (positive = highlight would be late)", file=out)
        print(f"Median |error|    : {stats['median_abs']:.2f} s", file=out)
        print(f"p90 |error|       : {stats['p90_abs']:.2f} s", file=out)
        print(f"Max |error|       : {stats['max_abs']:.2f} s", file=out)
        print("\nWorst samples (file, clip time, predicted - true):", file=out)
        worst = sorted(errors, key=lambda e: abs(e["error"]), reverse=True)[:5]
        for e in worst:
            print(f"  {e['name'][:44]:<44}  t={e['t']:>8.1f}s  {e['error']:+.2f}s", file=out)
    else:
        print("No samples aligned; increase --samples or check the anchors/book.", file=out)
    tot = timings["download"] + timings["transcribe"] + timings["match"]
    print(f"Time spent        : download {timings['download']:.1f}s | "
          f"transcribe {timings['transcribe']:.1f}s | match {timings['match']:.1f}s "
          f"(sum {tot:.1f}s)", file=out)
    print("=" * 78, file=out)
    return 0


def _print_report(book, files, files_out, all_anchors, kept, dropped,
                  clips_cut, clips_used, clips_matched, timings, device_used, out=sys.stdout):
    kept_anchors = sorted((all_anchors[i] for i in kept), key=lambda a: (a["file_i"], a["t"]))
    located = len(all_anchors)
    matched = len(kept_anchors)
    located_pct = min(100.0, (100.0 * clips_matched / clips_used)) if clips_used else 0.0
    print("\n" + "=" * 78, file=out)
    print("READALONG REPORT", file=out)
    print("=" * 78, file=out)
    print(f"Device            : {device_used}", file=out)
    print(f"Files processed   : {len(files)}", file=out)
    print(f"Clips transcribed : {clips_cut} cut, {clips_used} with a transcript (incl. cache)", file=out)
    print(f"Clips matched     : {clips_matched} ({located_pct:.0f}% of transcripts)", file=out)
    print(f"Anchors           : {located} located, {matched} kept after ordering "
          f"({len(dropped)} dropped)", file=out)

    print("\nPer file (paragraph range):", file=out)
    prev_last = None
    monotonic = True
    for fo in files_out:
        anchors = fo["anchors"]
        if anchors:
            first, last = anchors[0]["para"], anchors[-1]["para"]
            if prev_last is not None and first < prev_last:
                monotonic = False
            prev_last = last
            print(f"  {fo['name'][:60]:<60} paras {first:>5} .. {last:>5}  ({len(anchors)} anchors)",
                  file=out)
        else:
            print(f"  {fo['name'][:60]:<60} (no anchors)", file=out)
    print(f"Paragraphs advance monotonically across files: {'yes' if monotonic else 'NO'}", file=out)

    if kept_anchors:
        stats = _wpm_stats(kept_anchors)
        if stats:
            print(f"Words per minute  : median {stats['median']:.0f} "
                  f"(p25 {stats['p25']:.0f}, p75 {stats['p75']:.0f})", file=out)
        if len(kept_anchors) >= 2:
            gaps_s = [b["t"] - a["t"] for a, b in zip(kept_anchors, kept_anchors[1:])]
            gaps_p = [b["para"] - a["para"] for a, b in zip(kept_anchors, kept_anchors[1:])]
            print(f"Largest gap       : {max(gaps_s):.1f}s / {max(gaps_p)} paragraphs", file=out)
        else:
            print("Largest gap       : n/a (single anchor)", file=out)

    tot = timings["download"] + timings["transcribe"] + timings["match"]
    print(f"Time spent        : download {timings['download']:.1f}s | "
          f"transcribe {timings['transcribe']:.1f}s | match {timings['match']:.1f}s "
          f"(wall components, sum {tot:.1f}s)", file=out)

    print("\nSample anchors (time, conf, transcript head, matched paragraph head):", file=out)
    if kept_anchors:
        picks = kept_anchors if len(kept_anchors) <= 5 else [
            kept_anchors[round(i * (len(kept_anchors) - 1) / 4)] for i in range(5)
        ]
        for a in picks:
            para = book.paragraphs[a["para"]]
            t_words = normalize_words(a.get("transcript", ""))
            p_words = normalize_words(para.get("text", ""))
            print(f"  t={a['t']:>8.1f}s  conf={a['conf']:.2f}  "
                  f"clip='{words_join(t_words, 8)}'", file=out)
            print(f"                   -> para {a['para']} '{words_join(p_words, 8)}'", file=out)
    else:
        print("  (none)", file=out)
    print("=" * 78, file=out)


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog="readalong",
        description="Locate sampled audiobook clips in an EPUB to build a paragraph-level read-along map.",
    )
    p.add_argument("--config", default=CONFIG_PATH, help="path to config.json (default: %(default)s)")
    sub = p.add_subparsers(dest="command", required=True)

    pl = sub.add_parser("list", help="list a TorBox torrent's audio files in play order")
    pl.add_argument("--hash", required=True, help="torrent info-hash")
    pl.add_argument("--filter", default=None, help="keep files whose path contains TEXT (case-insensitive)")
    pl.set_defaults(func=cmd_list)

    pe = sub.add_parser("ebook-search", help="search an EPUB search endpoint for a book")
    pe.add_argument("--title", required=True)
    pe.add_argument("--author", required=True)
    pe.add_argument("--search-url", default=None, metavar="URL",
                    help="EPUB search endpoint (default: ebook_search_url in the config file)")
    pe.add_argument("--limit", type=int, default=25)
    pe.add_argument("--timeout", type=int, default=60)
    pe.set_defaults(func=cmd_ebook_search)

    pa = sub.add_parser("anchors", help="transcribe clips and match them to an EPUB")
    pa.add_argument("--hash", required=True, help="torrent info-hash")
    pa.add_argument("--filter", default=None, help="keep files whose path contains TEXT (case-insensitive)")
    pa.add_argument("--file-ids", default=None, metavar="IDS",
                    help="comma-separated TorBox file ids to process, in play order; "
                         "combinable with --filter (default: all selected files)")
    src = pa.add_mutually_exclusive_group(required=True)
    src.add_argument("--epub", default=None, help="path to the book's EPUB")
    src.add_argument("--paragraphs", default=None, metavar="FILE",
                     help='JSON {"title": ..., "paragraphs": ["...", ...]} instead of an EPUB')
    pa.add_argument("--out", required=True, help="anchors.json output path")
    pa.add_argument("--every", type=float, default=60.0, help="seconds between clip starts (default: 60)")
    pa.add_argument("--clip", type=float, default=20.0, help="clip length in seconds (default: 20)")
    pa.add_argument("--model", default="small.en", help="faster-whisper model (default: small.en)")
    pa.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    pa.add_argument("--threads", type=int, default=None,
                    help="CPU threads for faster-whisper when running on CPU (default: all cores)")
    pa.add_argument("--limit-files", type=int, default=None, help="only process the first N files")
    pa.add_argument("--download", action="store_true",
                    help="download each audio file once, then cut clips locally (faster for "
                         "Ogg/Opus, which has no seek index)")
    pa.add_argument("--audio-dir", default=DEFAULT_AUDIO_DIR,
                    help="where --download stores audio (default: %(default)s)")
    pa.add_argument("--keep-audio", action="store_true",
                    help="keep downloaded audio after anchors are written")
    pa.add_argument("--progress-json", action="store_true",
                    help="write newline-delimited JSON progress events on stdout; human output "
                         "goes to stderr")
    pa.add_argument("--min-conf", type=float, default=MIN_CONF, help=argparse.SUPPRESS)
    pa.add_argument("--min-margin", type=float, default=MIN_MARGIN, help=argparse.SUPPRESS)
    pa.set_defaults(func=cmd_anchors)

    ps = sub.add_parser("seekmap", help="write a Xing seek map for a torrent's MP3 files")
    ps.add_argument("--hash", required=True, help="torrent info-hash")
    ps.add_argument("--filter", default=None, help="keep files whose path contains TEXT (case-insensitive)")
    ps.add_argument("--file-ids", default=None, metavar="IDS",
                    help="comma-separated TorBox file ids to process, in play order")
    ps.add_argument("--audio-dir", default=DEFAULT_AUDIO_DIR,
                    help="where audio is downloaded/cached (default: %(default)s)")
    ps.add_argument("--out", required=True, help="seek map output path")
    ps.set_defaults(func=cmd_seekmap)

    pc = sub.add_parser("check", help="measure anchor accuracy against held-out audio")
    pc.add_argument("--hash", required=True, help="torrent info-hash")
    pc.add_argument("--filter", default=None, help="keep files whose path contains TEXT (case-insensitive)")
    pc.add_argument("--file-ids", default=None, metavar="IDS",
                    help="comma-separated TorBox file ids to process, in play order; "
                         "combinable with --filter (default: all selected files)")
    csrc = pc.add_mutually_exclusive_group(required=True)
    csrc.add_argument("--epub", default=None, help="path to the book's EPUB")
    csrc.add_argument("--paragraphs", default=None, metavar="FILE",
                      help='JSON {"title": ..., "paragraphs": ["...", ...]} instead of an EPUB')
    pc.add_argument("--anchors", required=True, metavar="FILE",
                    help="anchors.json to test (a version-2, word-timed file)")
    pc.add_argument("--samples", type=int, default=40, help="held-out clips to sample (default: 40)")
    pc.add_argument("--seed", type=int, default=1, help="random seed for the sample times (default: 1)")
    pc.add_argument("--clip", type=float, default=CHECK_CLIP_SECONDS,
                    help="held-out clip length in seconds (default: 12)")
    pc.add_argument("--model", default="small.en", help="faster-whisper model (default: small.en)")
    pc.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    pc.add_argument("--threads", type=int, default=None,
                    help="CPU threads for faster-whisper when running on CPU (default: all cores)")
    pc.add_argument("--limit-files", type=int, default=None, help="only process the first N files")
    pc.add_argument("--min-conf", type=float, default=MIN_CONF, help=argparse.SUPPRESS)
    pc.add_argument("--min-margin", type=float, default=MIN_MARGIN, help=argparse.SUPPRESS)
    pc.set_defaults(func=cmd_check)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    progress = Progress(bool(getattr(args, "progress_json", False)))
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except SystemExit as e:
        # Explicit fatal exits from command code (e.g. missing API key) become an event.
        if isinstance(e.code, str) and e.code:
            progress.emit("error", message=e.code)
            print(e.code, file=sys.stderr)
            return 1
        return e.code if isinstance(e.code, int) else 0
    except TorBoxError as e:
        progress.emit("error", message=str(e))
        print(f"TorBox error: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001 - any fatal error becomes an event + traceback
        progress.emit("error", message=f"{type(e).__name__}: {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
