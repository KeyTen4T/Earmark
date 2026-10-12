# readalong (proof of concept)

Locate short sampled clips of an audiobook in the book's EPUB text, producing
`time -> paragraph` anchors for a paragraph-level "read along" view.

Standalone Python 3.12 — unrelated to the app's JS build. It reads the TorBox API
and an EPUB search endpoint whose address you set (mirroring `src/torbox.ts` and the
app's `src/readalong/ebookSearch.ts`), and either parses the EPUB itself or takes a
paragraph list from the app's parser.

## Install

The scripts only need the standard library to run `--help` and the tests. The
`anchors` command additionally needs:

```sh
python3.12 -m venv ~/.local/share/earmark-readalong/venv
~/.local/share/earmark-readalong/venv/bin/pip install \
  faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 \
  rapidfuzz beautifulsoup4 lxml requests
```

`ffmpeg` / `ffprobe` must be on `PATH`. A config file at
`~/.config/earmark-readalong/config.json` holds the TorBox key and the EPUB search
address:

```json
{ "torbox_api_key": "...", "ebook_search_url": "https://example.com/ebook/search" }
```

`ebook_search_url` is only needed for `ebook-search`; it can also be passed per-run
with `--search-url`.

## Usage

```sh
readalong.py list --hash <infohash> [--filter TEXT]
readalong.py ebook-search --title T --author A [--search-url URL] [--limit N] [--timeout S]
readalong.py anchors --hash <infohash> [--filter TEXT] [--file-ids IDS] (--epub PATH | --paragraphs FILE) \
    --out anchors.json [--mode dense|sampled] [--every 60] [--clip 20] [--model small.en] [--device auto] \
    [--limit-files N] [--download] [--audio-dir DIR] [--keep-audio] [--progress-json]
readalong.py check --hash <infohash> [--filter TEXT] [--file-ids IDS] (--epub PATH | --paragraphs FILE) \
    --anchors anchors.json [--mode auto|dense|sampled] [--samples 40] [--seed 1] [--clip 12] \
    [--model small.en] [--device auto] [--limit-files N]
```

- **list** — finds the torrent by info-hash in `/torrents/mylist` and prints its
  audio files in natural play order (index, id, size, path). `--filter` keeps files
  whose path contains `TEXT` (case-insensitive); use it to pick one book out of a
  series torrent.
- **ebook-search** — POSTs `{title, author, limit, contentType:"ebook"}` to the
  EPUB search endpoint and prints candidates (title, format, size, source,
  seeders, and whether it has a magnet / info-hash or a direct URL). The address
  comes from `--search-url`, falling back to `ebook_search_url` in the config file;
  with neither it exits with an error. Search only.
- **anchors** — for each selected file: gets a fresh `requestdl` link
  (`redirect=false`), ffprobes the duration, cuts mono 16 kHz clips before `-i`, transcribes
  them with faster-whisper, and matches each transcript against the book. Model runs on
  CUDA (`int8_float16`) when available, else CPU (`int8`); the `nvidia-*-cu12` pip libraries
  are preloaded via `ctypes` so ctranslate2 finds them.

  Exactly one book source is required. `--epub PATH` parses the EPUB itself;
  `--paragraphs FILE` takes the paragraph list from the app's own parser as
  `{"title": "...", "paragraphs": ["text", ...]}`. Both go through the same tokeniser and
  shingle index, so `para` indices in `anchors.json` are indices into the EPUB's block
  list or into the `paragraphs` array respectively.

  `--file-ids IDS` restricts the run to those TorBox file ids (comma-separated, e.g.
  `--file-ids 2,5,7`). It is combined with `--filter` (both must match); the chosen files
  are always processed in their natural play order, regardless of the order of the ids.

  By default clips are cut straight from the TorBox HTTPS URL with `ffmpeg -ss` before
  `-i` (HTTP range requests, never downloads the whole file). `--download` instead fetches
  each selected file once with `requests` (streamed, 1 MB chunks), ffprobes and cuts clips
  from the local copy, and deletes it after `anchors.json` is written unless `--keep-audio`
  is given. Files live in `--audio-dir` (default `~/.cache/earmark-readalong/audio/`) as
  `<infohash>-<fileid><ext>`; a complete file (size matches TorBox) is reused rather than
  re-downloaded. This is much faster for Ogg/Opus, which has no seek index. The parent
  directory of `--out` (and therefore the cache file beside it) is created if missing. If
  five clips in a row fail to produce a transcript, the run aborts with a fatal error
  (an `error` event under `--progress-json`); a cut failure on a local `--download` file
  does not try to refresh the TorBox link.

  `--progress-json` makes stdout carry **only** newline-delimited JSON progress events
  (flushed per line) while all human-readable output moves to stderr. Events:

  ```json
  {"event":"start","files":N,"clips":TOTAL}
  {"event":"download","file":IDX,"bytes":B,"total":T}
  {"event":"clip","done":K,"total":TOTAL,"t":SECONDS,"file":IDX,"transcribed":true}
  {"event":"done","out":PATH,"clips":TOTAL,"matched":M,"kept":KEPT,"wpm_median":X}
  {"event":"error","message":STR}
  ```

  `start` is emitted once every selected file's duration is known; `download` is throttled to
  ~4/s; a `clip` event follows every sampled clip (cached transcripts included, with
  `transcribed` telling whether a transcript exists); `done` carries the anchors path and
  summary counts; `error` is followed by exit code 1 (the traceback goes to stderr).

Clips start at `every/2, every/2+every, ...` (default every 60 s, clip 20 s). Each clip is
transcribed with faster-whisper word timestamps, and an anchor's time is **the start time of the
aligned word within the clip** (`clip_start + word_start`), never the clip midpoint. Transcripts
are cached with their word times in `anchors.json.cache.json` next to `--out`, so a re-run does not
re-transcribe; a cache entry written before word times existed is re-transcribed. `anchors.json`
contains **no book text**.

### dense mode (the default)

`--mode dense` transcribes the **whole** file instead of sampling it. Each audio file is cut into
contiguous ~120 s chunks with a ~3 s overlap (so a word on a chunk edge is heard whole in the next
chunk), one chunk is decoded at a time, so memory stays flat for a 23 h single file. Every chunk's
transcript is located with the same shingle vote as sampled mode, then **all** of its tokens are
aligned to a book window around the located offset with `difflib.SequenceMatcher` (rather than the
sampled mode's +-4 word tolerance). Only tokens inside a matching run of at least three survive; a
chunk that cannot be located (music, intro, credits) emits nothing. Overlap duplicates are dropped.

Anchors are then chosen from the trusted tokens: every paragraph's first and last trusted token
(ideally the paragraph's own first word), plus fillers so no two anchors inside a long paragraph are
more than ~15 s apart. That is roughly two anchors per paragraph, so the app never interpolates
linearly across a paragraph boundary. The whole-book monotonic pass is unchanged. The chunks are
cached in the same `anchors.json.cache.json`, keyed per chunk, so an interrupted dense build resumes
where it stopped. `--every` and `--clip` apply to sampled mode only.

The `check` command detects a dense record (anchors per minute of audio above
`CHECK_DENSE_ANCHORS_PER_MINUTE`, 3) and then samples seeded clips at random offsets that avoid the
120 s chunk grid. For every paragraph boundary inside a clip whose first word aligned it reports the
`predicted - measured` start time (mean, median |.|, p90 |.|, max |.|), plus how many of the book's
paragraphs have an anchor exactly on their first word, only nearby, or none. `--mode dense|sampled`
forces the choice, and `--model` may differ from the build's.

### anchors.json format

```json
{
  "version": 2,
  "timing": "word",
  "hash": "<infohash>",
  "epub": {
    "title": "Book Title",
    "paragraphs": 1234,
    "words": 98765,
    "source": "epub",
    "paragraphsSha1": "<hex sha1>"
  },
  "files": [
    {
      "id": 123,
      "name": "Book/chapter-01.m4b",
      "duration": 3600.0,
      "anchors": [
        {"t": 90.0, "para": 12, "word": 3456, "conf": 0.91}
      ]
    }
  ]
}
```

`source` is `"epub"` or `"paragraphs"`; `paragraphsSha1` is the SHA-1 (hex) of the
paragraph strings joined with `"\n"` (UTF-8). `timing` is `"word"` and `t` is the clip-local
word-start offset added to the clip start, `para` an index into the paragraph list (EPUB blocks or
the `--paragraphs` array), `word` the word offset in the flat token stream, and `conf` the match
confidence. Version 1 (no `timing`, midpoint `t`) is about 10 s late; the app corrects it in
memory.

The WAV is decoded to a float32 array in-process (stdlib `wave` + numpy) before being
handed to faster-whisper. This avoids a faster-whisper/PyAV API mismatch (`av.open`'s
`metadata_errors` keyword was removed in PyAV 19, which faster-whisper 1.2.1 still
passes) and skips PyAV's decode path entirely.

## How matching works

The EPUB is unzipped, `META-INF/container.xml` → OPF → spine is followed, and each
XHTML is parsed with BeautifulSoup. Block-level text (`p`, `h1`-`h6`, `blockquote`,
`li`, and `div` with direct text) becomes paragraphs in reading order. Every paragraph
is tokenised (lowercase, punctuation stripped, quotes/dashes folded, numbers kept) into
a flat word list with a word → paragraph map. With `--paragraphs` the unzip/spine step is
skipped and the provided strings become the paragraphs directly.

Every 4-word shingle of the book is indexed. For a transcript, each of its shingles is
looked up; a match at book position `b` for clip position `c` votes for offset `b - c`.
Correct matches pile up on the true start offset, and offsets are binned to tolerate
insertions/deletions. Confidence is votes ÷ clip shingles; the runner-up bin (excluding
neighbours of the winner) gives a margin. Below either threshold the clip is rejected —
this is also what stops a repeated/chapter-title passage from anchoring on its own.

The winning offset is the book position of the clip's first word. Each clip token is then aligned
to the book words it could be (`same token`, book index within the bin tolerance of
`best_off + token position`, increasing). Aligned tokens that fall in a run of at least three
consecutive tokens are anchor candidates. A clip emits its earliest and latest candidate when their
clip times are at least 6 s apart, otherwise the single candidate nearest the clip's middle. The
anchor time is `clip_start + that token's start`. Finally a longest-increasing-subsequence pass
enforces that **both** time and word index increase across the whole book (including the two
anchors a clip can emit) and drops outliers.

`check` measures the result on held-out audio. For a sampled record it samples random clip times
spread over the selected files (each at least 15 s from every anchor), cuts 12 s clips, aligns each
transcript the same way, takes the aligned token nearest the clip middle, and compares its true time
with the time the anchors predict for that word (piecewise-linear in word index between anchors,
median-pace extrapolation outside — the same maths as `timeForWord` in `src/readalong/anchors.ts`).
For a dense record (or with `--mode dense`) it samples random offsets that avoid the 120 s chunk
grid and compares the predicted and measured **start time of each paragraph boundary** whose first
word aligned inside the clip. Both print signed mean error (positive = the highlight would be late),
median / p90 / max absolute error in seconds, and the five worst samples; the dense report also
prints how many paragraph starts have an anchor exactly on the first word, only nearby, or none.

## Tests

Offline, no GPU or network:

```sh
python3 -m unittest test_match -v
```

Covers: exact clip found at the right paragraph; ~15% word errors still found; foreign
text rejected; a passage repeated twice handled by the margin test and the monotonic
pass; EPUB parsing (spine order, block collection) on a tiny EPUB built in the test;
loading a `--paragraphs` JSON and matching against it; `paragraphsSha1` for known lists;
`--file-ids` parsing/filtering (play order, combinable with `--filter`); the
`--progress-json` event shapes (emitter tested directly, no network/ffmpeg); word-timed
anchor selection (anchor time `clip_start + token start`, leading silence not shifting it,
a garbled first third ignored, two anchors only when candidates span 6 s, multi-token
whisper words, no anchor without a 3-token run, two anchors from one clip through the LIS,
cache versioning); and the `check` maths (prediction is `timeForWord`'s, sample spacing,
error stats) plus a mocked end-to-end `check` run.
