# Read-along: status (updated 2026-10-10, laptop; released as 1.3.0; current release 1.3.3)

The read-along is released: **1.3.0** (10 Oct) is on `main`, with the read-along view on both
platforms, building on the Oracle server from the phone, the background-crash fix and the MP3 seek
correction. The user confirmed the read-along on the Pixel 7 on beta.6, which is the same code.

**1.3.2** (10 Oct) adds the two-pane desktop player, the desktop seek correction, the read-along
scrolling fix, the header chip and the fade-away reading screen. The user installed the released
1.3.2 build and reported that it works (the install directions given were for the phone's APK; they
did not say which device). The packaged desktop builds were not launched after building, and the
desktop PC (item 10 in `CLAUDE.md`) is not known to be updated.

Released without two checks, at the user's call: a long background listening session on the final
build (the crash fix was measured over five minutes, not a full session), and updating the desktop PC,
whose old app strips the seek map from a record when it syncs it (see below).

## 12 Oct 2026 (laptop): dense alignment, committed, not released

- **Symptom**: on Harry Potter (Opus, so not the MP3 seek problem) the highlight trails or runs ahead
  of the narrator by a few seconds, on phone and desktop.
- **Cause**: the tool heard a 20 s clip per minute and the app interpolated by word count between
  anchors 30-60 s apart; the narrator's pace is not uniform.
- **Change**: `readalong.py anchors` defaults to `--mode dense`: the whole audio in 120 s chunks
  (3 s overlap), every token aligned to the book with `difflib`, anchors on the first and last heard
  word of every paragraph and at most 15 s apart. Same `[t, para, word]` triples, `timing` 2, so old
  apps read it. `--mode sampled` is the old behaviour. In the app, `locate`/`timeForWord`
  binary-search, a dense record (`isDenseRecord`, 3+ anchors a minute) holds a paragraph until the
  next one's first-word anchor, the tick is 100 ms, and the Read sheet says when a record has the
  older timing.
- **Measured** on LibriVox *Pride and Prejudice* ch. 1-3 (18:53, GPU `small.en`, fake TorBox), new
  `check` with clips off the chunk grid: dense median 0.08 s, p90 0.29 s, max 0.75 s; sampled median
  1.05 s, p90 2.56 s, max 3.14 s. 76% of paragraphs got an anchor on their first word. This compares
  Whisper with Whisper, so a bias shared by both runs would not show; nobody has listened to it.
- **Confirmed by the user on the laptop** (`npm run desktop`, Harry Potter rebuilt on the GPU, 251 of
  261 chunks matched): "it sounds right and the tracking is super accurate". Not yet heard on the
  phone, which is still on 1.3.12 without the app-side changes.
- **Not done**: the server still runs the old tool, so a build started from the phone has the old
  timing; a server build of a long book will take hours. `--rest N` (idle N times the transcription
  time after each piece; `EARMARK_READALONG_REST` for the desktop app, off by default) was added for
  fan noise and has never been run in a real build.
- **Cost**: about 100 KB of record for an 8.5 h book, 270 KB for 23 h, and the whole sync document
  is uploaded on every progress sync (up to once a minute while playing).

## 10 Oct 2026 (laptop): text vanished after scrolling far by hand

- **Symptom**: with Read on, scrolling the text a long way back or forward by hand made *all* the
  text disappear (a blank panel), reported on the Pixel 7 release build. Not tried on the desktop or
  the web.
- **Likely cause** (worked out from the code; the fix is now confirmed on the phone, below): while browsing, the viewability handler grew the slice with `computeWindow`, which
  *re-centres* on the row at the edge rather than extending it. A grow at the bottom dropped ~50
  rows from the top while the scroll offset stayed, which landed the viewport near the new bottom
  edge and triggered another grow — a runaway that raced the slice through the book with most of the
  list unrendered. The compensating `scrollToOffset` depended on `rowY` measurements that had just
  been cleared and on `onLayout` firing again for an already-drawn row, and Android's default
  `removeClippedSubviews` could then leave every cell detached: blank. Prepending had the mirror
  problem — rows pushed down with no offset compensation.
- **Fix**: browsing now only *extends* the slice (`growWindow` in `src/readalong/window.ts`): append
  `WINDOW_CHUNK` (60) below when the last visible row is within `WINDOW_EDGE` of the bottom, prepend
  60 above when the first is within `WINDOW_EDGE` of the top, and never re-centre. Appending needs no
  correction (existing rows keep their measured y); prepending is held in place by
  `maintainVisibleContentPosition` (`minIndexForVisible: 0`) on Android and, because react-native-web
  0.21.3 does not implement it, by a manual content-height scroll on the web. The FlatList also gets
  `removeClippedSubviews={false}` and a one-grow-at-a-time lock. The follow path, the highlight tick,
  tap-to-seek and the Manage button are unchanged.
