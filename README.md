# Earmark: TorBox audiobook player for Android and Linux

Streams audiobooks straight from your TorBox account, on an Android phone or a Linux desktop. It finds books through search sources you choose, remembers where you stopped, and can track your listening on Hardcover.

## Install and set up

You need a [TorBox](https://torbox.app) account. Everything else is optional.

1. **Install.** Get the latest version from the [Releases page](https://github.com/KeyTen4T/Earmark/releases/latest).
   - **Android**: download `Earmark-x.y.z.apk` on the phone and open it. Android will ask you to allow installs from your browser the first time.
   - **Linux**: install `earmark-desktop_x.y.z_amd64.deb`, or make `Earmark-x.y.z.AppImage` executable and run it.
2. **Sign in.** On first launch, paste your TorBox API key. You'll find it at torbox.app → Settings → API. Every audiobook already in your TorBox account appears in the Library.
3. **Find a book.** Open **Discover** and search. Results marked **INSTANT** are already cached on TorBox and play straight away; others have to download to TorBox first, and the app warns you if nobody is seeding one. Tap a result to add it to your account.
4. **Listen.** Tap a book in the Library. Playback continues in the background with lock-screen controls, and your position is saved as you go.

Earmark checks for a new version once a day and offers it; you can also use Settings → Check for updates.

### Optional extras

- **More search sources**: Settings → Sources. Import a source from a `.json` file, a URL or pasted JSON, and switch each one on or off. The format is described in [SCRAPERS.md](SCRAPERS.md).
- **Sync between your own devices**: Settings → Sync, with a GitHub token of your own. See [Sync between devices](#sync-between-devices).
- **Hardcover**: Settings → Hardcover, then tap **Track** in the player to match a book.
- **Offline listening** (Android): download a book to the phone from its ⋯ menu.
- **Read-along**: follow the book's text while it plays. This needs an EPUB search address (Settings → Read-along) and something to build the read-along: the desktop tool in `tools/readalong/`, or your own read-along server. It is experimental.

### Sharing one TorBox account

Several people can use the same TorBox key, each on their own device. Keep in mind:

- The Library is the account's list of audiobooks, so everyone sees every book anyone adds.
- **Remove from TorBox** removes the book for everyone. To tidy your own view, hide a book instead.
- Listening progress, ratings and settings stay on each device. Don't share a sync token between people: synced devices overwrite each other's progress.
- Check TorBox's own terms and limits before sharing an account.

## Features

- **Library**: every torrent in TorBox that contains audio, shown as a cover grid, with a "Continue listening" card, filters (in progress / not started / finished), and live progress for items TorBox is still preparing. Long-press a book (right-click on desktop) or use its ⋯ menu to edit its details, mark it finished, hide it, restart it or remove it from TorBox.
- **Finished shelf**: the Finished filter lists what you've finished by year, with the date and your own half-star rating.
- **Player**: a full-screen player with a draggable scrubber, skip buttons (intervals set in Settings), speed from 0.75× to 3×, a sleep timer (minutes or end of chapter), and a chapter list. On a wide desktop window the chapters sit beside the player. The bottom mini player stays up while you browse. It plays in the background and shows lock-screen/notification controls.
- **Resume**: your chapter and position are saved per book every few seconds and when you pause. On resume it rewinds 3 seconds.
- **Discover**: browse a catalogue with ratings and reviews, or search all enabled sources in parallel. Results show the narrator where the source gives one, a **FULL CAST** mark for dramatised recordings, and **INSTANT** when TorBox already has them cached. One tap sends a result to TorBox. Cover and author are remembered for your library.
- **Custom sources**: import `.json` files (several at once), a URL, or pasted JSON. You can toggle each source on or off. See [SCRAPERS.md](SCRAPERS.md).
- **Hardcover**: connect your account in Settings, then tap **Track** in the player to match the book. It's marked Currently Reading, listening progress syncs about every 2 minutes and when you pause, the book is marked Read when you finish, and your rating is sent along.
- **Read-along** (experimental): the book's text beside the audio, with the current paragraph highlighted; tap a paragraph to jump there.

## Sync between devices

Earmark can keep the phone and the desktop in step through one private GitHub Gist of your own. In Settings → Sync, paste a GitHub personal access token that has **only the `gist` scope** (create one at [github.com/settings/tokens](https://github.com/settings/tokens)), then use the same token on your other device. The app finds (or creates) a single private gist named `earmark-sync.json` and merges changes per record with last-write-wins.

It syncs listening progress, cover/author overrides, hidden books, your Want to listen list, finish dates and ratings, read-along records, and the playback settings (speed, skip intervals) — never the TorBox, AI or GitHub keys, and not scraper or Hardcover link state. Disconnecting removes the token and gist id from the device and leaves the gist itself alone.

Chapters are the audio files inside a torrent, sorted naturally ("Chapter 2" comes before "Chapter 10"). Single-file `.m4b` books play as one long chapter.

## Build from source

You only need this to change the app; to use it, install a release as described above.

You need Node 20+ and either Android Studio (SDK + emulator) or an Android phone with USB debugging on. On Linux Mint or Ubuntu, `bash install-prereqs.sh` installs the toolchain.

```bash
npm run setup       # installs Expo and matching native modules
npm run android     # builds and installs on the connected phone/emulator
npm run apk:local   # makes a release APK in android/app/build/outputs/apk/release/
```

`android/` is generated: create it with `npx expo prebuild --platform android`. Expo Go is not supported, because background audio and secure storage need a native build.

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
- Your keys and tokens are stored in Android's encrypted keystore (expo-secure-store), or encrypted with the system keyring on the desktop. They are never synced.
