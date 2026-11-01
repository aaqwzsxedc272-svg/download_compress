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
| **filester.me** | server only | public metadata + share-page scrape; behind DDoS-Guard; takes the file's real name from the page, not the CDN's UUID |
| **fileditch** (`theditch.st`, `fileditch.st`, `fileditchfiles.me`) | server only, needs `npm run browser:install` | three URL shapes for one video: the share page, the signed link it hands out, and the file host. All three sit behind Cloudflare, so the page is opened in a real browser and its clearance cookie is reused for the download. `fileditchfiles.me/…` answers 500 to a plain request, so it is resolved through the player page (`fileditchvids.st`); the signed link lives ~26 minutes, so a fresh one is minted at fetch time |
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
   - `fileditch.st/{id}` / `theditch.st/{id}` / a bare `fileditchfiles.me/...` path → the
     page's `⬇ Download` anchor (a freshly signed link), with the player URL as a fallback
   - a URL that ends in a video extension → used directly
   - anything else → the page is fetched and scanned for a video URL
2. **Fetch it**, in whichever of these can reach the file:
   - the server downloads it itself (fastest),
   - `yt-dlp` extracts it for the platforms it supports,
   - or **your browser** fetches the bytes and streams them to the encoder.
   The name shown is the one on the page, not the one in the URL: a CDN that calls the file
   `e78f1c92-7cbd-4065-84a0-36d240d61814.mkv` while the page says `Kate Dalia - Lazy Day Off.mp4`
   gets the page's name, and `Content-Disposition` wins over both.
3. **Encode it** with libx264 (quality-first: slow-ish preset, low CRF, audio stream-copied
   when it is already AAC, never upscaled). A re-encode that would be bigger than the
   original is discarded and the original is shared instead.
4. **Upload it** to the first file host that accepts it and show the share link. If the
   server has no internet, your browser does the upload instead — gofile and pixeldrain both
   allow cross-origin requests, so this works even behind a locked-down network.

Everything runs in the background: create jobs, close the tab, come back for the link.

## Quality and size

The rule is simple: **the picture never gets worse, then the file gets smaller.** That is
enforced twice over.

**Two hard limits, for every preset and every automatic decision:**

- **CRF never goes above 26.** Past that, x264 stops discarding invisible detail and starts
  discarding visible detail. A 1080p file at CRF 34 *is* 1080p in name and looks like 480p —
  which is exactly what used to happen to files that could not be shrunk any other way.
- **The short side never drops below 720p.** When a file cannot be made smaller at full
  resolution inside the CRF limit, the encoder downscales to 720p *instead of* crushing the
  frame. Crisp 720p beats muddy 1080p, and it says so: `1920×1080 → 1280×720` on the job.

| Preset | Resolution | CRF | Ceiling | x264 preset |
| --- | --- | --- | --- | --- |
| **Recommended** *(default)* | up to 1080p | 23 | 26 | medium |
| Max quality | native | 19 | 21 | slow |
| High quality | native | 22 | 25 | medium |
| Smaller | up to 1080p | 24 | 26 | fast |
| Smallest | up to 720p | 26 | 26 | fast |

**Before encoding, the app measures.** Two 12-second slices are encoded at candidate settings
and scaled by duration, so the real encode starts with a CRF and a resolution that are known to
save at least 12%. The ladder is: preset CRF → CRF ceiling → 720p at preset CRF → 720p at the
ceiling; the first rung that saves enough wins. If no rung saves at least 5%, the file is not
encoded at all — it is copied through in seconds and the original is what gets shared, with a
note saying it was already as small as it can get without losing quality.

Measured on a 1080p 2 Mbps source that previously came out at CRF 34 looking like 480p: the new
path produced 1280×720 at CRF 24, 15% smaller, prediction within 0.5% of the real file.

Fixed-size requests ("fit in N MB") are still supported: the encoder runs two passes so the bits
land where the detail is. Audio is copied untouched whenever the source is already AAC under
192 kbps, so nothing is spent re-encoding it.

