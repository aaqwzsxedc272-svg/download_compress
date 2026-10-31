# Deploying Squeeze for free, in the cloud, without a card

Squeeze needs three things from a host: **outbound internet** (to fetch your links and upload
the result), **CPU to encode video**, and **staying up when you are not watching**. In 2026 the
free-without-a-card tier gives you the first two and only partly the third. This page is honest
about that and tells you which button to press.

> **Hugging Face is out.** Since July 2026 the Hub requires a paid plan to *create* anything
> that runs compute: _"Static Spaces are free for everyone. Gradio and Docker Spaces run on
> compute and require a paid plan to create: PRO for personal accounts, Team or Enterprise for
> organizations."_ ([spaces-overview](https://huggingface.co/docs/hub/spaces-overview)).
>
> **Render is out too, in practice.** Its docs still say the free plan needs no card, but new
> accounts are stopped by a payment step when creating a web service (October 2026).

---

## Card-free routes, best first

| Route | CPU / RAM | Card | Notes |
| --- | --- | --- | --- |
| **Zeabur free trial** | up to 1 vCPU / 2 GB | no | $5/month credit, auto-sleep, GitHub login |
| **Back4App Containers** (<https://www.back4app.com/containers>) is the other card-free option:
one container, 0.25 CPU, 256 MB RAM, 100 GB transfer, free forever, and their own signup page
says *no credit card required*.

1. Sign up with GitHub, then **New container → GitHub repo → this repo**; it builds from the
   `Dockerfile` unchanged.
2. Set `MAX_UPLOAD_MB=250` and stick to `tiny`/`small` — 256 MB will not survive a 1080p encode.
3. Their free container stops after 60 minutes per deploy, so treat it as a demo host.

**SnapDeploy** | 0.25 vCPU / 512 MB | no | 100 running hours a month |
| **GitHub Codespaces** | 2 vCPU / 8 GB | no | only while the session is open |
| Your own machine + tunnel | all of it | no | fastest, but the PC must stay on |

Zeabur is the only one that gives a real vCPU and a real 2 GB of RAM without a card, so it is
the recommendation for "best quality while keeping quality".

---

## 1. Zeabur — free, no card, up to 1 vCPU / 2 GB

The repo already has a working `Dockerfile`, so there is nothing to configure.

1. Merge the open PR into `main` — Zeabur deploys whatever branch you pick, `main` by default.
2. Sign in at <https://zeabur.com> with **GitHub** (no card for the free trial plan).
3. **Create Project** → pick a free region → **Add Service → GitHub** → choose
   `download_compress`. Zeabur detects the `Dockerfile` and builds it.
4. In the service's **Networking** tab, click **Generate Domain**. That URL is your app.
5. Open it, paste a link, pick a preset, press **Compress**, close the tab.

Free-trial facts that matter:

| Limit | Reality |
| --- | --- |
| $5 credit per month | plenty if the service sleeps between jobs; heavy 24/7 use will burn it |
| max 1 vCPU / 2 GB per service | choose 1000m CPU / 2048 MB in the service settings |
| auto-sleep when idle | the next visit cold-starts in a few seconds; a running job keeps it awake |
| no SLA | fine for personal use |

Recommended service settings: `MAX_CONCURRENT=1`, `MAX_UPLOAD_MB=1800` (2 GB of RAM handles
that), `DATA_DIR=/data`.

At 1 vCPU the `high` preset is usable on normal clips; `balanced` is the sweet spot for long
ones.

---

## 2. Back4App and SnapDeploy — smaller, but card-free forever

**Back4App Containers** (<https://www.back4app.com/containers>) is the other card-free
option: one container, 0.25 CPU, 256 MB RAM, 100 GB transfer, free forever.",
  "Sign up with GitHub — their own signup page says *no credit card required*. New container →
  GitHub repo → this repo → build from the `Dockerfile`. Set `MAX_UPLOAD_MB=250` and keep the
  `tiny`/`small` presets: 256 MB will not survive a 1080p encode. Their free container is also
  capped at 60 minutes per deploy, so it is a demo host, not a home.

**SnapDeploy** (<https://snapdeploy.dev>) runs Docker containers on AWS Fargate. Free tier: **4 containers,
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

## Appendix: Render, if your account is not asked for a card

`render.yaml` is still in the repo (free plan, `runtime: node`, no Dockerfile) and
`.github/workflows/keepalive.yml` keeps an idle instance from sleeping. New accounts are
stopped by a payment step, so treat this as a fallback only.

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
