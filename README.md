# Squeeze

Paste a video link (or drop a file), get a compressed MP4 back to download.

- **Re-encodes with H.264 / AAC** — plays everywhere, no watermark, usually 70–95% smaller.
- **Presets** from Tiny (360p) to Original resolution, or "fit in N MB" for a hard size target.
- **Live progress** with speed and ETA, then one-click download.
- **Three ways to get the video** so a stubborn link still works: the server downloads it,
  `yt-dlp` extracts it, or your browser fetches it and streams it to the encoder.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Requires Node 18+ (uses the built-in `fetch`). ffmpeg and ffprobe come bundled as static
binaries through `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe` — nothing to
install system-wide.

To get YouTube / TikTok / Instagram / X links working, install yt-dlp on the same machine:

```bash
pip install -U yt-dlp
```

Squeeze detects it at startup and reports it on `/api/health`. Without it, those links fall
back to the browser route (which only works when the site allows cross-origin downloads).

## Deploy it online

**Docker** (works on Fly.io, Railway, a VPS, anything):

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
fly secrets set DATA_DIR=/data MAX_UPLOAD_MB=2048
fly deploy
```
(add `[mounts]` in `fly.toml`: `source = "squeeze_data"`, `destination = "/data"`)

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Working files, deleted automatically |
| `MAX_UPLOAD_MB` | `2048` | Largest accepted video, in megabytes |
| `MAX_CONCURRENT` | `1` | Simultaneous encodes (one per CPU core is a good rule) |

## How a link gets processed

1. `POST /api/probe` asks the server whether it can reach the URL itself.
2. **Direct file link + server has internet** → the server downloads it and encodes it.
3. **YouTube / TikTok / … + yt-dlp installed** → yt-dlp pulls the best MP4 under 1080p.
4. **Otherwise** → the browser fetches the video and streams the bytes to the server, so
   hosts that block the server's IP (or a server with restricted egress) still work, as long
   as the host sends CORS headers.

If all three fail, Squeeze says so and suggests dropping the file in directly — dragging an
already-downloaded video into the page gives an identical result.

## Encoding notes

- Video: `libx264`, `-preset veryfast`, CRF 24–31 depending on preset, `yuv420p`, `+faststart`
  so the file starts playing while it downloads.
- The preset caps the **shorter** side, so portrait phone video stays portrait (`1080×1920` at
  "720p" becomes `405×720`).
- Audio is re-encoded to AAC stereo at 64–128 kbps; silent videos skip the audio track.
- "Fit in N MB" converts the target into a bitrate from the clip duration, with a
  `maxrate` ceiling, and warns when the target is too tight to look good.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Version info, presets, whether yt-dlp is available |
| `POST` | `/api/probe` | Can this server fetch the URL? |
| `POST` | `/api/jobs` | Create a job from `{ source: "url" \| "sample", url, presetId, targetMb }` |
| `POST` | `/api/upload?name=&presetId=` | Upload a file body directly |
| `PUT` | `/api/relay/:token` | Stream bytes fetched by the browser |
| `GET` | `/api/jobs/:id` | Job state |
| `GET` | `/api/jobs/:id/events` | Server-sent progress stream |
| `GET` | `/api/jobs/:id/download` | The compressed MP4 |
| `DELETE` | `/api/jobs/:id` | Cancel / delete a job |

## Housekeeping

Finished files are removed from disk by a sweeper (everything older than 3 hours, finished
jobs after 45 minutes), and all working files are wiped on restart. Nothing is shared
between users beyond the guessable-free job IDs.
