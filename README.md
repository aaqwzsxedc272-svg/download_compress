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

**Want it online for free?** The route that needs no card, no Docker and no host that can
disappear is **GitHub Actions** — it runs on GitHub's own machines, which have full internet,
so gofile, filester, turbo, bunkr and YouTube links all work:

1. Open the repo → **Issues → New issue → "Compress a video"**.
2. Paste the link, choose a quality, submit.
3. A runner downloads, compresses and uploads it, then replies on the issue with the **share
   link** plus a downloadable file. You can close the tab.

The engine is `scripts/action-compress.js` — the same resolver, presets and uploader as the web
app, minus the server. Manual runs: **Actions → compress-video → Run workflow**.

Other card-free routes, and their honest limits:

- **SnapDeploy** — a real website, 512 MB, no card, but its free tier has **no outbound
  internet**, so only pixeldrain and direct links work (your browser fetches them).
- **GitHub Codespaces** — 2 vCPU, 8 GB, no card; the `.devcontainer` starts the server and
  exposes port 3000. Best for a burst of big files.
- **Back4App Containers** — free forever, no card, but 256 MB: `tiny`/`small` only.
- **Your own computer + a free tunnel** — `npm start` then
  `npx cloudflared tunnel --url http://localhost:3000`.

Hugging Face needs PRO for any Space that runs compute, Render asks new accounts for a card, and
Zeabur is shutting down in December 2026. Details in [DEPLOY.md](DEPLOY.md).

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

**Optional headless browser.** Several hosts only answer a real browser: gofile mints its API
token inside an obfuscated script, filester sits behind DDoS-Guard, and hotlink-protected CDNs
answer a bare request with a challenge page. With Chromium installed the server solves all three
by opening the page for real — it lists gofile folders, watches which media a page actually
plays, and downloads with the same session cookie. Without it the app falls back to your
browser. Install it where you need it:

```bash
npm run browser:install      # playwright + chromium, ~120 MB, skipped by a normal install
```

Without it, gofile links fall back to your browser (pixeldrain and gofile both allow that);
with it, the server lists and downloads gofile folders on its own.

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

## Share links vs local files

Two different things come out of a job, and they live differently:

| | Where it lives | Survives the machine stopping? |
| --- | --- | --- |
| **Share link** (pixeldrain/gofile/catbox) | on the file host | **yes** — the machine is not involved any more |
| **Download button** | on this machine's disk | no — gone when the session ends |

So the durable result is the share link. Keep *Delivery → Give me a share link* on and the
**Results** panel holds every link; `data/results.txt` is written on each completion, and
**Save links file** downloads the list. Pick the host in *Upload to* (Auto, or a specific one);
the choice is remembered and sent with every job.

## When a host refuses

Some hosts answer a plain request with a challenge page instead of bytes — fileditch 403s,
filester runs DDoS-Guard, players hand out signed URLs. Those downloads are retried through the
headless browser: the page is opened for real, the media request it makes is observed (URL,
referer and cookie), and the bytes are fetched with exactly those headers. If that still fails the
job says so instead of pretending; the file can always be dropped on the page by hand.

`npm run test:fallback` covers that path against a fake host that refuses plain requests.

## Saving results, and not paying for an idle machine

The app keeps a **Results** panel listing everything that finished: the share link, the sizes
before and after, a copy button and a download button. Because the compressed file is uploaded to
the file host, the link keeps working after the machine is stopped — that is the place to keep
results. **Save links file** / **Copy all links** give you the whole list at once, and the server
writes `data/results.txt` on every completion.

**Stop the machine when the queue finishes.** Flip *After the queue → Stop when done*. Two
minutes after the last job ends the server runs the stop command, so a metered host stops
billing while you are asleep. The countdown is shown in the app and **Keep it running** cancels
it; starting a new job cancels it too.

| Environment | Stop command |
| --- | --- |
| Codespaces | `gh codespace stop -c $CODESPACE_NAME` (automatic) |
| anything else | set `AUTO_STOP_COMMAND`, e.g. `sudo poweroff` |

`AUTO_STOP_DELAY_SECONDS` changes the grace period (default 120, minimum 10), and
`AUTO_STOP_WHEN_IDLE=1` turns the feature on at boot.

## Disk space

A video needs roughly **three times its own size** free while it encodes: the source, the
output, and the encoder's scratch files. A 4 GB 4K file therefore wants ~12 GB free.

- The source is deleted the moment the output is complete, so a finished job costs only the
  compressed file.
- A failed job deletes its partial source and output immediately.
- Before a job starts the server checks free space and refuses (with the numbers) rather than
  dying half way through with `No space left on device`.
- `npm run disk` reports total/used/free and the largest jobs; `npm run disk -- --clean` deletes
  finished and failed jobs and the temp directory.
- `/api/health` returns `freeGb`, so a monitor can watch it.

GitHub Codespaces gives a 2-core machine **32 GB**, shared with `node_modules` (~150 MB),
Playwright's Chromium (~450 MB) and the OS. That is comfortable for 1080p work and tight for a
queue of 4K files: do them a few at a time.

## Long jobs and idle hosts

Cloud hosts stop an idle machine, which can cut a two-hour encode in half. Two defences:

- The server prints a `[keep-alive] <job> 42% · 12m left` line to its terminal every 45 seconds
  while anything is fetching, encoding or uploading. GitHub Codespaces counts terminal output as
  activity, so the machine stays awake on its own. Turn it down or off with
  `HEARTBEAT_SECONDS=0`.
- `./scripts/keepalive.sh` does the same from a second terminal, for any host that measures
  activity differently.

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
