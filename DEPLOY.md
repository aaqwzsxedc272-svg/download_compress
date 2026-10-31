# Deploying Squeeze for free

The whole point of Squeeze is that it fetches a link, compresses the video and uploads the
result to a free hoster by itself. That needs a machine with **real outbound internet**.
Hugging Face Spaces gives you exactly that, free, with no credit card — and the repo ships a
script that does the whole deployment in one command.

---

## 1. Hugging Face Spaces — one command, free, no card

Free CPU Spaces run Docker, have full internet, 16 GB RAM and 50 GB of disk. That is enough
for server-side gofile / pixeldrain / turbo / bunkr / filester fetching *and* for uploading the
result back to a hoster.

1. Create a free account at <https://huggingface.co>.
2. Create an access token with **write** scope: <https://huggingface.co/settings/tokens>.
3. From this repo:

   ```bash
   HF_TOKEN=hf_xxx ./scripts/deploy-space.sh <your-hf-username> [space-name]
   ```

That is the whole deployment. The script:

- builds a slim bundle into `dist/hf-space` (`scripts/package-space.js`),
- creates the Space through the HF API if it does not exist yet,
- pushes the Docker app to it.

When it finishes it prints the URL and the verification command:

```
App          https://<user>-<space>.hf.space
Diagnostics  https://<user>-<space>.hf.space/diagnostics

Verify it once the build finishes:
  node scripts/verify-deploy.js https://<user>-<space>.hf.space
```

The Space builds for a few minutes on the first push. Re-running the script is safe — it
rebuilds the bundle and force-pushes, which triggers a fresh build.

### Confirm it actually works

`scripts/verify-deploy.js` is an end-to-end check you can point at any deployment:

```bash
node scripts/verify-deploy.js https://<user>-<space>.hf.space --preset tiny
```

It checks, in order: the app answers, the quality presets are there, the hosters are
configured, yt-dlp is present (advisory), the container can reach the internet (advisory),
a real link resolves, a real video compresses to a smaller file, a share link is created, and
**that share link is publicly downloadable**. It exits non-zero only on real failures, so it
is safe to use in CI. Add `--keep` to leave the uploaded test file in place.

### No terminal? Do it entirely in the browser

1. Open <https://huggingface.co/new-space>, pick **Docker** → **Blank**, hardware
   **CPU basic (free)**, and create it. The Space arrives with a `README.md` that already has
   the `sdk: docker` / `app_port: 3000` front matter — keep it, do not overwrite it.
2. On GitHub, open the repo → **Code → Download ZIP**, then unzip it.
3. In the Space, open **Files → Add file → Upload files** and drag in `Dockerfile`,
   `.dockerignore`, `package.json`, `package-lock.json`, and the `server/`, `public/` and
   `shared/` folders from the unzipped repo. The uploader keeps folder paths.
4. Commit. The Space builds itself and serves the app at `https://<user>-<space>.hf.space`.
   Push later changes the same way, or connect the one-command script once you have a token.

### Space settings that matter

| Setting | Value |
| --- | --- |
| SDK | Docker |
| App port | `3000` (already in the generated `README.md` front matter) |
| Hardware | CPU basic — free |
| Persistent storage | optional; without it `/data` is wiped on rebuild, which is fine |

`DATA_DIR=/data` keeps job history across rebuilds if you attach storage; otherwise Squeeze
only keeps files for a few hours anyway. The container runs as the non-root `node` user and
owns `/data`.

---

## 2. Oracle Cloud "Always Free" — a real VM, free forever

24 GB RAM and a real network, free forever. A card is required for identity verification, but
the Ampere/AMD always-free shapes are not charged.

```bash
sudo apt update && sudo apt install -y docker.io
git clone https://github.com/aaqwzsxedc272-svg/download_compress
cd download_compress
sudo docker build -t squeeze .
sudo docker run -d --restart=always -p 80:3000 -v squeeze-data:/data --name squeeze squeeze
```

Open port 80 in the OCI security list and you are live at `http://<your-vm-ip>`. RAM this
generous means `MAX_CONCURRENT=2` or `3` is comfortable.

---

## 3. Render

`render.yaml` in this repo is ready. Free instances have **no disk** and 512 MB RAM, so:

- links still work (full internet),
- keep `MAX_UPLOAD_MB` low (e.g. `600`) and expect slow encodes on big files,
- a Starter instance (paid) is what the repo defaults to, with a 10 GB disk.

---

## 4. Koyeb / Railway / Fly.io

All have trial or hobby tiers. Docker deploys work unchanged:

```bash
docker build -t squeeze .
# push to any registry, then create the service with DATA_DIR=/data and a volume
```

Or use the shipped compose file:

```bash
docker compose up -d --build
```

---

## 5. Zero sign-up: run it on your own machine and share it

Free, instant, full internet:

```bash
npm install
npm start                       # http://localhost:3000
# in another terminal, expose it publicly with a free tunnel:
npx cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a `https://*.trycloudflare.com` URL that works from any device. Your machine
does the fetching and encoding; nothing is deployed and there is no account to cancel.

---

## What each option can actually fetch

| Host | Needs server internet? | Works with browser only? |
| --- | --- | --- |
| gofile.io | yes, for the folder listing and bytes | **yes** — CORS is open |
| pixeldrain.com | no | **yes** — CORS is open |
| turbo.cr | yes | no — CDN sends no CORS headers |
| bunkr | yes | no — Cloudflare-protected |
| filester.me | yes | no — DDoS-Guard protected |

Open `/diagnostics` on the deployed app to confirm which rows pass on that host.