## What the page shows while a file is being made

Every file in the queue answers three questions without being clicked:

- **Where it came from.** The link itself, on its own line, clickable and opened in a new tab so
  the app keeps running.
- **What that link's browser tab says.** Not the name of the file that comes out of it — the
  `<title>` of the page the link points at, read while the link is resolved. That is the thing
  that is on screen when the link is opened, so it is the thing worth showing; for a direct
  `.mp4` URL the two are the same by definition.
- **How far along it is, and whether a restart would keep the work.** *Encoding part 5 of 12 —
  resumable* instead of a bare percentage.

The outputs keep their own naming rule (`Name small.mp4`, `Name 720p.mp4`), and the download route
carries that name in its URL so the browser's save dialog and any download manager agree with it.

## Just download it (no re-encoding)

Not every link needs a smaller file. Some hosts are fast from the server and slow from a
laptop, and the point is simply to get the bytes. *Skip the encoder → Just download it* in the
composer (or the same switch in the file picker) hands the original back untouched:

- Nothing is re-encoded. An MP4 is served exactly as it arrived; an MKV/MOV/WEBM is losslessly
  re-wrapped to MP4 (`-c copy`, `+faststart`) so it plays everywhere — not a single pixel is
  touched, and the job says so.
- The file keeps the host's real name and extension, and the media type is set from that
  extension rather than guessed.
- Disk need drops from ~2.2× the file to ~1.2×, because there is no encoder scratch space.
- It can still be uploaded to a host and still appears in the links panel, so a slow-source
  download also survives the machine stopping.
- **The decision can be taken late.** A slow encode is obvious a minute in, so the card of a
  file that is queued, downloading or being treated has its own **Just download it** button.
  Pressing it stops the encoder, keeps whatever has already been downloaded, and hands those
  bytes back (re-wrapping the container only when that is lossless). Nothing is restarted: the
  file goes straight on to a share link, and it says *Downloaded as-is* instead of
  *Compressed*.

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
| `KEEP_LOCAL_AFTER_UPLOAD` | off | Set `1` to keep the compressed file on disk after it is hosted |
| `SMTP_HOST` / `SMTP_PORT` | — / `587` | Mail server for the share links (`465` = implicit TLS) |
| `SMTP_USER` / `SMTP_PASS` | — | Login; for Gmail use an **app password**, spaces are ignored |
| `SMTP_FROM` | `SMTP_USER` | Envelope sender |
| `ENV_FILE` | `./.env` | Where the `.env` is read from |
| `NOTIFY_EMAIL` | `aaqwzsxedc272@gmail.com` | Where the links are mailed |
| `AUTO_EMAIL` | on | Mails the new links when the queue drains; `0` disables |
| `AUTO_PUBLISH` | on | Posts the links to the first working sink when the queue drains; `0` disables |
| `PUBLISH` | auto | `gist,webhook,ntfy,repo,paste` in the order you want; `off` disables |
| `PUBLISH_WEBHOOK` | — | JSON POST target (Discord, Slack, n8n, …); also settable on the page, which wins |
| `SEGMENTED` | on | `0` encodes every file in one piece (no resumable parts) |
| `SEGMENT_SECONDS` | auto | force a part length in seconds (auto: ~a twelfth of the file, 60–300 s) |
| `SEGMENT_MIN_SECONDS` | `240` | only files longer than this are encoded in parts |
| `PUBLISH_EVERY_SECONDS` | `60` | a finished file's link is posted this soon after it exists (batched); `0` waits for the queue to drain |
| `PUBLISH_NTFY` | — | ntfy topic for a phone notification |
| `PUBLISH_REPO` | off | `1` commits `LINKS.md` to the repo and pushes it |
| `PUBLISH_REPO_DIR` | this repo | where `LINKS.md` is committed |
| `PUBLISH_PASTE` | off | `1` posts the links to an anonymous paste service |
| `NTFY_URL` / `PASTE_URL` | `ntfy.sh` / `0x0.st` | Self-hosted alternatives |
| `BEFORE_STOP_TIMEOUT_SECONDS` | `45` | How long an auto-stop waits for the last mail to leave |
| `HOSTING_WAIT_SECONDS` | `900` | How long the queue waits for uploads before posting/mailing the links |
| `SIZE_PROBE_MS` | `7000` | Timeout for probing the size of files behind a link |

