# Deploying Squeeze for free, in the cloud, without a card

Squeeze needs three things from a host: **outbound internet** (to fetch your links and upload
the result), **CPU to encode video**, and **staying up when you are not watching**. In late 2026
the free-without-a-card tier gives you the first two and only partly the third. This page says
what is actually true right now and what to press.

## What died, so nobody wastes another evening

| Host | Status |
| --- | --- |
| **Hugging Face Spaces** | since July 2026 creating *any* Space that runs compute (Gradio or Docker) needs a paid plan — [docs](https://huggingface.co/docs/hub/spaces-overview): *"Static Spaces are free for everyone… requires a paid plan to create: PRO"* |
| **Render** | its docs still say no card, but new accounts are stopped at a payment step when creating a web service |
| **Zeabur** | shutting down — no new sign-ups; everything stops Dec 31, 2026 ([announcement](https://zeabur.com/blogs/zeabur-is-shutting-down)) |
| **Koyeb / Fly.io / Cloud Run / Oracle** | card required (Koyeb asks for a $29 hold) |

## Card-free routes that still exist

| Route | CPU / RAM | Card | Shape |
| --- | --- | --- | --- |
| **SnapDeploy** | 0.25 vCPU / 512 MB | no | real website, sleeps when idle, 100 h/month |
| **GitHub Codespaces** | 2 vCPU / 8 GB | no | a session you open; best CPU by far |
| **Back4App Containers** | 0.25 vCPU / 256 MB | no | permanent, but a demo-sized box |
| Your own machine + tunnel | all of it | no | fastest, but the PC must stay on |

---

## 1. SnapDeploy — free, no card, a real website

<https://snapdeploy.dev> runs Docker containers on AWS Fargate. Free tier: **4 containers,
512 MB / 0.25 vCPU, 100 running hours a month, 10 deploys a day, no card, no expiry.** It sleeps
after 15 minutes idle and wakes on the next visit.

1. Sign up with GitHub or email (no card).
2. **New container → GitHub repo → this repo**; it builds the `Dockerfile` unchanged.
3. Environment: `MAX_UPLOAD_MB=1600`, `MAX_CONCURRENT=1`, `DATA_DIR=/data`.
4. **Deploy** → you get `https://<name>.containers.snapdeploy.app`. Paste, compress, close the tab.

100 hours a month is about three hours a day of uptime, so treat it as a personal tool, not a
public service. With 512 MB and a quarter core, `small`/`tiny` are the sane presets for anything
long; `balanced` for short clips.

---

## 2. GitHub Codespaces — 2 vCPU, 8 GB, no card, works today

The most capable free option, and the one thing that cannot be shut down under you, because you
already own the account. It is a session rather than a permanent site: you open it when you need
it, and it stops when it idles out.

1. Open the repo on GitHub → **Code → Codespaces → Create codespace on main**.
2. The `.devcontainer` here installs dependencies and starts the server on port 3000.
3. **Ports** tab → right-click 3000 → **Port Visibility → Public** → open the forwarded URL.
4. Settings → Codespaces → idle timeout **240 minutes**, so a long encode is not cut off.

Free personal accounts get a monthly quota (60 hours on the 2-core machine). At 2 vCPU the
`high` preset is genuinely pleasant.

---

## 3. Back4App Containers — free forever, but only 256 MB

<https://www.back4app.com/containers> gives one container, 0.25 CPU, 256 MB RAM and 100 GB of
transfer, free forever, no card (their signup page says so).

1. Sign up with GitHub → **New container → GitHub repo → this repo**; it builds the
   `Dockerfile` unchanged.
2. Set `MAX_UPLOAD_MB=250`, keep `MAX_CONCURRENT=1`, use `tiny`/`small` only — 256 MB will not
   survive a 1080p encode.
3. Their free container stops after 60 minutes per deploy, so it is a demo host, not a home.

---

## 4. Your own computer + a free tunnel

```bash
npm install && npm start          # http://localhost:3000
npx cloudflared tunnel --url http://localhost:3000
```

Free, no account, real CPU. The only route where `high` on a long video is quick. Works from a
laptop, a home NAS or a Raspberry Pi 4/5 with Node 18+.

---

## Appendix — if you already have a paid account

- **Hugging Face PRO**: `HF_TOKEN=hf_xxx ./scripts/deploy-space.sh <user> [space]` builds a
  Space bundle (`scripts/package-space.js`), creates the Space through the API and pushes it.
- **Render, if it does not ask you for a card**: `render.yaml` is a free-plan blueprint on the
  Node runtime, and `.github/workflows/keepalive.yml` pings `/api/health` every 10 minutes so an
  idle instance never sleeps.

---

## Verify any deployment in one command

```bash
node scripts/verify-deploy.js https://your-app.example --preset tiny
```

Checks the app answers, presets are served, hosters are configured, yt-dlp is present
(advisory), outbound internet works (advisory), a real link resolves, a real video compresses
smaller, a share link is created, and **that share link is publicly downloadable**. Exits
non-zero only on real failures; `--keep` keeps the uploaded test file. On a small free box use
`--preset tiny` so the test finishes quickly.

---

## What each host can actually fetch

| Host | Needs server internet? | Works with browser only? |
| --- | --- | --- |
| gofile.io | yes, for the folder listing and bytes | **yes** — CORS is open |
| pixeldrain.com | no | **yes** — CORS is open |
| turbo.cr | yes | no — CDN sends no CORS headers |
| bunkr | yes | no — Cloudflare-protected |
| filester.me | yes | no — DDoS-Guard protected |

Every route above gives the server real internet, so all rows work. Open `/diagnostics` on the
deployed app to confirm which rows pass on that host.
