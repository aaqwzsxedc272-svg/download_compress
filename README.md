# Squeeze

Paste a video link and walk away. Squeeze downloads it, compresses it, uploads the result to
a free file host and gives you a share link — no account, no card, nothing to watch.

- **Real link resolution** — gofile folders, turbo.cr, pixeldrain, direct `.mp4`/`.webm`
  URLs, and plain pages that advertise a video (`og:video`, `<video>`, `<source>`, JSON-LD).
- **Re-encodes with H.264 / AAC** — plays everywhere, no watermark, usually 70–95% smaller.
- **Presets** from Tiny (360p) to Original resolution, or "fit in N MB" for a hard size target.
- **Live progress** with speed and ETA, then one-click download.
- **Three ways to fetch a video**, so a link the server can't reach still has a chance.
- **Chunked, resumable uploads** — a 4 GB transfer goes up in 8 MB slices, so a dropped
  connection or a picky proxy doesn't lose the whole file.
- **Automatic re-hosting** to gofile, pixeldrain or catbox (anonymous), with a fallback
  chain, and share links that survive a server restart.

**Want it online for free?** Card-free routes that keep it in the cloud:

- **SnapDeploy** — free, no card, 512 MB / 0.25 vCPU, 100 running hours a month. Builds the
  `Dockerfile` unchanged: new container → GitHub repo → this repo → deploy.
- **GitHub Codespaces** — 2 vCPU, 8 GB, no card; the `.devcontainer` starts the server and
  exposes port 3000. Best CPU of any free option.
- **Back4App Containers** — free forever, no card, but 256 MB: `tiny`/`small` only.
- **Your own computer + a free tunnel** — `npm start` then
  `npx cloudflared tunnel --url http://localhost:3000`.

The obvious names stopped being free: Hugging Face requires PRO for any Space that runs compute,
Render asks new accounts for a card, and Zeabur is shutting down in December 2026. `render.yaml`
and `scripts/deploy-space.sh` stay in the repo for anyone who already has those accounts. Exact
steps and limits are in [DEPLOY.md](DEPLOY.md).