- **Confirmed by the user on the Pixel 7**: scrolling the text far by hand no longer makes it vanish.
- **Back to current presses were dropped on Android**: `Tap` put `position: absolute` on its inner
  view, so the `Pressable` itself had no area — the phone log showed 19 press-ins but only 2 presses,
  and the returns came from the 10 s auto-resume. Fixed (the button became a normal in-flow child of
  an absolutely positioned wrapper) and confirmed by the user, then moved into the header row at the
  user's request, with the header's EPUB title dropped and the single-column controls made compact
  while reading.
- **A finished sync replaced the record object**, so the text view reloaded the whole EPUB (blank for
  seconds). `PlayerScreen` now keeps the existing object when the record is unchanged (`keepRecord`).
  Cause inferred from one log, not directly confirmed.
- **Not verified in the desktop app**: only the pure window maths has tests (`test/readalong.test.ts`:
  `growWindow` never shrinks, always contains the visible range, clamps at both ends, no change in the
  middle, repeated growth reaches 0 and N); the native and web scroll behaviour does not, and the
  header-row move and compact controls are not yet seen on a device.
- **Immersive reading** (new): while the player is visible and the read-along text is showing with no
  sheet open, 6 s without input (`CHROME_IDLE_MS`) fades the chrome out over 350 ms and then drops it
  from the layout so the text fills the screen — on the phone the header, the scrubber/labels/
  transport/pills block and the error banner, plus ReadalongView's own header and mismatch banner; in
  the desktop split, the left pane (and divider) and the right pane's heading. The "Back to current"
  chip stays on screen while the reader has scrolled away, and tapping it snaps back without bringing
  the chrome back: its wrapper's `onTouchStart` sets a flag that the player's root handler consumes.
  Any other touch (a bubbling `onTouchStart` on the player's root view), and on the web mouse
  move/wheel/key down, fades it back over 180 ms and restarts the timer. The tap that reveals it does
  not also seek (`canSeek`/`seekAllowed`, a 500 ms guard). Confirmed by the user on the Pixel 7 (10 Oct), with the header chip and compact controls; none of it has been run in the desktop app.

## 10 Oct (laptop): desktop (Chromium) seek correction modelled on ffmpeg

- **Symptom**: the same drift as the phone, now on the desktop app: on *Dune* (one 1.1 GB VBR MP3)
  the highlight ran ahead of the narrator.
- **Cause**: desktop is the web export in Electron, so audio is an HTML `<audio>` element and
  Chromium demuxes MP3 with ffmpeg's libavformat under `AVFMT_FLAG_FAST_SEEK`. Its `mp3_seek`
  differs from media3's `XingSeeker`: `read_xing_toc` makes 100 entries
  `byte_i = xingFramePosition + floor(toc[i]*dataSize/256)` at `timestamp_i = i*duration/100`, a seek
  to `T` picks the last entry with `timestamp_i <= T`, syncs forward to the next frame, labels it
  `timestamp_i`, and drops audio up to `T`. So the error is constant per slot:
  `err_i = trueTimeAtByte(byte_i) - timestamp_i`, and `true = reported + err_i` where `i` is the
  seek target's slot. It is *not* monotonic across slot boundaries, so the inverse cannot bisect.
- **Fix**: `src/readalong/mp3seek.ts` gains a `SeekModel = 'media3' | 'ffmpeg'` and the ffmpeg
  model beside the unchanged media3 one (slot pick, byte, timestamp, error, and a slot-aware
  inverse that falls back to the nearest boundary, preferring to land just before a gap).
  `src/player/seekbase.ts` takes `SeekModel | null` instead of an Android flag, and
  `PlayerScreen.tsx` uses `'media3'` on Android, `'ffmpeg'` on web, `null` elsewhere.
- **Measured**: a synthetic 40 min VBR MP3 (`f(t)=400+t` Hz over uneven noise sections, libmp3lame
  `-q:a 4`, Xing TOC), app `seek` map from `readalong.py`, 30 targets, real
  `ffmpeg -fflags +fastseek -ss T`. The ffmpeg model fits within 0.05 s (max) and 0.02 s (median);
  the media3 model is off by up to ~4.8 s (median 1.1 s). The two targets that miss badly are
  within ~25 ms of a slot boundary, where the ffmpeg *CLI* shifts the effective boundary by the
  stream `start_time` (the LAME encoder delay, ~0.025 s) — a CLI artifact left unmodelled because
  Chromium seeks through the library, not the CLI. A residual ~10-25 ms bias (about one MP3 frame)
  is left out of the app; no offset added.
- **Measured in Chromium** (the same test page, in the Claude desktop app's browser pane, a
  Chromium build; not Electron itself): 30 targets on one audio element, each read 0.6 s after the
  seek. The ffmpeg model fits within 0.17 s wherever the seek went to data not read before
  (median 0.09 s); the media3 model is off by 3.3 s median. Ten further seeks on a fresh element
  each matched the slot error within 0.02 s.
- **Known gap, not modelled**: ffmpeg also indexes every packet it has read, with the timestamps in
  force at the time. A seek that lands in data already read in this session (seen for a target
  0.1 s after the previous one, across a slot boundary) keeps the *earlier* seek's error instead of
  its own slot's. So a short skip, or a jump back into a stretch just played, can be corrected with
  the wrong slot's error when the two slots differ. How far ahead Chromium reads was not measured.
  The browser pane feeds audio to the analyser slower than real time after about a second, so
  anything needing longer playback has to be measured in the real app.
- **Confirmed by the user on the laptop** (10 Oct, `npm run desktop`, *Dune* with Read on): "it
  worked". They were asked to check the highlight after resuming, after tapping a paragraph a few
  pages away and after a 30-second skip, and did not say which of the three they tried. The test
  page was in a scratch folder under `/tmp` and is not kept.

## 9 Oct (evening, laptop): read-along drift on single-file MP3s, fixed; beta.6

Read this first.

- **Symptom**: on the phone the highlight in *Dune* ran ahead of the narrator, 30 to 60 s at 12.7 h in.
  Harry Potter (Opus) had been fine.
- **Cause, measured**: *Dune* is one 1.1 GB VBR MP3 (22.9 h, Xing header). Android's player (media3
  1.9.0 `XingSeeker`, via expo-audio) seeks with the file's 100-entry table and then reports the time
  it was asked for, while the audio it plays is from somewhere else: 54 s earlier at 45,968 s, over
  30 s off for 76% of the file, worst case nearly five minutes. The tool's anchor times are exact
  (ffmpeg does not use the table by default): six clips cut the tool's way sat at 0.000 s from a full
  decode of the file. The error is constant between seeks and changes at every seek.