By default loopback, `169.254.169.254` and `metadata.google.internal` are refused, so the
app cannot be used to probe the box it runs on.

## Encoding notes

- Video: `libx264`, `-preset veryfast`, CRF 19–26 depending on preset (never above 26),
  `yuv420p`, `+faststart`
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
**Your links** panel holds every link. They are appended to `data/links.tsv` the moment a job is
hosted — an append-only ledger that no cleanup pass touches — so the list is still there after a
closed tab, a restarted server or a stopped machine. `GET /api/links` returns them as JSON,
`GET /api/links.txt` as plain text, and `npm run links` prints them from a terminal without
starting the server at all. Pick the host in *Upload to* (Auto, or a specific one); the choice is
remembered and sent with every job.

## Getting the link without watching the tab

Starting a queue and closing the laptop is the normal way to use this, so the links have to
leave the machine on their own:

- **The mail goes out when the queue drains** — the same moment auto-stop would take the page
  away. It lists every link hosted since the last mail with the size change
  (`508 MB → 341 MB (−33%) · on pixeldrain`), and `data/links.tsv` where the whole list lives.
  The upload runs *behind* the encoder, so "drained" waits for it: the links are only posted and
  mailed once they actually exist (up to `HOSTING_WAIT_SECONDS`).
- **Before the machine stops itself**, the mail is flushed first (the stop waits up to
  `BEFORE_STOP_TIMEOUT_SECONDS`), so `Stop the machine` cannot outrun it.
- **Email them to me** in the links panel sends the whole list on demand.
- Without SMTP the app does not pretend: the button opens a `mailto:` with every link already
  written into it, and the panel says mail is not set up.

### Set it up once, not on every run

There are two ways, and neither needs retyping an app password before each start.

**1. In the app (easiest).** The *Mail* panel under the links is a form: server, port, username,
app password, and the address to send to. **Save** stores it in `data/mail.json` (mode `0600`,
readable only by you), sends a test mail right away, and from then on every start uses it. It
survives restarts, a rebuilt Codespace and a fresh shell. **Send a test mail** and **Remove** are
next to it.

**2. In a `.env` file.** Copy `.env.example` to `.env` and fill it in; the server reads it at boot,
and a real environment variable still wins over it for deployments and Codespaces secrets.

```
# .env  (already gitignored)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=abcd efgh ijkl mnop     # Gmail app password, spaces are fine
NOTIFY_EMAIL=aaqwzsxedc272@gmail.com
```

Gmail needs an **app password**, not the account password: enable 2-step verification, create one
at <https://myaccount.google.com/apppasswords>. The same page is linked from the form.

Precedence is: `data/mail.json` → `.env` → real environment → built-in default (port 587, the
owner address). The boot log says which one is in force, so you never have to guess:

```
Mail: links go to aaqwzsxedc272@gmail.com via smtp.gmail.com:587 (saved in the app)
Loaded SMTP_HOST, SMTP_PASS from .env
```

A mail server on `127.0.0.1` (a local relay) needs `ALLOW_PRIVATE_HOSTS=1` — the app refuses
loopback by default so a public instance cannot probe its own network.

`npm run test:notify` runs a real SMTP conversation against a fake server (greeting, STARTTLS,
login, envelope, base64 body) — no account needed. `npm run test:mail` proves the one-time part:
`.env` parsing and precedence, `data/mail.json` surviving a restart with `0600` permissions and
never handing the password back, and a running server picking up new settings without a restart.

## Getting the links with no setup at all