Whichever route you pick, `node scripts/verify-deploy.js <url>` proves the whole chain works
from the outside: app up, presets, hosters, a real link resolved, a real video compressed, and
the share link publicly downloadable.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # 54 end-to-end checks
npm run test:resolve
```

Requires Node 18+ (uses the built-in `fetch`). ffmpeg and ffprobe come bundled as static
binaries through `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe` — nothing to
install system-wide.

For YouTube / TikTok / Instagram / X links, install yt-dlp on the same machine:

```bash
pip install -U yt-dlp
```

Squeeze detects it at startup and reports it on `/api/health`.

## Supported hosts

| Host | Automatic? | Notes |
| --- | --- | --- |
| **gofile.io** | yes if the server has internet; otherwise in-browser | folders expand into a file picker; guest accounts minted automatically |
| **pixeldrain.com** | yes | serves its API with open CORS, so the browser can read files directly |
| **turbo.cr** | server only | share pages are signed via `api/sign`; the CDN allows no cross-origin reads |
| **bunkr** | server only | follows the signed-CDN flow; rotates domains, often bot-protected |
| **filester.me** | server only | public metadata + share-page scrape; behind DDoS-Guard |
| direct `.mp4` / `.webm` | yes | no resolution needed |
| any page with a video | yes | `og:video`, `<video>`, `<source>`, JSON-LD |

"Server only" means the *server* must be able to reach the host — so hosts that forbid
cross-origin reads (turbo, bunkr, filester) cannot work in a sandbox whose network blocks them.
For those links Squeeze offers **Save file** (one click, saved to your device) and then asks
you to drop it on the page; the compression is identical.

Open **`/diagnostics`** in the running app to see, from your own machine, which of these hops
work. It reports the server's outbound access, each host's CORS posture, the upload path and a
real end-to-end encode, then explains what that combination means.

## How a link is processed

1. **Resolve it.** `shared/resolve.js` turns a share page into real file URLs:
   - `gofile.io/d/{code}` → guest account → folder listing (choose which file)
   - `turbo.cr/d|v|embed/{id}` → `api/sign` → signed CDN URL
   - `pixeldrain.com/u|l/{id}` → file info / list
   - `bunkr.*` `/f|v|i|d|a/{id}` → signed CDN URL (albums expand to files)
   - `filester.me/d/{slug}` → public metadata, then share-page scrape
   - a URL that ends in a video extension → used directly
   - anything else → the page is fetched and scanned for a video URL
2. **Fetch it**, in whichever of these can reach the file:
   - the server downloads it itself (fastest),
   - `yt-dlp` extracts it for the platforms it supports,
   - or **your browser** fetches the bytes and streams them to the encoder.
3. **Encode it** with libx264 (quality-first: slow-ish preset, low CRF, audio stream-copied
   when it is already AAC, never upscaled). A re-encode that would be bigger than the
   original is discarded and the original is shared instead.
4. **Upload it** to the first file host that accepts it and show the share link. If the
   server has no internet, your browser does the upload instead — gofile and pixeldrain both
   allow cross-origin requests, so this works even behind a locked-down network.

Everything runs in the background: create jobs, close the tab, come back for the link.

## Quality and size

| Preset | Resolution | CRF | x264 preset | Typical saving |
| --- | --- | --- | --- | --- |
| Max quality | native | 19 | slow | small, near-lossless |
| High quality *(default)* | native | 22 | medium | 60–85% |
| Balanced | up to 1080p | 24 | fast | 70–90% |
| Small | up to 720p | 27 | fast | 80–95% |
| Tiny | up to 480p | 31 | veryfast | 90–97% |

Fixed *and* fixed-quality requests are both supported: with "fit in N MB" the encoder runs
two passes so the bits land where the detail is (measured: a 6 MB target produced 5.66 MB, an
8 MB target produced 7.69 MB on a 39.8 MB 1080p source). Audio is copied untouched whenever
the source is already AAC under 192 kbps, so quality there is unchanged and nothing is
spent re-encoding it.

## Hosts used for the output

| Provider | Anonymous | Size | Notes |
| --- | --- | --- | --- |
| gofile.io | yes | ~20 GB | guest token minted automatically |
| pixeldrain.com | yes | ~20 GB | raw body upload, open CORS |
| catbox.moe | yes | 200 MB | plain-text link response |

If a link is a folder with several videos, the UI lists them so you pick one instead of
guessing which file you meant.

If none of the three routes can reach the file, the page says so explicitly and offers to
open the link — downloading it yourself and dragging it in gives an identical result.

## Deploy it online

**Docker** (Fly.io, Railway, a VPS, anything):

```bash
docker build -t squeeze .
docker run -p 3000:3000 -v squeeze-data:/data squeeze
```

The image installs yt-dlp, so platform links work out of the box.

**Render**: point Render at this repo — `render.yaml` describes the service, the health
check and a 10 GB disk mounted at `/data`. Use a paid instance type; free instances have no
disk, so compressed files would vanish between requests.

**Fly.io**:

```bash
fly launch --no-deploy
fly volumes create squeeze_data --size 10
fly secrets set DATA_DIR=/data MAX_UPLOAD_MB=6144
fly deploy
```
(add `[mounts]` in `fly.toml`: `source = "squeeze_data"`, `destination = "/data"`)

> **A note on restricted environments.** Some sandboxes (including the preview pane this
> was built in) can reach npm and GitHub but not consumer file hosts. There, gofile and
> turbo.cr links fail with "this server has no internet route to …" while uploads work
> normally. A normal deployment has full outbound access and resolves them directly.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOSTERS` | `gofile,pixeldrain,catbox` | Which output hosts to try, in order |
| `AUTO_HOST` | on | Set `0` to stop automatic re-hosting |
| `GOFILE_TOKEN` | — | Optional gofile account token (keeps files in one account) |
| `PIXELDRAIN_KEY` | — | Optional pixeldrain account key |
| `DATA_DIR` | `./data` | Working files, deleted automatically |
| `MAX_UPLOAD_MB` | `6144` | Largest accepted video, in megabytes |
| `MAX_CONCURRENT` | `1` | Simultaneous encodes (one per CPU core is a good rule) |
| `ALLOW_PRIVATE_HOSTS` | off | Permit `127.0.0.1` / metadata addresses (tests only) |

