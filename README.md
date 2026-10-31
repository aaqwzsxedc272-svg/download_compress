# Squeeze

Paste a video link (or drop a file), pick a file if the link is a folder, get a compressed
MP4 back to download.

- **Real link resolution** — gofile folders, turbo.cr, pixeldrain, direct `.mp4`/`.webm`
  URLs, and plain pages that advertise a video (`og:video`, `<video>`, `<source>`, JSON-LD).
- **Re-encodes with H.264 / AAC** — plays everywhere, no watermark, usually 70–95% smaller.
- **Presets** from Tiny (360p) to Original resolution, or "fit in N MB" for a hard size target.
- **Live progress** with speed and ETA, then one-click download.
- **Three ways to fetch a video**, so a link the server can't reach still has a chance.
- **Chunked, resumable uploads** — a 4 GB transfer goes up in 8 MB slices, so a dropped
  connection or a picky proxy doesn't lose the whole file.

**Want it online for free?** See [DEPLOY.md](DEPLOY.md) for four free routes (Oracle Always
Free, Hugging Face Spaces, Render, or a local run behind a free tunnel) and what each can fetch.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # 28 end-to-end checks
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
3. **Encode it** with libx264 and hand back a download.

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
| `GET` | `/api/jobs/:id/download` | The compressed MP4 |
| `DELETE` | `/api/jobs/:id` | Cancel / delete a job |

`POST /api/resolve` returns `{ resolver, title, files: [{ name, size, mime, kind, ref }] }`.
Pass a file's `ref` back as `source: "ref"` to compress exactly that file — signed links are
re-resolved at download time, so they never go stale.

## Testing

- `npm run test:resolve` — 19 resolver tests against stubbed APIs (real response shapes).
- `npm run smoke` — 36 end-to-end checks: sample, upload, browser relay, target size, range
  requests, share-page resolution, reference jobs, chunked uploads (including a re-sent
  chunk and an out-of-order chunk), and every rejection path. Starts its own
  server and a fake external host on a spare port.

## Housekeeping

Finished files are removed by a sweeper (everything older than 3 hours, finished jobs after
45 minutes), and all working files are wiped on restart. Job IDs are random and unguessable;
nothing is shared between visitors. Downloads also stop if free disk space gets tight.