Email is the most private route but needs an app password. If all you want is *the link,
somewhere you can read it*, there are cheaper ones. On every run — including the moment
auto-stop is about to take the machine away — the links are pushed to the first of these that
works, and each one needs either nothing or a single line:

| Route | Setup | You read it in |
| --- | --- | --- |
| console banner | none | the terminal, and `data/links.tsv` — always printed, always there |
| **GitHub gist** | none in a Codespace (`gh` is logged in) | a gist URL that never changes, updated in place |
| **webhook** | `PUBLISH_WEBHOOK=<url>` | Discord / Slack / n8n / your own server ([Discord, five clicks](#discord-in-five-clicks)) |
| **ntfy** | `PUBLISH_NTFY=<topic>` | a push notification on your phone, no account |
| **LINKS.md** | `PUBLISH_REPO=1` | your repository on GitHub, from any device |
| paste | `PUBLISH_PASTE=1` | an anonymous URL (`0x0.st`, `paste.rs`) |

The floor costs nothing and needs no configuration: every finished queue prints

```
────────────────────────────────────────────────────────────────
  2 share links ready
  The queue is finished.
────────────────────────────────────────────────────────────────
  Kate Dalia - Lazy Day Off.mp4
  https://pixeldrain.com/u/aaaaaaaaaaaa

  Also on the page (/api/links), in data/links.tsv and at /api/links.txt.
```

and they are on the page and in `data/links.tsv` either way. `npm run links` prints them from a
terminal without starting the server.

### Discord in five clicks

1. Open the Discord server (or make one just for this — a private server works).
2. Right-click the channel you want the links in → **Edit Channel** →
   **Integrations** → **Webhooks** → **New Webhook**.
   (On a server you own, *Server Settings* → *Integrations* → *Webhooks* works too.)
3. Click the new webhook → **Copy Webhook URL**. It looks like
   `https://discord.com/api/webhooks/1234567890/AbCdEf…`.
4. On the page, open **Post the links automatically** (under the links), paste the URL,
   press **Save**. It is stored in `data/publish.json` (mode `0600`) and a test message is
   sent straight away — if it appears in the channel, you are done. The page says
   *“Post the links to: Discord · https://discord.com/…”* from then on.

   Prefer a file? The same value works in `.env` as `PUBLISH_WEBHOOK=…`, or one run:
   `PUBLISH_WEBHOOK='https://discord.com/api/webhooks/…' npm start`.
5. That is it. Every finished queue posts by itself, and so does the moment before auto-stop;
   **Post them** next to the links does it on demand.

What lands in the channel is the same text as the console banner: one line per file with the
size change and the host, then the link:

```
The queue is finished.

Kate Dalia - Lazy Day Off.mp4 · 508 MB → 341 MB · on pixeldrain
https://pixeldrain.com/u/aaaaaaaaaaaa
```

Discord refuses messages over 2000 characters, so a long queue becomes several messages, split
between files so no link is ever cut; if there would be more than six, the last one says how many
were sent and where the full list is. Deleting the webhook in Discord makes the app say
`HTTP 400: Unknown Webhook` — the URL is a credential, so it is written only in `.env`
(never in the repository) and the app shows only `https://discord.com/…` when it reports which
sink it used.

The same line works for **Slack** (an incoming webhook URL), **n8n**, or any endpoint that accepts
a JSON `POST`; a non-Discord endpoint also gets a `links` array with the names, sizes and hosts.

The settings can also be saved from the page (**Post the links automatically**): a webhook URL,
an ntfy topic, or nothing. They land in `data/publish.json` with mode `0600`, are read on every
use so a save takes effect immediately, and the token is never returned by any endpoint — the API
and the page only ever show `https://discord.com/…`. **Send a test message** proves the channel
works before you rely on it.

`PUBLISH=gist,webhook` picks the sinks and their order; `PUBLISH=off` disables the step, as does
`AUTO_PUBLISH=0`. `GET /api/publish` reports which sinks this machine can actually use and the
last URL handed out; `POST /api/links/publish` does it on demand — that is the **Post them**
button next to the links.

A gist or a repo needs the token to carry the right permission; when it does not, the app says
exactly what GitHub answered (`HTTP 403: Resource not accessible by integration`) and moves on to
the next sink rather than pretending it published.

## When a host refuses

Some hosts answer a plain request with a challenge page instead of bytes — fileditch 403s,
filester runs DDoS-Guard, players hand out signed URLs. Those downloads are retried through the
headless browser: the page is opened for real, the media request it makes is observed (URL,
referer and cookie), and the bytes are fetched with exactly those headers. If that still fails the
job says so instead of pretending; the file can always be dropped on the page by hand.

**Cloudflare is a separate problem, and fileditch is behind it.** A challenge is not a 403 that
better headers fix: the page has to *run its JavaScript* and earn a `cf_clearance` cookie, and the
same cookie is then checked again when the video is requested. So a page fetch goes:

1. **A plain request with a browser's headers** (`sec-ch-ua`, `sec-fetch-*`, `accept-language`).
   Most pages answer it and cost nothing.
2. **A real browser** (`playwright`, optional) when the answer is a challenge — detected by
   `cf-mitigated: challenge`, a 403/503 from a Cloudflare front, or the interstitial's own text.
   Chromium runs the challenge, waits for the page to become the real page, and hands back the DOM
   **plus its cookie jar**. The resolver then mints the signed link from that DOM, and the download
   sends `cf_clearance` along with the request.
3. **An honest failure** if neither works: `That host answers with a Cloudflare browser check…`
   with the one command that fixes it, never "the file was removed" when it was not.

The browser is optional because it is ~150 MB of Chromium:

```bash
npm run browser:install      # npm install --no-save playwright && npx playwright install chromium
```

`/api/health` reports `browserAvailable`, so the page knows whether step 2 exists on this machine.

`npm run test:fallback` covers the observe-the-media path against a fake host that refuses plain
requests, and `npm run test:resolve` covers the Cloudflare path (challenge detected → browser
asked → cookie carried → and a normal page never costs a browser).

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

A video needs roughly **twice its own size** free while it encodes: the source, the output,
and the encoder's scratch files. A 4 GB 4K file therefore wants ~9 GB free (a *just download*
job needs ~1.2×, and never less than 512 MB).

- **Once a file is on the host, its local copy is deleted.** The share link is in `data/links.tsv`
  by then, so nothing is lost — the bytes already have a home. A 7 MB encode frees 7 MB the
  moment the upload finishes, and the app says how much it freed. Set
  `KEEP_LOCAL_AFTER_UPLOAD=1` to keep the local copies (handy when you want to download straight
  from the machine).
- **Deleting after upload is not the only reclaim.** Before a job starts, if the disk is tight,
  the oldest jobs that are already hosted are cleared to make room — again, only files whose
  links are already recorded.
- A failed job deletes its partial source and output immediately.
- Before a job starts the server checks free space and refuses (with the numbers) rather than
  dying half way through with `No space left on device`; the message names what can be freed.
- Downloading a file that was already deleted answers `410` with the share link instead of
  pretending the file is still there.
- `npm run disk` reports total/used/free and the largest jobs; `npm run disk -- --clean` deletes
  finished and failed jobs and the temp directory.
- `/api/health` returns `freeGb`, so a monitor can watch it.

GitHub Codespaces gives a 2-core machine **32 GB**, shared with `node_modules` (~150 MB),
Playwright's Chromium (~450 MB) and the OS. That is comfortable for 1080p work and tight for a
queue of 4K files: do them a few at a time.

## Closing the tab, and machines that stop

A job runs in the server process, not in the browser: the tab can be closed, the laptop shut, and
the encode carries on. Two things follow from that, and both are tested rather than promised:

- **A machine that stops is picked up on the next start, whatever stage it was in.** Each stage
  leaves something usable behind, and the boot routine uses it:

  | Stopped while | What is on disk | What happens on the next start |
  | --- | --- | --- |
  | downloading | a half-written `source` | the fragment is deleted and the file is fetched again, into the same job |
  | encoding | the whole `source`, **plus every part already encoded** | the encoder starts again on the *unfinished parts only* (see below) |
  | uploading | the finished `output.mp4` | it is uploaded again; the job is never marked failed |
  | done, posted | the ledger and the link | nothing to do — the link already works |

  The page says so too: a restart shows *“This machine stopped before, so 2 files were picked up
  where they left off”*, and each resumed card is tagged *picked up after a restart*. Set
  `RESUME_INTERRUPTED=0` to opt out.
### A long encode resumes where it stopped, not at the beginning

Restarting a two-hour encode from zero is the difference between "I lost ten minutes" and "I lost
an hour and a half", so a long file is not encoded in one piece:

- it is cut into **parts** (about twelve of them, between one and five minutes each) and every
  finished part is written to disk and recorded in `<job>/segments.json` the moment it is done;
- the parts are **video only**. Joining separately encoded AAC streams leaves a click at every
  seam, so the audio is encoded once, at the end, from the source — a couple of minutes for a
  two-hour film, and no drift;
- the last step **joins** the parts with `-c copy` (the video is not encoded a second time) and
  muxes the audio in. The joined file is probed before the parts are deleted: a join that lost a
  part fails loudly instead of handing back a short video.

A restart reads `segments.json`, keeps every part that is still on disk, and encodes only the rest.
The quality settings are **pinned in that file**, so a resumed job cannot re-decide its own CRF
halfway through a film — a different CRF in the middle of a file is visible as a shift. The card
says *Encoding part 5 of 12 — resumable*, and after a restart *Picking up where it stopped — 6 of
12 parts done*.

The cost is a couple of percent of file size (each part starts a fresh encode), which buys back
however long the machine had already spent. Short files (<4 min), `targetMb` jobs (two passes
cannot be split) and `SEGMENTED=0` keep the single-pass, whole-file encode.

- **The two things that can still be lost** are the encoder's *remaining* time (never the whole
  job) and a finished file that was never uploaded, if the container itself is deleted. GitHub
  Codespaces deletes a stopped codespace after 30 days; that is the only deadline that matters,
  and it is why the share links are posted and mailed as they finish.