- **Fix (commit ee032fe)**:
  - `readalong.py` adds `files[i].seek` to the record for an MP3 with a `Xing` tag and TOC: the Xing
    parameters plus a 4096-point byte-to-time table from `ffprobe` packets, about 25 KB. `Info`-tagged
    and non-MP3 files get none. New `seekmap` subcommand writes only the map for an existing book
    (unit-tested with mocks, never run against TorBox).
  - `src/readalong/mp3seek.ts` reproduces the seek arithmetic (checked against the real media3 class;
    0.87 s worst, 0.11 s median against the exact index on *Dune*; 32768 points would give 0.21 s
    but cost 165 KB per file).
  - `src/player/seekbase.ts` and `PlayerContext.tsx` track `seekBase`, the last seek target for the
    loaded file, including lock-screen/notification/headset skips, which expo-audio handles natively
    and only show up as a jump in the reported position.
  - `PlayerScreen.tsx` converts at the boundary, Android only: the read-along clock goes player time to
    true time, tap-to-seek goes the other way. Position display, saved progress, sync and every other
    platform are unchanged.
- **Bug found on the phone and fixed before the commit**: while a file loads the player reports 0, the
  jump detector read that as a seek to 0 and discarded the resume position, so the correction only
  started after a manual seek. Detection is now off while a file loads, during recovery, and until a
  seek of ours has landed (`seekSettled`).
- **Confirmed by the user on the Pixel 7** after rebuilding the *Dune* read-along on the laptop (2713
  anchors, map included): highlight correct from a cold start.
- **Desktop (Chromium) has the same class of error**: modelled and corrected on 10 Oct (see the top
  entry). Position sync between phone and computers on a file like this may still disagree by the
  same amounts, as it always has.
- **Older app versions strip the map**: their sync code rebuilds each record without unknown per-file
  keys. Any device still on beta.5 or earlier that syncs *Dune* removes its map. The desktop PC's
  installed app is in that state until it is updated to beta.6.
- **The server runs the new tool** since the evening of 9 Oct (code copied over and the image
  rebuilt); no MP3 book has been built on it since, so the map from a server build is untested.
