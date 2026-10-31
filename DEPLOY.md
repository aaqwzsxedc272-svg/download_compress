# Deploying Squeeze for free, in the cloud, without a card

Squeeze needs three things from a host: **outbound internet** (to fetch your links and upload
the result), **CPU to encode video**, and **staying up when you are not watching**. In 2026 the
free-without-a-card tier gives you the first two and only partly the third. This page is honest
about that and tells you which button to press.

> **No Hugging Face.** Since July 2026 the Hub requires a paid plan to *create* anything that
> runs compute: _"Static Spaces are free for everyone. Gradio and Docker Spaces run on compute
> and require a paid plan to create: PRO for personal accounts, Team or Enterprise for
> organizations."_ ([spaces-overview](https://huggingface.co/docs/hub/spaces-overview)). The
> `deploy-space.sh` script here still works, but only with HF PRO ($9/mo).

---

## Routes that cost nothing and ask for no card

| Route | CPU | Sleeps? | "Link in, share link out" |
| --- | --- | --- | --- |
| **Render free** (recommended) | 0.1 vCPU, 512 MB | after 15 min idle — fixable, see below | yes, fully server-side |
| **SnapDeploy free** | 0.25 vCPU, 512 MB | after 15 min idle, 100 h/month | yes, fully server-side |
| **GitHub Codespaces** | 2 vCPU, 8 GB | when the session closes | yes, while open |
| Your own machine + tunnel | all of it | when the PC goes off | yes |

Everything that used to be free now wants a card: Fly.io, Koyeb ($29 hold), Google Cloud Run,
Oracle Always Free, Railway's paid plans. Hugging Face wants PRO.

**Render free is the one that answers your requirement** — free, no card, no Dockerfile, lives
in the cloud, keeps working after you close the tab.

---

## 1. Render — free, no card, no Docker

`render.yaml` is already configured: free plan, `runtime: node`, `npm ci --omit=dev` then
`npm start`, health check on `/api/health`.

### Steps (all in a browser, about two minutes)

1. Make sure this branch is merged into `main` — Render deploys `main`.
2. Sign up at <https://render.com> with **GitHub** (no card field on the free path).
3. **New → Blueprint**, pick the `download_compress` repo. Render reads `render.yaml` and shows
   one web service on the **Free** plan. Press **Apply / Deploy**.
4. Watch the build (~2 min). You get `https://squeeze-xxxx.onrender.com`.
5. Open it, paste a link, pick a preset, press **Compress**. The job keeps running on Render
   after you close the tab.

### Keep it awake for free

Render spins a free service down after 15 minutes without traffic. `.github/workflows/keepalive.yml`
in this repo pings `/api/health` every 10 minutes using **GitHub's own scheduler** — no third-party
account, no card:

1. Repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**
2. Name `SQUEEZE_URL`, value `https://squeeze-xxxx.onrender.com`
3. Actions tab → *keep-alive* → **Run workflow** once to confirm it is green.

750 free instance hours a month is 744 hours — one service at 24/7 fits, barely. If you would
rather not ping, the service simply cold-starts (~60 s) on your next visit.

### Living with 0.1 vCPU

| Preset | Reality on Render free |
| --- | --- |
| `max`, `high` | only for short clips — a 10-minute 1080p video is hours |
| `balanced` | the sensible default here |
| `small`, `tiny` | fast enough for long videos |

`MAX_UPLOAD_MB=700` and `MAX_CONCURRENT=1` are already set in `render.yaml`: more than that and
the 512 MB container gets killed mid-encode.

---

## 2. SnapDeploy — same idea, 2.5× the CPU, still no card

<https://snapdeploy.dev> runs Docker containers on AWS Fargate. Free tier: **4 containers,
512 MB / 0.25 vCPU, 100 running hours a month, no card, no expiry**, sleeping after 15 minutes
idle and waking on the next visit. The `Dockerfile` in this repo works unchanged.

1. Sign up with GitHub or email (no card).
2. **New container → GitHub repo → this repo**, small container.
3. Set `MAX_UPLOAD_MB=700`, `MAX_CONCURRENT=1`, `DATA_DIR=/data`.
4. Deploy; you get `https://<name>.containers.snapdeploy.app`.

100 hours a month is roughly four hours a day of uptime — fine for occasional use, not a
permanent link.

---

## 3. GitHub Codespaces — 2 vCPU, no card, no signup beyond GitHub

Unchanged from what ships in the repo: open the repo → **Code → Codespaces → Create**, the
`.devcontainer` installs dependencies and starts the server, then **Ports → 3000 → Public**.
Best for "one big file today", not for a permanent URL.

---

## 4. Your own computer + a free tunnel

```bash
npm install && npm start          # http://localhost:3000
npx cloudflared tunnel --url http://localhost:3000
```

Free, no account, real CPU. Only route where `high` on a long video is quick.

---

## Verify any deployment in one command

```bash
node scripts/verify-deploy.js https://squeeze-xxxx.onrender.com --preset tiny
```

Checks the app answers, presets are served, hosters configured, yt-dlp present (advisory),
outbound internet works (advisory), a real link resolves, a real video compresses smaller, a
share link is created, and **that share link is publicly downloadable**. Exits non-zero only on
real failures; `--keep` keeps the uploaded test file. Use `--preset tiny` on the free tier so
the test finishes fast.

---

## What each host can actually fetch

| Host | Needs server internet? | Works with browser only? |
| --- | --- | --- |
| gofile.io | yes, for the folder listing and bytes | **yes** — CORS is open |
| pixeldrain.com | no | **yes** — CORS is open |
| turbo.cr | yes | no — CDN sends no CORS headers |
| bunkr | yes | no — Cloudflare-protected |
| filester.me | yes | no — DDoS-Guard protected |

Render and SnapDeploy both give the server real internet, so every row works. Open
`/diagnostics` on the deployed app to confirm which rows pass on that host.