- **The links outlive everything.** `data/links.tsv` is append-only, so the share links survive
  restarts, sweeps and a stopped machine, and the panel reads from it (`/api/links`) rather than
  from the job list, which is pruned.

`npm run test:durability` proves the first point end to end: it starts a job, never polls it,
kills the server, starts a fresh one on the same data directory, and finds the share link still
there. `npm run test:resume` kills the server mid-encode and checks the job finishes after the
restart. `npm run test:recover` covers the other two rows of that table — it cuts a real download
in half, restarts into a job left mid-upload, presses *Just download it* on a running encode, and
checks that the first link is posted while the second file is still being worked on.

**Links leave as soon as they exist.** The queue-drained post is the tidy summary, but a file that
has a share link is posted a minute later, in a small batch of its own (`PUBLISH_EVERY_SECONDS`,
`0` turns it off). If the machine's minutes run out halfway through a queue, the links for the
files it already treated are already in Discord — they are not waiting for a summary that will
never be sent.

### Codespaces minutes, and what running out means

The free plan is **120 core-hours a month** — 60 hours of a 2-core codespace — plus 15 GB-months
of storage, and there is no weekly limit. The idle timeout is 30 minutes by default (settable up
to 240); a running encode keeps the machine awake on its own (see below), so the meter is really
"how long do you leave it up".

