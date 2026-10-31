# Deploying Squeeze for free

Squeeze wants three things from a host: **outbound internet** (to fetch your links and upload
the result), **enough CPU to encode video**, and **staying up without you watching it**.
No free-without-a-card host gives all three generously — so pick the trade-off you can live
with. This page is honest about each one.

> **Hugging Face Spaces is no longer free for this.** Since July 2026 the Hub requires a paid
> plan to *create* anything that runs compute: _"Static Spaces are free for everyone. Gradio and
> Docker Spaces run on compute and require a paid plan to create: PRO for personal accounts,
> Team or Enterprise for organizations."_ ([spaces-overview](https://huggingface.co/docs/hub/spaces-overview)).
> The `deploy-space.sh` script in this repo still works, but it needs HF PRO ($9/mo). The free
> routes below do not.

---

## Comparison

| Route | Card? | Internet | CPU | Stays up | Best for |
| --- | --- | --- | --- | --- | --- |
| [Render free](#1-render--free-no-card-no-docker) | no | yes | 0.1 vCPU | sleeps after 15 min idle (defeatable) | always-there URL, small files |
| [Your own PC + tunnel](#2-your-own-computer--a-free-tunnel) | no | yes | all of it | while the PC is on | big files, best quality, fastest |
| [GitHub Codespaces](#3-github-codespaces--free-quota) | no | yes | 2 vCPU | while the session runs | a few big jobs without installing anything |
| [HF Spaces (PRO)](#4-if-you-already-have-hugging-face-pro) | $9/mo | yes | 2 vCPU | sleeps after 48 h idle | set-and-forget if you already pay |

**Recommendation:** if your computer can stay on, use route 2 — it is free and it is the only
one with enough CPU for the quality you asked for. If it cannot, route 1 gives you a permanent
URL that handles short and medium videos, just slowly.

---

## 1. Render — free, no card, no Docker

`render.yaml` at the repo root is already configured for Render's **free** plan on the **Node**
runtime: `npm ci --omit=dev`, then `npm start`. No container, no Dockerfile, no card.

1. Free account at <https://render.com> (sign in with GitHub).
2. **New → Blueprint**, pick this GitHub repo. Render reads `render.yaml` and creates the
   service on the free plan.
3. Wait for the build; you get `https://squeeze-xxxx.onrender.com`.

Real limits of the free plan, and what the yaml already does about them:

| Limit | What it means | Mitigation shipped |
| --- | --- | --- |
| 0.1 CPU, 512 MB RAM | encodes run far slower than realtime; big sources get OOM-killed | `MAX_UPLOAD_MB=700`, `MAX_CONCURRENT=1` |
| Sleeps after 15 min with no traffic | a job started and then abandoned can be cut off | point a free pinger at `/api/health` every 5 min — see below |
| No persistent disk | working files vanish on restart (they are temporary anyway) | files stream to the hoster as soon as the job ends |
| 750 instance hours / month | one service at 744 h/mo fits exactly | keep it to one service |

**Keeping it awake, free:** create a monitor at <https://uptimerobot.com> (free, no card) or
<https://cron-job.org> pointing at `https://squeeze-xxxx.onrender.com/api/health` every
5 minutes. That counts as traffic, so the service stays up, and 5-minute pings fit inside the
750 free hours. With the pinger running you can paste a link, close the tab, and come back.

**Pick a faster preset here.** At 0.1 vCPU, `high` on a long 1080p video will feel glacial.
`balanced` or `small` is the sane choice on this host; `tiny` for anything long.

---

## 2. Your own computer + a free tunnel

Free, instant, no card, and the only option with real CPU — the quality presets mean what they
say here.

```bash
npm install
npm start                       # http://localhost:3000
# in another terminal, expose it publicly with a free tunnel:
npx cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a `https://*.trycloudflare.com` URL that works from any device, including
your phone. Your machine does the fetching, encoding and uploading; nothing is deployed and
there is no account to cancel. Close the terminal and it is gone.

To keep it running after you close the terminal:

```bash
nohup npm start > squeeze.log 2>&1 &
```

and start it the same way after a reboot (or use `pm2`). It also works on a home NAS or a
Raspberry Pi 4/5 with Node 18+ installed — slow, but always on.

---

## 3. GitHub Codespaces — free quota

No card, 2 vCPU and 8 GB RAM, real internet, and it runs this repo unchanged.

1. Open the repo on GitHub → **Code → Codespaces → Create codespace on main**.
2. The `.devcontainer` config installs dependencies and starts the server for you.
3. In the **Ports** tab, right-click port 3000 → **Port Visibility → Public**. The forwarded
   `https://<name>-3000.app.github.dev` URL is your app.

Free personal accounts get a monthly Codespaces quota (the 2-core machine burns it at 1× 
core-hour). The codespace stops after ~30 min of inactivity, so this suits "a few big jobs
today", not a permanent link.

---

## 4. If you already have Hugging Face PRO

Then a Space is the nicest set-and-forget option (2 vCPU, 16 GB RAM, sleeps after 48 h idle):

```bash
HF_TOKEN=hf_xxx ./scripts/deploy-space.sh <your-hf-username> [space-name]
```

It builds a slim bundle, creates the Space through the API, pushes it, and prints the URL. Then:

```bash
node scripts/verify-deploy.js https://<user>-<space>.hf.space
```

---

## How to check any deployment actually works

`scripts/verify-deploy.js` tests a live URL from the outside and exits non-zero only on real
failures:

```bash
node scripts/verify-deploy.js https://your-app.onrender.com --preset tiny
```

It checks the app answers, the presets are served, hosters are configured, yt-dlp is present
(advisory), the container can reach the internet (advisory), a real link resolves, a real video
compresses to a smaller file, a share link is created, and **that share link is publicly
downloadable**. `--keep` leaves the uploaded test file in place.

---

## What each host can actually fetch

| Host | Needs server internet? | Works with browser only? |
| --- | --- | --- |
| gofile.io | yes, for the folder listing and bytes | **yes** — CORS is open |
| pixeldrain.com | no | **yes** — CORS is open |
| turbo.cr | yes | no — CDN sends no CORS headers |
| bunkr | yes | no — Cloudflare-protected |
| filester.me | yes | no — DDoS-Guard protected |

All four routes above give the server real internet, so every row works once deployed. Open
`/diagnostics` on the deployed app to confirm which rows pass on that host.
