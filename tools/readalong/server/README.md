# readalong-server

The always-on build service behind `https://readalong.example.org/readalong/`. A phone or desktop
POSTs a book (audiobook hash, TorBox file ids, the EPUB's paragraph list and its SHA-1); one worker
runs `readalong.py anchors --download --progress-json` on CPU, turns the resulting `anchors.json`
into the app's compact record, writes it into the shared sync gist, and hands it back on the job.
See `../SERVER-DESIGN.md` for why it exists and `../README.md` for the tool itself.

- `server.py` — the HTTP API + single worker (Python 3.11 standard library only).
- `gist.py` — reads/writes `readalong[<audioHash>]` in `earmark-sync.json`, with the re-checks.
- `Dockerfile`, `docker-compose.yml` — the container and its caps.
- `test_server.py` — offline tests (fake tool, fake GitHub API; no network).

## Deploy (on the Oracle server, from the repo)

```sh
cd tools/readalong

# 1. Generate the API token (once; keep it).
python3 -c "import secrets; print(secrets.token_urlsafe(32))"

# 2. Create the env file (mode 600) with the token, the TorBox key and a gist-scoped GitHub token.
sudo mkdir -p /opt/readalong-server
sudo install -m 600 /dev/null /opt/readalong-server/readalong.env
sudo tee /opt/readalong-server/readalong.env >/dev/null <<'EOF'
API_TOKEN=<output of step 1>
TORBOX_API_KEY=<your TorBox key>
GITHUB_GIST_TOKEN=<a GitHub token with the "gist" scope>
EOF
sudo chmod 600 /opt/readalong-server/readalong.env

# 3. State volume directory, owned by the container's non-root uid (10001).
sudo mkdir -p /opt/readalong-server/data
sudo chown -R 10001:10001 /opt/readalong-server/data

# 4. Build and start.
sudo docker compose -f server/docker-compose.yml up -d --build
sudo docker logs -f readalong-server   # "listening on :8080"
```

Optional variables in `readalong.env` (defaults shown):

```sh
DATA_DIR=/data            # job queue (SQLite) + temporary audio
MODEL=base.en             # faster-whisper model, pre-downloaded at build time
CPU_THREADS=2             # passed to readalong.py --threads
PORT=8080
# GITHUB_API=https://api.github.com
# READALONG_SCRIPT=/app/readalong.py
```

## Nginx Proxy Manager

Add a Proxy Host:

- **Domain:** `readalong.example.org`
- **Forward hostname / IP:** `readalong-server` (the container name on the shared network)
- **Forward port:** `8080`
- **Custom location:** `/readalong/` → `http://readalong-server:8080` (this keeps the `/readalong`
  prefix; the server's routes already include it)
- **SSL:** request a Let's Encrypt certificate and enable **Force SSL**.
- **Advanced** (so the rest of the domain is not exposed by this host):

```nginx
location /readalong/ {
    proxy_pass http://readalong-server:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 6m;
    proxy_read_timeout 3600s;
}
location / {
    return 404;
}
```

An Uptime Kuma monitor can poll `https://readalong.example.org/readalong/v1/health` (no token).

## API

All paths are under `/readalong`. Every endpoint except health needs
`Authorization: Bearer <API_TOKEN>`; a wrong or missing token is a plain `401`.

| Method & path | Purpose |
|---|---|
| `POST /readalong/v1/jobs` | Queue a build. Body ≤ 5 MB. Returns `{id, position, status}`. A second request for a book that is queued/running returns the existing job. More than 10 queued jobs: `429`. |
| `GET /readalong/v1/jobs/{id}` | `{id, status, done, total, matched, error, record, ...}`; `status` is one of `queued, downloading, building, done, failed, cancelled`. `record` is set once `done`. |
| `GET /readalong/v1/jobs?hash=<40 hex>` | The latest job for a book. `404` if there is none. |
| `DELETE /readalong/v1/jobs/{id}` | Cancel a queued/running job (terminates the child). |
| `GET /readalong/v1/health` | `{status, version, queue, running}` (no auth, for Uptime Kuma). |

`POST` body:

```json
{
  "audioHash": "<40 hex audiobook info-hash>",
  "fileIds": [7, 8],
  "epub": { "hash": "<40 hex EPUB info-hash>", "fileId": 55, "title": "Book Title" },
  "paragraphs": ["First paragraph.", "Second paragraph."],
  "paragraphsSha1": "<sha1 hex of the paragraphs joined with \"\\n\", UTF-8>"
}
```

`paragraphsSha1` must match what `paragraphsSha1()` in `src/readalong/epub.ts` produces, and each
paragraph is at most one string per block. The server validates hashes, ids, sizes and the SHA-1
before it queues anything; request bodies and secrets are never logged.

The finished `record` is also written to the sync gist as `readalong[<audioHash>]` (kept untouched:
every other key, including unknown ones), and re-checked once a minute and again at five minutes to
fix the "gist race".