- **Do not worry about a long encode being cut off.** It is resumed from its source on the next
  start, and the links you already have keep working meanwhile.
- **Do worry about leaving it running.** A forgotten codespace burns core-hours; *Stop the machine
  when done* ends the run right after the queue and its links are posted.
- **When the minutes are gone**, the codespace stops and cannot be started again until the month
  resets (or a payment method is added for overage at $0.18/core-hour). The container's disk —
  and therefore `data/`, the queue, and the links — survives that stop, so the next start resumes
  as described above. What does *not* survive is the codespace being deleted (30 days after it was
  last stopped), which is the one case where an unposted file is lost.

## Long jobs and idle hosts

Cloud hosts stop an idle machine, which can cut a two-hour encode in half. Three defences:

- A job that was running when the machine stopped is resumed on the next start (see above), so an
  interrupted encode costs time, not the whole job.

- The server prints a `[keep-alive] <job> 42% · 12m left` line to its terminal every 45 seconds
  while anything is fetching, encoding or uploading. GitHub Codespaces counts terminal output as
  activity, so the machine stays awake on its own. Turn it down or off with
  `HEARTBEAT_SECONDS=0`.
- `./scripts/keepalive.sh` does the same from a second terminal, for any host that measures
  activity differently.

## Testing

- `npm run test:resolve` — 34 resolver tests against stubbed APIs (real response shapes),
  including the three URL shapes a fileditch page hands out and the Cloudflare path,
  including the page-title naming rule and fileditch's minted-link/player routes.
