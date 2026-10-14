# Earmark

TorBox audiobook player: one Expo/React Native codebase, built as an Android app and as a Linux
desktop app (Electron wrapping the web export). `tools/readalong/` is a separate Python tool.

## Current state

Work in progress and open problems are in `tools/readalong/STATUS.md`. Read it before starting.

## Releases and pending work

This repository is public. Never put server addresses, keys, tokens, e-mail addresses or other
personal details in tracked files; they belong in `private/` (ignored by git), which also holds the
unedited notes from before the repo went public. The earlier history and the releases up to 1.3.5 are
in the private `KeyTen4T/Earmark-private`.

- **Current release: 1.3.19** (14 Oct): rewind after a pause and listening stats. Run in a browser
  against a fake library and a fake gist; not run on Android, a TV, or against the real gist.
  - Rewind after a pause (`src/player/rewind.ts`): 0 s under 5 s paused, then 2 / 5 / 10 / 20 s up to
    an hour and beyond. Detected on the status listener's playing false → true, so lock-screen and
    headphone resumes (which never reach `toggle()`) are covered; seeks, chapter loads, recovery reloads
    and buffering stalls do not count as pauses. Opening a book uses the same scale from `saved.updated`,
    never less than the old 3 s. Settings → Playback → "Rewind after a pause", device-local, default on.
  - Listening log (`src/listening-log.ts`): book seconds and wall seconds per device / local day /
    book, from plausible position advances on the tick (no re-render), flushed every 30 s and on
    persist. Syncs as the top-level `listening` key, merged by max per leaf; it does not trigger a sync
    by itself. Stats screen `src/screens/ListeningStats.tsx` (Library chip and Settings row): week,
    year, 7-day bars, streaks (≥ 5 min wall time a day), finished this year, top books, average speed.
  - Pre-tracking estimate (`src/listening-estimate.ts`, top-level sync key `listeningEstimate`), made
    once: from the sync gist's revision history when sync is set up (last revision per local day,
    forward deltas per book, a jump over 16 h in a day capped, the first sighting uncapped), otherwise
    from current progress. The part history does not cover is a lump dated by `finishedAt` /
    `Progress.updated`. Estimates count in totals and bars (lighter) but never in streaks or speed. A
    `history` snapshot beats a `progress` one, then earliest `createdAt`. The user's real case: about
    20 h into Dune, 10 h in the week before 13 Oct and 10 h months earlier.
