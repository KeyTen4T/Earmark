# Earmark: TorBox audiobook player for Android

Streams audiobooks directly from your TorBox account, with pluggable `.json` scrapers for finding books and Hardcover tracking.

## Features

- **Library**: every torrent in TorBox that contains audio, shown as a cover grid, with a "Continue listening" card, filters (in progress / not started / finished), and live progress for items TorBox is still preparing. Long-press a book (right-click on desktop) to restart it or remove it from TorBox.
- **Player**: a full-screen player with a draggable scrubber, skip buttons (intervals set in Settings), speed from 0.75× to 3×, a sleep timer (minutes or end of chapter), and a chapter list. The bottom mini player stays up while you browse. It plays in the background and shows lock-screen/notification controls.
- **Resume**: your chapter and position are saved per book every few seconds and when you pause. On resume it rewinds 3 seconds.
- **Discover**: searches all enabled scrapers in parallel. Results are tagged **INSTANT** when TorBox already has them cached, and one tap sends a result to TorBox. Cover and author are remembered for your library.
- **Custom scrapers**: import `.json` files (several at once), a URL, or pasted JSON. You can toggle each source on or off. See [SCRAPERS.md](SCRAPERS.md).
- **Hardcover**: connect your account in Settings, then tap **Track** in the player to match the book. It's marked Currently Reading, listening progress syncs about every 2 minutes and when you pause, and the book is marked Read when you finish.

## Sync between devices

Earmark can keep the phone and the desktop in step through one private GitHub Gist of your own. In Settings → Sync, paste a GitHub personal access token that has **only the `gist` scope** (create one at [github.com/settings/tokens](https://github.com/settings/tokens)), then use the same token on your other device. The app finds (or creates) a single private gist named `earmark-sync.json` and merges changes per record with last-write-wins.

It syncs listening progress, cover/author overrides, hidden books, your Want to listen list, and the playback settings (speed, skip intervals) — never the TorBox, AI or GitHub keys, and not scraper or Hardcover link state. Disconnecting removes the token and gist id from the device and leaves the gist itself alone.

Chapters are the audio files inside a torrent, sorted naturally ("Chapter 2" comes before "Chapter 10"). Single-file `.m4b` books play as one long chapter.

## Build

You need Node 20+ and either Android Studio (SDK + emulator) or an Android phone with USB debugging on.

```bash
npm run setup     # installs Expo and matching native modules
npm run android   # builds and installs on the connected phone/emulator
```

To make an installable APK without Android Studio, use Expo's cloud build (free account): `npm run apk`.

Expo Go is not supported, because background audio and secure storage need a native build.

On first launch, paste your TorBox API key (torbox.app → Settings → API).

## Linux desktop

The same app runs on Linux (built on Linux Mint 22) inside an Electron window.

```bash
npm --prefix desktop install   # once
npm run desktop                # build and open it
npm run desktop:dist           # make desktop/dist/*.deb and *.AppImage
```

API keys are encrypted with the system keyring. The window lifts the browser's cross-site request block, because the app talks to TorBox and your sources directly; it only ever loads the bundled app.

## Moving to another computer

```bash
git clone https://github.com/KeyTen4T/Earmark.git && cd Earmark
bash new-machine.sh
```

That installs the build tools, the app's packages, the generated Android project, the `ocd` wrapper and the read-along tool. Things it can't do for you:

- **OpenCode**: install it and sign in, so `ocd` has something to run. Check with `ocd -C "$PWD" --plan "Reply with exactly: pong"`.
- **GitHub CLI**: `gh auth login`, needed for pushing and publishing releases.
- **git name and email**: `git config --global user.name ...` and `user.email ...`, or commits fail.
- **TorBox key for the read-along tool**: put it in `~/.config/earmark-readalong/config.json`.
- **In the desktop app**: paste your TorBox key, and your GitHub sync token under Settings → Sync. Listening progress, wishlist, covers and settings then arrive through sync.
- **NVIDIA driver**: the read-along tool uses the GPU when the driver is installed, and falls back to the CPU otherwise.

Android APKs built on any computer install over each other: they are signed with the stock debug key that the Android project generator creates, which is identical everywhere.

## Read-along tool (experimental)

`tools/readalong/` samples short clips of an audiobook, transcribes them, and finds them in the book's EPUB to produce time-to-paragraph anchors. See `tools/readalong/README.md`.

## Project layout

```
App.tsx                      tabs, mini player, data loading
src/player/PlayerContext.tsx playback engine (expo-audio), resume, sleep, Hardcover sync hook
src/screens/                 Setup, Library, Discover, Settings, Player
src/components/              UI kit (covers, buttons, sheets, toasts), tab bar, scrubber
src/torbox.ts                TorBox API
src/hardcover.ts             Hardcover GraphQL client and progress sync
src/sync/                    cross-device sync: pure merge, GitHub gist client, coordinator
src/scrapers/                scraper engine, template language, .torrent → magnet (bencode + SHA-1)
scrapers/                    example scraper files
test/                        unit tests for the scraper engine (npm test)
```

## Notes

- TorBox stream links expire. Earmark requests a fresh link for each chapter, and again when you resume after a long pause.
- The progress sent to Hardcover is estimated from file sizes when chapter lengths aren't known yet. If Hardcover has an audiobook edition with a runtime, it's scaled to that.
- Your TorBox key and Hardcover token are stored in Android's encrypted keystore (expo-secure-store).