- `npm run test:hosters` — 9 uploader tests: streamed multipart/raw bodies match their
  declared Content-Length, refusal handling, size-limit skipping and the fallback chain.
- `npm run test:estimate` — the quality rules and the size prediction: a dense 1080p file is
  never encoded above CRF 26 and never below 720p, it downscales instead of being crushed, every
  preset stays inside both limits, a hopeless file is recognised instead of being encoded anyway,
  and the projection lands within 25% of a real encode.
- `npm run test:encode` — an MKV whose audio the MP4 muxer refuses: the normal plan fails, the
  forgiving retry succeeds, and the error carries the one ffmpeg line a person can act on.
- `npm run test:ledger` — share links survive a restart, duplicates and mangled names.
- `npm run test:notify` — a full SMTP conversation against a fake server: login, envelope,
  base64 body, the `mailto:` fallback and a refused password.
- `npm run test:publish` — 64 checks over the no-setup routes: the console floor, a gist created once and
  updated afterwards (URL stays the same), a token that cannot make gists reported honestly,
  webhook/ntfy/paste payloads, `LINKS.md` committed and pushed to a real (throwaway) remote, and
  `PUBLISH=off` publishing nothing. The `gh` binary is faked, so no account is needed.
- `npm run test:mail` — the one-time mail setup: `.env` parsing and precedence, `data/mail.json`
  surviving a restart with `0600` permissions, the password never returned, and a running server
  sending a test mail the moment the form is saved.
- `npm run test:ui` — the browser code in jsdom: the disk pill, the presets, "just download"
  greying the encoder controls, the size list in the picker, the per-picker switch sending
  `noCompress`, the email button, the webhook panel, and a running job's card showing its link,
  the name its browser tab will carry, and its own "Just download it" button (needs
  `npm i --no-save jsdom`, skips without it).
- `npm run test:space` — the space policy end to end: a hosted job's files are deleted,
  the link survives, the download route answers `410`, and `KEEP_LOCAL_AFTER_UPLOAD=1` keeps
  everything.
- `npm run test:durability` — a job finishes with nobody watching, and its link survives the
  server being killed and restarted.
- `npm run test:resume` — an encode killed at 6% finishes after a restart (takes ~5 minutes).
- `npm run test:segments` — 18 checks: the parts cover the file exactly, a real encode is killed
  mid-way, the parts from before the crash are reused (their mtimes prove it), and the joined
  file is as long as the source with its audio.
- `npm run test:recover` — 26 checks: a download cut in half resumes, a job left mid-upload is
  uploaded again, "just download it" pressed mid-encode returns the original byte for byte, and a
  finished file's link is posted before the queue has drained.
- `npm run smoke` — 61 end-to-end checks: sample, upload, browser relay, target size, range
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
