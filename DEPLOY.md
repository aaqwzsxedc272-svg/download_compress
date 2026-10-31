# Deploying Squeeze for free

You need a machine with **real internet access** for `gofile`, `turbo.cr`, `bunkr` and
`filester.me` links to resolve server-side. These are the free options, best first.

---

## 1. Oracle Cloud "Always Free" — best free option

A real VM with 24 GB RAM, real network access, free forever (a card is required for identity
verification, but the Ampere/AMD always-free shapes are not charged).

```bash
# On the VM (Ubuntu):
sudo apt update && sudo apt install -y docker.io
git clone https://github.com/aaqwzsxedc272-svg/download_compress
cd download_compress
sudo docker build -t squeeze .
sudo docker run -d --restart=always -p 80:3000 -v squeeze-data:/data --name squeeze squeeze
```

Open port 80 in the OCI security list and you are live at `http://<your-vm-ip>`.
RAM this generous means `MAX_CONCURRENT=2` or `3` is comfortable.

---

## 2. Hugging Face Spaces — free, no card, 16 GB RAM, 50 GB disk

Free CPU Spaces run Docker, have real internet, and stay up (they sleep after long
inactivity but wake on the first request).

1. Create a free account at <https://huggingface.co>.
2. **New Space** → SDK: **Docker** → template: **Blank** → hardware: **CPU basic (free)**.
3. Copy this repo's files into the Space repository (or connect the GitHub repo in the
   Space settings). Keep the `Dockerfile`.
4. The Space needs a `README.md` with these four lines at the very top:

   ```yaml
   ---
   title: Squeeze
   sdk: docker
   app_port: 3000
   ---
   ```

5. Commit. The Space builds and serves the app at `https://<user>-<space>.hf.space`.

Use `/data` for `DATA_DIR` if you mount persistent storage; otherwise the working directory is
wiped when the Space rebuilds, which is fine because Squeeze only keeps files for hours.

---

## 3. Render — free web service

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

---

## 5. Zero sign-up: run it on your own machine and share it

If you only need this for yourself, this is free, instant, and has full internet:

```bash
npm install
npm start                       # http://localhost:3000
# in another terminal, expose it publicly with a free tunnel:
npx cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a `https://*.trycloudflare.com` URL that works from any device. Your machine
does the fetching and encoding; nothing is deployed and there is no account to cancel.
Close the terminal and it is gone.

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