- **1.3.0-beta.6** (version code 8) carries this and the background-crash fix.

## 9 Oct (afternoon, laptop): server switched on, background crash fixed

- **The read-along server is live** at `https://readalong.example.org/readalong` (health check answers,
  HTTPS forced, requests without the token get 401; Let's Encrypt certificate to 7 Jan 2027, renewed by
  Nginx Proxy Manager). The phone (beta.5) is set up with it and its Test accepted the token.
- **First real build from the phone finished**: a long audiobook (1374 clips, so roughly 23 h), 1355 clips matched, 2 h 4 min
  (20:00 to 22:04 UTC), no errors. Memory was 914 MB of the 3 GB limit a third of the way in; the
  peak was not recorded. That is about 4.8 s per
  clip against the 2.3 s measured on 8 Oct; the likely reason is word timestamps, not confirmed. The
  user says slow server builds are fine (the text is mostly used for jumping around), so leave it.
  Read opened that book on the phone; the drift it showed is the MP3 problem above.
- **Playback stopping after 10 to 20 minutes was an out-of-memory crash**, not Android killing the app.
  The phone's own records (`adb shell dumpsys activity exit-info app.earmark.audiobooks`,
  `adb logcat -b crash -d`) showed six `OutOfMemoryError` crashes from 6 to 8 Oct, all in
  `NativeAnimatedNodesManager.createAnimatedNode`. Each status tick re-rendered the player while the
  app was in the background, and the native animated nodes piled up with no frames to draw them.
  Fixed in commit 8bb18ab: React state is held back while the app is in the background and flushed on
  return (`src/player/visibility.ts`, `PlayerContext.tsx`), the highlight tick and sleep countdown
  pause, and the progress bar animates only real jumps. Measured on the Pixel 7, five minutes playing
  with the screen locked (`adb shell dumpsys meminfo app.earmark.audiobooks`): 210 to 429 MB before,
  196 to 199 MB after.
- Released in 1.3.0-beta.6. The beta.5 pre-release is the crashing build.
- **Still to check on the fixed build**: a normal session past 20 minutes, a file change with the
  screen off, and memory with the player screen left visible (two of the six crashes were logged with
  the app on screen; the foreground case was never measured, before or after).
- **Laptop**: `ssh oracle` works, using the server's original key. Its `android/` folder was generated at beta.3; `build.gradle` was hand-set
  to version code 7 / beta.5 for the test build. The installed `ocd` was an old copy without
  `--check`; it has been updated from `tools/ocd/ocd`.

## How it fits together

- **Creating** (desktop only): the player's **Read** button opens a sheet that searches Forge & Fable
  for the book's EPUB. Results already cached on TorBox come first. You pick one, the sheet asks
  before adding anything to TorBox, then it runs `readalong.py` (from `desktop/readalong.js`) with
  `--download --paragraphs --progress-json`. A whole book takes about 6 minutes on the PC's GPU
  (521 clips).
- **Paragraph numbering**: `src/readalong/epub.ts` is the only EPUB parser. The tool takes its
  paragraph list through `--paragraphs`, and each record carries a SHA-1 of that list, so every device
  can check it splits the book the same way.
- **Sync**: `readalong` records (per audiobook hash) travel through the existing gist. A record holds
  anchors and a pointer to the EPUB torrent in TorBox, never book text. `SYNC_VERSION` stays 1,
  because older apps stop syncing on a higher version but already keep keys they don't know.
- **Reading** (desktop and phone): **Read** swaps the cover for the text. The current paragraph is
  highlighted and followed, tapping a paragraph seeks there, and scrolling by hand pauses following
  (resume with "Back to current" or after 10 s). The phone downloads the EPUB from TorBox on first
  open and keeps it.

## Fixed on 8 Oct (evening)

- **Phone button row was squashed** (1×, Sleep, Chapters, Read showed as thin slivers). The cause was
  `Tap` in `src/components/ui.tsx`: it copied `flex: 1` onto its inner view, and on Android that beats
  `height`. Reproduced on the Android emulator and confirmed fixed there (commit c762ec0). The
  earlier navigation-bar theories (beta.2's SafeAreaView, beta.3's 48dp padding) were wrong. The
  48dp padding is harmless and still in.
- **Highlight ~10 s late.** Anchors are now word-timed (faster-whisper word timestamps), sampled every
  60 s, up to two per clip, and the view updates every 250 ms with a 0.3 s lead (commit 4ea0c1c).
  Records made before this are shifted −10 s on load. Measured with the new `check` command on
  Philosopher's Stone (40 held-out clips, 33 aligned): mean error −0.6 s, median 1.0 s, p90 3.5 s,
  max 5.1 s.