By default loopback, `169.254.169.254` and `metadata.google.internal` are refused, so the
app cannot be used to probe the box it runs on.

## Encoding notes

- Video: `libx264`, `-preset veryfast`, CRF 24–31 depending on preset, `yuv420p`, `+faststart`
  so the file starts playing while it downloads.
- The preset caps the **shorter** side, so portrait phone video stays portrait (`1080×1920` at
  "720p" becomes `405×720`).
- Audio is re-encoded to AAC stereo at 64–128 kbps; silent videos skip the audio track.
- "Fit in N MB" converts the target into a bitrate from the clip duration, with a `maxrate`
  ceiling, and warns when the target is too tight to look good.
- One encode runs at a time by default; extra jobs queue with a position shown in the UI.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Version info, presets, upload limit, whether yt-dlp is available |
| `POST` | `/api/resolve` | List the files behind a link |
| `POST` | `/api/jobs` | Create a job: `{ source: "url" \| "ref" \| "sample", url?, ref?, presetId, targetMb }` |
| `POST` | `/api/upload?name=&presetId=` | Upload a file body directly |
| `POST` | `/api/upload/init` | Start a chunked upload: `{ filename, size, presetId, targetMb, url }` |
| `PUT` | `/api/upload/chunk/:id/:index` | Append one 8 MB slice |
| `GET` | `/api/upload/status/:id` | How many chunks have landed |
| `POST` | `/api/upload/finish/:id` | Validate and enqueue the job |
| `PUT` | `/api/relay/:token` | Stream bytes fetched by the browser |
| `GET` | `/api/jobs/:id` | Job state |
| `GET` | `/api/jobs/:id/events` | Server-sent progress stream |
| `GET` | `/api/jobs` | Recent jobs, newest first |
| `POST` | `/api/jobs/:id/host` | Upload the result to a free host |
| `POST` | `/api/jobs/:id/hosted` | Attach a link obtained elsewhere (browser upload) |
| `GET` | `/api/jobs/:id/download` | The compressed MP4 |
| `DELETE` | `/api/jobs/:id` | Cancel / delete a job |

`POST /api/resolve` returns `{ resolver, title, files: [{ name, size, mime, kind, ref }] }`.
Pass a file's `ref` back as `source: "ref"` to compress exactly that file — signed links are
re-resolved at download time, so they never go stale.

## Testing

- `npm run test:resolve` — 19 resolver tests against stubbed APIs (real response shapes).
- `npm run test:hosters` — 9 uploader tests: streamed multipart/raw bodies match their
  declared Content-Length, refusal handling, size-limit skipping and the fallback chain.
- `npm run smoke` — 54 end-to-end checks: sample, upload, browser relay, target size, range
  requests, share-page resolution, reference jobs, chunked uploads (including a re-sent
  chunk and an out-of-order chunk), and every rejection path. Starts its own
  server and a fake external host on a spare port.
- `node scripts/verify-deploy.js <url> [--preset tiny] [--keep]` — verifies a real deployment
  end to end from the outside: health, presets, hosters, yt-dlp and outbound access
  (advisory), link resolution, a real compress, a created share link, and a public download
  of that link. Exits non-zero only on genuine failures.

## Housekeeping

Finished files are removed by a sweeper (everything older than 3 hours, finished jobs after
45 minutes), and all working files are wiped on restart. Job IDs are random and unguessable;
nothing is shared between visitors. Downloads also stop if free disk space gets tight.
