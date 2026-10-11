# Design: building read-alongs on the Oracle server (option A)

Status: **proposal, nothing built yet.** For review before any work on the server.

## Goal

Pick an EPUB for a book on the phone (or the desktop), and the read-along gets built on the always-on
Oracle server, then shows up on every device. No computer has to be on. The desktop keeps its local
GPU build, which is faster (about 6 min against about 20 min per book).

Not in scope: building several books at once, accounts for other people, changes to Minecraft beyond
lowering its memory.

## The flow

1. **Phone, Read on a book with no read-along:** the same sheet as the desktop. It searches your
   configured EPUB source, you pick an EPUB and confirm, and the app adds it to TorBox if needed.
   All of this exists already in `src/readalong/create.ts` and runs on the phone.
2. **Phone:** downloads the EPUB (2-3 MB, the code exists for the reading view) and splits it into
   paragraphs with `src/readalong/epub.ts`, the single paragraph parser.
3. **Phone → server:** `POST /v1/jobs` with the audiobook hash, file ids, the EPUB's TorBox
   hash/file id/title, the paragraph list and its SHA-1.
4. **Server:** queues the job, then runs the existing tool:
   `readalong.py anchors --download --paragraphs … --model base.en --device cpu --progress-json`.
5. **Server → you:**
   - the finished record is written into the sync gist (`readalong[hash]`) so every device gets it;
   - the phone, if it is still watching, also fetches the record from the job and saves it locally
     straight away (see "The gist race" below for why both).
6. Read lights up on every device after the next sync.

## The server side

**One new Docker container, `readalong-server`**, on the existing A1 machine:

- Image: `python:3.11-slim` (arm64) plus `ffmpeg`, `faster-whisper`, and the repo's `readalong.py`.
  The `base.en` model is downloaded at build time. Built on the server from a small Dockerfile kept in
  this repo (`tools/readalong/server/`).
- A small HTTP API (Python standard library, or FastAPI if simpler) and **one worker** that runs one
  job at a time, as a child process of the container.
- **Resource caps:** `--cpus=2 --cpu-shares=128 --memory=3g`, and the worker runs `nice -n 19`.
  Minecraft gets the CPU first whenever both want it. Measured: about 2.3 s per clip, about 20 min per
  book.
- **State:** a `/data` volume holding the job queue (a small SQLite or JSON file, so queued jobs
  survive a restart) and the temporary audio (about 600 MB-1.3 GB per job, deleted after each job).
- **Not reachable directly:** no host port. It joins the `nginx-proxy-manager_default` network, and
  Nginx Proxy Manager proxies `https://readalong.example.org/readalong/` to it with a Let's Encrypt
  certificate. The bare `readalong.example.org` name only serves Minecraft today (port 25565), and the
  DuckDNS account already updates 5 names (likely the free limit), so this reuses one instead of adding another. Everything outside
  `/readalong/` gets a 404. The name is just the Minecraft server's; moving to another name later only
  changes the app's Settings and the proxy host.
- **Secrets**, in a root-only env file (mode 600) passed to the container:
  - `TORBOX_API_KEY`: for the audio download links.
  - `GITHUB_GIST_TOKEN`: gist scope only, for writing the finished record.
  - `API_TOKEN`: a random 32-byte token the apps send.
  - None of them is ever logged or returned by the API.

### API (paths under `/readalong`, all endpoints need `Authorization: Bearer <API_TOKEN>`)

| Method and path | Purpose |
|---|---|
| `POST /v1/jobs` | Queue a build. Body ≤ 5 MB (a long book's paragraphs are about 1 MB). Returns `{id, position}`. A second request for the same book while one is queued or running returns the existing job. |
| `GET /v1/jobs/{id}` | `{status: queued, downloading, building, done, failed, cancelled; done, total; matched; error; record}`. `record` only when done. |
| `GET /v1/jobs?hash=…` | The latest job for a book, so any device can see it is in progress. |
| `DELETE /v1/jobs/{id}` | Cancel. |
| `GET /v1/health` | Up, version, queue length (no token needed, for Uptime Kuma). |

The server validates everything: hashes are 40 hex characters, file ids are integers, at most 10
queued jobs, and the paragraph SHA-1 must match the paragraphs sent. Tokens are compared in constant
time. Wrong or missing tokens get a plain 401.

### The gist race

Sync works by each device reading the gist, merging, and writing it back. If the server writes the
new record between a device's read and its write, that device's write drops the record from the gist.
Two safeguards:

1. The phone that asked for the build fetches the record from the job and saves it locally, so its
   own sync carries the record from then on.
2. The server re-reads the gist 1 minute and 5 minutes after writing, and writes the record again if
   it is missing. Records are newest-wins per book, so writing it again is harmless.

## The app side

- **Settings → Read-along server:** the URL and the token, kept like your other keys (secure store on
  the phone, the keyring on the desktop). When the server isn't set, nothing changes.
- **The Read button** on the phone also shows when a server is configured, and opens the same sheet.
  After the EPUB is confirmed, the sheet says "Building on the server, about 20 minutes. You can close
  this", with progress while it's open.
- **Desktop:** keeps building locally on the GPU. If the read-along tool isn't installed (the laptop,
  say) but a server is configured, it uses the server.
- **Pending jobs** are remembered on the device, so reopening the app checks on them and picks up the
  result even if the gist write was lost.

## Before building

1. **Minecraft memory (you):** check `/spark health` with players on, then set `MEMORY=12G` and drop
   `-XX:+AlwaysPreTouch` from `JVM_OPTS`, and restart the container at a quiet time. This frees about
   6 GB. Without it there are 2.5 GB free and swap in use, which is too tight for a 3 GB container.
2. **Secrets (you):** put the three values into the env file on the server yourself. I give you the
   exact file and command. They should never pass through chat.

## Building and testing it

1. Build and test the container on the PC first (x86 Docker), against the Philosopher's Stone data
   with the `check` command.
2. Deploy to the server. Add the Nginx Proxy Manager host and an Uptime Kuma monitor on `/v1/health`.
3. App changes (Settings, the Read button, polling), checked on the emulator, then a beta for the
   phone.
4. End to end: pick an EPUB on the phone for a book that has none, watch it build, check the result
   with `check`.

## Open questions

- Should the desktop prefer the server even when it could build locally (to keep the PC free), or
  always build locally when it can? Proposal: local when available.
- Phone notification when a build finishes? Proposal: not at first; Read just lights up.
- Remove the test leftovers on the server (`~/readalong-test`, the `python:3.11-slim` image) now, or
  keep the image since the service will use it? Proposal: delete the test folder, keep the image.