- The Harry Potter read-along was rebuilt on the desktop with word timing (975 anchors, 488 of 521
  clips matched). The record in the sync gist has `timing: 2` and points at EPUB torrent `4c66131b…`.

## Read-along server (9 Oct)

Switched on by the user on 9 Oct (steps in **"To do by hand"** in `CLAUDE.md`).
- Service: `tools/readalong/server/` (design in `SERVER-DESIGN.md`, deploy notes in its README).
  25 offline tests. Also run for real on the PC (CPU, base.en, nice 19, fake GitHub): a full
  Philosopher's Stone job finished in 23 min with 475 of 521 clips matched (949 word-timed anchors);
  the fake gist kept every other key; temp files were deleted; the token never reached the log. The
  app's TS client was checked against that running service (probe, status, lookup, dedup, SHA-1).
- On the Oracle server: code at `/opt/readalong-server/src`, image `readalong-server:latest` built
  and smoke-tested (health, offline model load, non-root, ffmpeg). Running since 9 Oct (container
  `readalong-server`, on the proxy's Docker network, secrets in `/opt/readalong-server/readalong.env`).
- App (1.3.0-beta.5): Settings → Read-along server; on the phone, Read on a book with no read-along
  builds on the server. Computers with the tool still build locally. Checked on the emulator up to
  submitting; the emulator still has a local test server configured (http://10.0.2.2:8789, plain HTTP,
  which Android release builds refuse), harmless, remove it under Settings if it gets in the way.

## Verified on the phone (beta.4)

The four-button bottom row and the read-along on Philosopher's Stone (EPUB download, highlight)
work. The phone cannot create a read-along: picking an EPUB is desktop-only by design, which is what
the server design below would change.

## Testing on the PC

- **Android emulator**: AVD `earmark-phone` (Pixel 7, Android 15, x86_64). Start it with
  `~/Android/Sdk/emulator/emulator -avd earmark-phone`, build with `npm run apk:emulator`, install
  with `adb install -r android/app/build/outputs/apk/release/app-release.apk`. It is signed in to
  TorBox but **sync is deliberately off**: it has local progress (Dune) that would overwrite the real
  phone's position if it synced. Wipe the app data first (`adb shell pm clear app.earmark.audiobooks`)
  if sync is ever needed there.
- **Desktop app with remote debugging**: `cd desktop && ./node_modules/.bin/electron .
  --remote-debugging-port=9333` after `npm run desktop:build`. Careful: opening a book auto-plays and
  its progress syncs.

## Known limits

- The MP3 seek correction needs a record built with the current tool; older records for single-file
  MP3s drift until rebuilt (or given a map with `readalong.py seekmap`, not yet wired into the app).
- One read-along per torrent. For a series torrent (one book per file) the sheet builds only the
  current file, and other files show "No read-along for this file".
- When browsing by hand reaches the edge of the rendered slice it is only ever extended now, so the
  rows under the reader do not move. A prepend above relies on `maintainVisibleContentPosition`
  (Android) or a manual content-height correction (web); neither is verified on a device yet.
- The desktop app needs `tools/readalong/setup.sh` (Python venv, ffmpeg, and an NVIDIA GPU if there
  is one). The TorBox key comes from the app itself, not from the tool's config file.

## Test builds

All are GitHub pre-releases from this branch.

- **beta.1**: the button row was cut off, and the phone downloaded a whole audiobook instead of the
  EPUB.
- **beta.2**: record points at the EPUB; layout attempt 1.
- **beta.3**: layout attempt 2. Neither layout attempt helped, because the real cause was the
  squashed buttons.
- **beta.4**: the button fix and the timing fix.
- **beta.5**: building on the read-along server from the phone. Crashes after 10 to 20 minutes of
  background playback, like every build before it.
- **beta.6**: the background-crash fix and the MP3 seek correction. Released unchanged as 1.3.0.

## On another computer

Run `bash new-machine.sh`, then check the reminders it prints (git name and email, TorBox key).
`desktop/scripts/smoke-readalong.mjs` runs a real build from plain Node.

## Then

1. Desktop PC: install 1.3.0 before opening a single-file MP3 book there.
2. Watch for: playback stopping after a long session (should be gone), and the highlight on the first
   MP3 book built on the server.
3. The desktop app's seek accuracy on big VBR MP3s is now modelled (10 Oct, ffmpeg fastseek); the
   Chromium result itself is for the user to confirm. `seekmap` is still not wired into the app, so an
   old record for such a book has to be rebuilt.
