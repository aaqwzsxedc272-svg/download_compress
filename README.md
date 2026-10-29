# Clipwell

A web app that downloads a video from a supported public link and compresses it to a shareable MP4. Run it locally or on a remote server. It uses yt-dlp for downloading and FFmpeg (provided by imageio-ffmpeg) for encoding.

## Run locally

Requires Python 3.10+ and an internet connection. From the project directory:

**Windows Command Prompt:**

```cmd
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
python app.py
```

**macOS / Linux:**

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open http://localhost:8000. Set `PORT` to change the port. Paste a public video link, choose a quality preset, and wait for the download and encoding to finish; then use the Download MP4 button. The bundled FFmpeg binary must support libx264 and AAC (the standard imageio-ffmpeg binaries do). Keep the app running until you have downloaded the result.

To run the tests: `python -m unittest discover -s tests -v`.

## Free cloud option: Render

Render's Free web service can run Clipwell remotely; you do not need your own server or a credit card to use a Free instance. Sign-up and connecting your GitHub repository still require a few steps. On Render, the source and encoding stay on the remote instance and only the final MP4 is downloaded to your computer.

1. Create a free account at [Render](https://render.com/) and connect GitHub.
2. Select **New → Web Service** and select `aaqwzsxedc272-svg/download_compress`. Choose branch `arena/c1987889-download-compress`, runtime **Docker**, and instance type **Free**. (Alternatively, deploy `render.yaml` as a Blueprint.)
3. Under **Environment**, add `CLIPWELL_PASSWORD` and set it to a unique, strong password of at least 16 characters. Do not put the password in GitHub or share it in chat. Render deployments refuse requests if this password is missing or too short.
4. Create the service and wait for the build. Open its Render URL over HTTPS. Sign in with username `clipwell` and the password you set.
5. Paste a supported link, keep the page open while it processes, download the MP4, then click **Delete from server** to free disk space.

**Free-tier limitations:** Render provides 750 free instance hours and 5 GB of included outbound bandwidth per month per workspace. Downloads of the finished file use bandwidth; if no payment method is on file, Render suspends free services when the bandwidth allowance is exhausted rather than charging for overages. Services can sleep after 15 minutes without traffic, restart unexpectedly, and lose temporary files. Render may also suspend free services that initiate unusually high external traffic, so repeated large downloads may not be viable. The page polls while open, but closing it may allow sleep and interrupt the job. A 2.4 GB source plus its output needs several GB of temporary disk space; storage, network restrictions, 512 MB RAM, and limited CPU can prevent large videos from completing. Encoding can take a long time and the result may not be smaller. Free-tier rules can change; check [Render's free-tier documentation](https://render.com/docs/free) and [pricing](https://render.com/pricing) before deploying, and avoid adding a payment method if you want no overage charges.

The password is a simple single-user safeguard, not a complete multi-user security solution: the app lacks rate limiting, resource quotas, and comprehensive protection against server-side request forgery. Use a strong unique password, use HTTPS, and only submit links you trust. A publicly reachable deployment is not suitable for sensitive content or untrusted users.

## Run on a remote server (private access)

To avoid downloading the original video to your PC, run Clipwell on **another machine**. That server downloads and compresses the video; your browser downloads only the finished MP4. The server needs Docker with Compose, internet access to the source, and enough disk space for the original and output files. Encoding can take significant CPU time. Hosting costs, if any, depend on your provider.

On your Linux server, clone this branch and start the app:

```sh
git clone --branch arena/c1987889-download-compress https://github.com/aaqwzsxedc272-svg/download_compress.git
cd download_compress
docker compose up -d --build
```

The Compose configuration binds the app to the server's loopback address, **not** the public internet. From Windows Command Prompt, open an SSH tunnel (replace `YOUR_USER` and `YOUR_SERVER` with your server's SSH username and hostname or IP):

```cmd
ssh -L 8000:127.0.0.1:8000 YOUR_USER@YOUR_SERVER
```

Keep that SSH window open and visit http://localhost:8000 on your PC. If port 8000 is already in use on Windows, use `ssh -L 8001:127.0.0.1:8000 YOUR_USER@YOUR_SERVER` and open http://localhost:8001 instead. You must have SSH access to the server; the placeholders are not literal commands to use unchanged.

On the server, `docker compose logs -f` shows logs and `docker compose down` stops and removes the container. Restarting or removing the container loses all jobs and results. The temporary source is deleted after a job succeeds or fails; forced stops may leave temporary files until the container is removed. Do not expose the app publicly: it has no authentication, quotas, or comprehensive SSRF protection. Use it only with trusted users and links.

## How it works

Paste a direct video URL, a public Filester file link (`/d/...`), or a URL supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), and choose a quality preset. Filester support uses an undocumented endpoint that may change; private or expired files are not supported. The app requests the best available video and audio, then encodes without deliberately reducing resolution, using H.264 video and AAC audio in an MP4. Render uses a faster encoder preset to reduce processing time. Quality presets use CRF 18, 23, and 28 respectively; lower CRF generally means more detail and a larger file. The result depends on the source: re-encoding can reduce quality and may even make an already-efficient file larger. Videos with DRM, login requirements, site restrictions or unsupported formats may not work. Only download content you have permission to use.

Jobs and results are temporary and held on the machine running the app; they are not restored after a restart. Downloaded files are stored in a temporary directory, which is removed on normal shutdown (a forced termination may leave it behind). The app binds to all interfaces for preview compatibility. Local runs have no password unless `CLIPWELL_PASSWORD` is set; Render requires a password. It is designed for personal use, not as a public multi-user service: it has no resource quotas or comprehensive network isolation. The public-address check is not a security boundary against redirects, DNS rebinding, or extractor requests. Ensure enough disk space for both the original and the encoded video. The server must be able to reach the video host; restricted hosting environments may block some sites.