- **1.3.18** (13 Oct): 5.1 books as Dolby Digital on Android TV. Seen working on
  the user's Shield (Vizio 5.1 soundbar over the TV's eARC); not run on a phone or the onn.
  - The user's TV takes surround only as Dolby (2-channel PCM even over eARC), so Android downmixed
    5.1 Opus to stereo. `modules/earmark-surround/` (local Expo module, Android only) encodes 6-channel
    PCM16 to AC-3 at 640 kbps with aften 0.0.8 (vendored, LGPL-2.1) and passes it through:
    `Ac3PassthroughAudioSink` wraps the `DefaultAudioSink`; `patches/expo-audio+57.0.5.patch` (via
    patch-package) loads `SurroundRenderersFactory` by reflection. expo-audio ships a prebuilt AAR,
    so `package.json` sets `expo.autolinking.android.buildFromSource: ["expo-audio"]`; without it the
    patch is silently ignored. Re-check both on every Expo upgrade (the dex should contain
    `buildSurroundRenderersFactory`).
  - AC-3 is used when the input is 6-channel PCM16 at 48/44.1 kHz, the route accepts AC-3 5.1
    passthrough, the speed is 1x and the setting is Auto. The advertised PCM channel count is not
    used: the Shield claims 8 while its HAL refuses more than 2. Other speeds play the old PCM path
    (stereo on that TV); speed-adjusted surround (step D) was skipped by the user's choice.
  - Android's Opus/Vorbis decoders output Vorbis channel order; media3 passes the map in
    `configure(..., outputChannels)` and the AC-3 path applies it before encoding. A laptop round
    trip (`modules/earmark-surround/test/roundtrip.sh`) cannot catch an order bug; play a 5.1 Opus
    channel-test file through the app (see `private/SURROUND-HANDOVER.md`).
  - Settings → Playback → Surround sound (TV only, device-local): Auto / Stereo; a change re-opens
    the chapter at the live position. The player shows "Dolby Digital 5.1" only while AC-3 is sent
    (`src/surround.ts` → `outputMode()`).
  - Success on a device: `EarmarkSurround: passthrough ac3 5.1 48000 map ...` in logcat and
    `pass-thru: 1` in `dumpsys media.audio_flinger`. NVIDIA's HAL still logs `Sink does not support
    multichannel` for the first open; that line is not a failure.
- **1.3.17** (13 Oct): no new feature; four robustness and speed changes found by an
  audit, and a desktop fix. Run in a browser against a fake 120-book library; not run on Android or a TV.
  - Player state is two contexts in `PlayerContext.tsx`: `usePlayer()` (does not change per tick) and
    `usePlayerTick()` (the `TICK_FIELDS` of `src/player/visibility.ts`). Only what draws the position
    may call `usePlayerTick()`; a screen that does redraws several times a second. The actions are
    permanent wrappers that call the current render's copy. `isPlaying()` reads the state on demand.
  - The Library is one `FlatList` of rows (`src/library-rows.ts`: `cardRows`, `finishedRows`,
    `bookMetrics`), cards are `React.memo`. The filter is in each row's key, not on the list, so a
    filter change leaves the header (search field, a remote's focus on a chip) alone. The Finished
    shelf's year grouping was not opened after the change.
  - Every read-modify-write in `storage.ts` and the Hardcover links goes through `serial` in
    `src/write-queue.ts`. A queued function must never call another queued function (it would wait on
    itself); split it into an unqueued inner helper. `applyRemoteProgress` skips a record older than
    the one stored (`src/remote-progress.ts`). Not queued: the "read elsewhere" list and the pending
    read-along jobs, whose callers load and save themselves.
  - `fetchWithTimeout` (`src/fetch-timeout.ts`): 20 s for the JSON APIs, 30 s for the read-along
    server, 50 s for the seeder check, 60 s for recommendations. File downloads and the audio Range
    reads have none. Unit-tested with a fake fetch only. `submitJob` posts the whole book text under
    the 30 s limit.
  - Desktop: the sidebar called `findNodeHandle` on every platform and react-native-web throws there,
    so the web export of 1.3.16 was blank in the wide layout. TV-only code that touches native handles
    must sit behind `isTV`.
- **1.3.16** (12 Oct): a round of Android TV work done on the user's onn 4K Plus, plus
  cleaner titles and one more synced setting. Seen working on the onn unless noted.
  - Player on a short screen (`shortPane` in `PlayerScreen.tsx`, height < 640): the two-pane player's left
    column measured its title and controls (`paneRest`) and gives the cover what is left; the transport
    goes compact and the chapter-name line is dropped. Before, the transport and pills were off-screen.
  - Seek bar with a remote (`TVScrubber` in `Scrubber.tsx`). RN passes no arrow keys to JS inside a Modal
    and `view.focus()` is a no-op (`enableImperativeFocus` is off), so three stacked focus targets are
    linked in a ring with `nextFocusLeft/Right`; the direction the focus moved is the key pressed. Step is
    `seekStep` (Settings → Playback → Seek bar step, TV only, default 5 s, device-local). Tried with adb
    key events, not a held button on a physical remote.
  - Sidebar items are chained with `nextFocusUp/Down` (`Tap`/`Button` are now `forwardRef`). Left from the
    content still lands on the nearest sidebar item; it cannot be redirected without imperative focus.
  - Library on TV: covers about 132 wide (112 with the player bar), no `StickyBar`; the grid card has a
    4 px inset so the focus ring does not cover its text. Discover on TV: one scrolling chip row with
    "Surprise me" at its end, and the chart grid fills the width. `PlayerBar` is 64 tall on TV.
  - Titles: `src/titles.ts` (`prettyName`, `audioTags`; tests in `test/titles.test.ts`) strips codec,
    channel and encode tags and shows them as badges (`AudioBadges`). The badge reads the torrent name; it
    is not the decoded channel count. Chapter names are not cleaned.
  - `Cover` shows its title placeholder until the image has loaded; not seen on a slow load.
  - The EPUB search address syncs as a new top-level `ebookSearch` key (older versions carry unknown
    top-level keys through). Unit-tested only; not seen crossing between two devices.
  - Surround: on the user's Shield a 5.1 Opus book is decoded to six channels but the HDMI sink refuses
    multichannel PCM (`nvaudio_hw: Sink does not support multichannel`), so Android downmixes to stereo.
    Not an app fault; an in-app Dolby Digital encode would be the fix and is not built.
  - Seen once and not reproduced: a book restarted from 0:00 after an `adb install -r` over a running
    player. Two deliberate force-stop tests afterwards resumed correctly.
- **1.3.15** (12 Oct): Android TV made usable with a remote, after trying 1.3.14 on
  the user's onn 4K Plus (driven over adb: `adb connect` to its address, `input keyevent DPAD_*`,
  `uiautomator dump` to see which node is focused).
  - On Android `accessible` alone makes a view focusable (`ReactViewManager.setAccessible`), so a view
    that must not take the remote's focus needs `focusable={false}` and `accessible={false}`: the
    `Sheet` backdrop, the `Scrubber`, and a disabled `Tap`.
  - React Native's `ReactEditText` refuses focus from a D-pad. On TV `Input` in `ui.tsx` is a button
    showing the value; selecting it mounts the real field with `autoFocus`. The on-screen keyboard
    needs a second press of OK (RN only opens it by itself in touch mode).
  - The focus ring is an overlay inside the control (`TVFocusRing`), white; an outline was clipped.
  - `apk:local` builds `armeabi-v7a,arm64-v8a`: the onn is 32-bit only. The APK is about 44 MB.
  - Seen working on the onn: sidebar, Library grid and options sheet, player, Settings list, the
    read-along server sheet (typing), the source editor. Not checked: Discover search, the Hardcover
    and sync sheets, the Shield, and the in-app installer (first real use is the update to 1.3.15).
- **1.3.14** (12 Oct): on Android TV the read-along's fade-away reading screen is
  off (`chromeActive` in `PlayerScreen.tsx`); a remote could not bring the controls back. Worked out
  from the code, not seen on a TV.
- **1.3.13** (12 Oct): Android TV, the in-app installer, and dense read-along timing (see
  `tools/readalong/STATUS.md`). The read-along timing was confirmed by the user on the laptop from
  source (Harry Potter rebuilt); the other two have not been run on a device.
  - Android TV: the phone APK also installs on a TV. `plugins/withAndroidTV.js` adds the leanback
    launcher entry, the banner (`assets/icon/tv-banner.svg`) and moves the phone's portrait lock from
    the manifest into `MainActivity`; `isTV` in `src/layout.ts` forces the wide layout, `Tap` and
    `Input` in `src/components/ui.tsx` draw the focus ring, and the file pickers, Backup, Share and car
    mode are hidden on TV. The portrait lock has not been re-checked on a phone.
  - In-app installer: on Android "Update" downloads the APK into the cache, checks it against the
    release asset's size and the ZIP magic, and opens the system installer through
    `expo-intent-launcher` (`src/update-install.ts` pure logic and controller, glue in `src/update.ts`;
    needs `REQUEST_INSTALL_PACKAGES`). It replaces handing the APK link to a browser, which downloaded
    the file and never installed it (cause inferred from the code, not reproduced). Versions up to
    1.3.12 still have the old button, so the step to 1.3.13 is a manual install.
  - `npm run apk:local` needs `ANDROID_HOME` (e.g. `~/Android/Sdk`) when `android/local.properties`
    is absent.
- **1.3.12** (11 Oct): Discover → All audiobooks has a "Full cast" shelf
  (`fullCastShelf`/`mergeFullCast` in `src/catalog.ts`; `cleanFullCastTitle` in `src/scrapers/cast.ts`
  for "Search my sources"), and the sources search has a "Full cast" filter chip. The shelf was run in
  a browser against Apple's real catalogue (164 books); the filter chip is covered by tests only.
- **1.3.11** (11 Oct), six additions, all run only in a browser with a fake library
  unless noted:
  - Chapters inside a one-file book (`src/chapters/embedded.ts` pure parser for m4b `chpl` /
    QuickTime chapter track and MP3 ID3 `CHAP`; `src/chapters/fetch.ts` reads it with Range requests
    in 128 KB blocks; `embedded` in `PlayerContext`). Saved `Progress` stays file-based. Checked on
    ffmpeg-made files, never on a real audiobook from TorBox. The Library's Continue card still says
    "Chapter 1 of 1" for such a book.
  - Car mode (`src/screens/CarMode.tsx`), phone layout only; keeps the screen awake with
    `expo-keep-awake`, which Expo already ships. Not seen on a phone.
  - Follow a narrator (`src/narrators.ts`; list is device-local and in backups).
  - Import reading history (`src/reading-history.ts`, `src/goodreads.ts`): Hardcover or a Goodreads
    CSV. Unmatched books become device-local "read elsewhere" shelf rows. The Hardcover query
    (`HC_HISTORY_QUERY`) has never been run; the Goodreads path was not run in the browser either.
  - Share my setup (a `kind: "setup"` file: sources and the EPUB search address only) and What's new
    (release notes once per new version; `whatsNewDecision` in `src/update-check.ts`). Neither was
    opened in the browser.
- **1.3.10** (11 Oct): narrator preview. A cached source result's detail sheet has
  "Preview narrator" (`src/preview.ts`: pure decisions plus a controller with injected TorBox calls;
  wiring in `DiscoverScreen.tsx`). It adds the torrent, plays up to 75 s, and deletes it unless the
  user taps Send to TorBox. It may delete only a torrent its own add returned, after an account
  listing that did not contain the hash; keep that rule when changing it. Run in a browser against a
  fake TorBox (add/stream/delete counted); never against the real one, and not on a phone.
- **1.3.9** (11 Oct): Settings → Backup. Export writes one JSON file (`src/backup.ts`
  pure, `src/backup-io.ts` platform glue): the sync document plus the user's sources, the two
  addresses and the Hardcover links, never a secret. Import merges or replaces; Replace re-stamps
  restored records so the next sync pushes them. Progress has no tombstone in the sync format, so a
  progress record Replace removes locally can come back from the gist. Export, the import sheet and
  Replace were run in a browser with a fake library; saving on Android (Storage Access Framework
  folder picker) and the Electron download have not been run.
- **1.3.8** (11 Oct): after a book is added, the Library re-reads TorBox every 4 s
  until that book is listed, for up to 3 min (`src/library-poll.ts`). The user had reported new books
  taking minutes to appear; the cause was inferred from the code, not reproduced, and the fix has not
  been tried against TorBox.
- **1.3.7** (11 Oct): the finished shelf. The Library's Finished filter lists books by
  year with the date finished and the user's own half-star rating (`src/shelf.ts`; `finishedAt` and
  `rating` live in `BookMeta` and sync with it). A rating on a book linked to Hardcover is pushed by
  `syncRating` in `src/hardcover.ts`; that mutation has never been run against Hardcover. Versions
  before 1.3.7 drop both fields when they sync. Seen working in a browser with a fake library only.
- **1.3.6** (11 Oct) was the first from the public repo. It adds the in-app update
  check (`src/update.ts`, `src/update-check.ts`), the app icon (`assets/icon/`, drawn to Delta Icons'
  template), and takes the third-party search addresses out of the code: a previously fetched
  audiobook source is migrated once into the user's own sources, and the read-along EPUB search
  address is a per-device setting (Settings → Read-along). None of 1.3.6 has been run on a device;
  only typecheck and the unit tests.
- **Earlier**: 1.3.5 narrators and full-cast marks in the sources search (`src/scrapers/cast.ts`) and
  Cancel during the wait for a read-along EPUB; 1.3.4 five failures made visible (seeder check when
  TorBox is unreachable, synced settings without a restart, full-disk downloads, unreadable saved
  data, Hardcover update failures), not run in the app; 1.3.3 ratings and reviews in Discover; 1.3.2
  the two-pane desktop player (two panes from 900px, no chapters sheet on desktop, Read puts the text
  on the right) and the fade-away reading screen.
- **Read-along server**: `tools/readalong/server/` runs on the user's own server behind a reverse
  proxy; its address and deployment details are in `private/`. To update the tool there, copy the
  changed files from `tools/readalong/` (`readalong.py`, `server/server.py`, `server/gist.py`) over
  the server's copies and rebuild the container (`docker compose -f server/docker-compose.yml up -d
  --build`). A Claude session must never see the server's secrets.
- **Pending: the desktop PC** has not been updated since before 1.3.0. Keep the old Earmark there
  closed until 1.3.6 is installed (`gh release download v1.3.6 -R KeyTen4T/Earmark -p '*.deb'`, then
  the user runs `sudo apt install ./earmark-desktop_1.3.6_amd64.deb`): versions before 1.3.0-beta.6
  strip the MP3 seek map from a read-along record when they sync it. A source checkout there must be
  re-cloned from the public repo, never pushed. Still unchecked in the desktop app since 1.3.1: the
  grid filling the window, Escape closing dialogs then the player, the player bar's speed / sleep /
  chapters buttons, and the two confirmations (Remove from TorBox, Sign out).
- **Looking at the app without touching TorBox**: `npx expo export --platform web --output-dir <tmp>`,
  add a `<script>` before the bundle in `index.html` that sets `localStorage['secret:torbox_api_key']`
  to a dummy value and replaces `fetch` for `api.torbox.app` (`/torrents/mylist` returns fake
  torrents with `files`, `/torrents/requestdl` a local MP3, everything else an error), and serve the
  folder on localhost with a server that supports Range requests (`python3 -m http.server` does not).

## Discover ratings and reviews (1.3.3, 10 Oct)

A book's page in Discover (the detail sheet in `src/screens/CatalogSearch.tsx`) shows a rating row
under the title and, with a Hardcover token set, up to five reviews under the description. Lookup
and cache are in `src/ratings.ts`; the pure matching, formatting and review parsing are in
`src/ratings-match.ts` (tests: `test/ratings.test.ts`).

- **Rating**: Open Library search by cleaned title and author, shown only on a clear match (same
  title, an author surname in common) with at least 3 ratings; otherwise nothing is shown. A
  translated book can come up empty because Open Library keeps its ratings under the original title
  (*The Girl with the Dragon Tattoo*). Hardcover's rating is the fallback when a token is set.
- **Reviews**: Hardcover `user_books` with a review, spoilers excluded, most liked first. The query
  was written from Hardcover's published schema and never run by a Claude session (it needs the
  user's token); the user confirmed the feature on the Pixel 7 without saying which parts they saw.
- **Not done**: no ratings on the browse grid (deliberate: one lookup per opened book only). Ratings
  are of the book, not the narration. Not run in the packaged desktop app.

## Delegating to opencode

The delegation and round-trip rules are global, in `~/.claude/CLAUDE.md` (source:
`tools/ocd/CLAUDE.global.md`, installed by `new-machine.sh`). For this project pass
`--check "npm run typecheck && npm test"`, and never send opencode adding torrents.

## Checks

```bash
npm run typecheck
npm test
```

Pure logic lives in modules with no react-native/expo imports so it runs under the Node test runner:
`src/sync/merge.ts`, `src/player/recovery.ts`, `src/book-math.ts`, `src/downloads/state.ts`. New test
files are registered in `test/engine.test.ts`.

## Building

- Desktop: `npm run desktop` (run from source), `npm run desktop:dist` (.deb and AppImage in
  `desktop/dist/`).
- Android APK: `npm run apk:local` → `android/app/build/outputs/apk/release/app-release.apk`.
  Gradle needs Java 17 (the script sets it); the system default Java may lack a compiler.
- `android/`, `dist/`, `desktop/web/`, `desktop/dist/` are generated and not in git. `android/` comes
  from `npx expo prebuild --platform android`; keep `expo.version` and `expo.android.versionCode` in
  `app.json` as the source of truth, and raise `versionCode` on every release or the APK will not
  install over the previous one.
- The APK is signed with the stock React Native debug key that prebuild generates, which is the same on
  every machine, so builds from any computer install over each other.

## Releasing

Bump `version` in `package.json`, `package-lock.json`, `app.json`, `desktop/package.json` and
`versionCode` in `app.json` (and in `android/app/build.gradle` if `android/` already exists). Build the
APK and desktop packages, push, then `gh release create vX.Y.Z` with `Earmark-X.Y.Z.apk`, the `.deb`
and the AppImage attached. Ask the user before pushing or publishing.

## Not verified on a physical phone as of 1.3.1

Offline downloads and stream recovery. New in 1.3.1 and not yet confirmed on the phone: the two
confirmations, Edit details, Mark as finished, and the accessibility labels under TalkBack. (Phone-side gist sync is in use: read-along records reach the phone through it.)
