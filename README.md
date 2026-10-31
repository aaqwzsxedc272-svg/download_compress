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

## Free cloud option: Google Colab (no server setup)

For occasional interactive use, open [Clipwell in Google Colab](https://colab.research.google.com/github/aaqwzsxedc272-svg/download_compress/blob/arena/c1987889-download-compress/Clipwell_Colab.ipynb), sign in to Google, select the free CPU runtime, and press **▶ Open Clipwell** once. The notebook hides the code and opens an interactive workspace. Paste up to 20 links, choose quality, and optionally click **Check links** before processing. After entering links, run the separate **▶ Start processing** cell below the workspace. The cell performs the real queue and stays running until it finishes. This is experimental: it may help Colab see the active notebook execution, but it does not guarantee against inactivity disconnects or runtime limits. The source and encoding remain in the temporary cloud runtime; download only the completed MP4 to your computer. Disconnect and delete the runtime after the download finishes.


### Optional: save finished MP4s to Google Drive

1. In the notebook, run **▶ Connect Google Drive** and authorize Colab's requested Drive access. This is optional and gives the notebook access to your mounted Drive.
2. Run **▶ Open Clipwell**, then tick **Save completed videos to Google Drive** before starting the queue.
3. Each finished MP4 is copied to **My Drive / Clipwell**. Check the result in Google Drive before disconnecting the runtime. The feature uses your Drive storage quota; it does not upload the original video. A failed copy leaves the result in the temporary runtime for manual download, and an interrupted copy may leave a `.partial` file in Drive.

**This does not guarantee background processing on free Colab.** If the runtime is stopped or disconnected before a video finishes and the copy completes, that video will not be available later and must be processed again. Previously copied MP4s remain in Drive. Colab Pro+ offers background execution with sufficient paid compute units, subject to its limits; see [Google's FAQ](https://research.google.com/colaboratory/faq.html). For free Colab, the safer option is to keep the computer awake and the notebook connected until the queue has finished.

This uses an inline dark-themed notebook workspace rather than a hosted website. Colab's free resources and session duration are limited and not guaranteed; large files can fail or take a long time, and runtime-only results disappear when the runtime is deleted. Colab prohibits file-hosting/media-serving web services and other activities; see its [FAQ](https://research.google.com/colaboratory/faq.html). Only process content you have permission to use. If the direct link fails, open Colab, choose **File → Open notebook → GitHub**, enter `aaqwzsxedc272-svg/download_compress`, select branch `arena/c1987889-download-compress`, and open `Clipwell_Colab.ipynb`.

## Free cloud option: Render

Render's Free web service can run Clipwell remotely; you do not need your own server; however, Render may request card verification depending on the account or region. Sign-up and connecting your GitHub repository still require a few steps. On Render, the source and encoding stay on the remote instance and only the final MP4 is downloaded to your computer.

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

Paste up to 20 video links (one per line) and choose a quality preset. Use **Preview source & potential size** in the web app or **Check links** in Colab to inspect available source size, resolution, codec, and duration without downloading the source video. Videos are processed sequentially, and each produces a separate MP4. Keep the page or notebook open: a web-page refresh loses the remaining queue. The app provides approximate time remaining for the current download or encoding stage when enough data is available, not for the full queue. Filester support uses an undocumented endpoint that may change; private or expired files are not supported. The app requests the best available video and audio, then encodes without deliberately reducing resolution, using H.264 video and AAC audio in an MP4. Render uses a faster encoder preset to reduce processing time. Quality presets use CRF 18, 23, and 28 respectively; lower CRF generally means more detail and a larger file. The result depends on the source: re-encoding can reduce quality and may even make an already-efficient file larger. Videos with DRM, login requirements, site restrictions or unsupported formats may not work. Only download content you have permission to use.


Preview details depend on what the host exposes: some sites do not report file size or video dimensions before download, and some reject metadata-only requests. When duration and resolution are available, potential output size is a **very rough bitrate scenario**, not a prediction of the actual CRF encode. It assumes typical video bitrates and 192 kbps audio; if frame rate is unavailable it assumes 30 fps. Motion, source codec, noise and encoder settings can put the real output far outside the scenario, including larger than the original. When required metadata is missing, no numerical estimate is shown. The presets indicate relative quality tradeoffs, not an objective quality score; actual visual quality can only be judged after encoding.


### Source support

Direct video URLs and [yt-dlp-supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) are attempted, as are public Filester file links (`/d/...`). Public Turbo.cr single-video links (`/d/`, `/v/`, `/embed/`), Bunkr single-media links, PixelDrain single-file links and GoFile shares use gallery-dl. Turbo.cr albums are not supported. Turbo may require human verification, block cloud IPs, or change its API; a page loading does not guarantee that the file can be downloaded. Turbo source sizes are omitted from previews because its page metadata may be inaccurate. For a GoFile share, only the first recognized video in the top-level folder is processed; subfolders are not traversed. Paste the public share-page URL (`https://gofile.io/d/...`), not a browser download-server URL. Clipwell also attempts to resolve GoFile download-server URLs containing a content UUID through the public API and requires an exact file-ID match; if that fails, use the share-page URL instead. GoFile links may require a browser session, be private or expire; access while signed in does not guarantee a public share is available to Colab. Bunkr albums, PixelDrain lists/folders, password-protected files and playlists are not supported by this flow. Host support changes often and these integrations have not been verified against live sources in the development environment; some sites block cloud IPs or require authentication. WatchPorn and TrendyPorn individual video pages are attempted using yt-dlp’s generic KVS and HTML5 player extraction; representative player formats are tested offline but live downloads are unverified. Availability can depend on the specific page, cloud-IP blocks, cookies, and changes to the sites. FileDitch and MEGA have no dedicated integration yet; generic direct links or yt-dlp extraction may work but are unverified.

Jobs and results are temporary and held on the machine running the app; they are not restored after a restart. Downloaded files are stored in a temporary directory, which is removed on normal shutdown (a forced termination may leave it behind). The app binds to all interfaces for preview compatibility. Local runs have no password unless `CLIPWELL_PASSWORD` is set; Render requires a password. It is designed for personal use, not as a public multi-user service: it has no resource quotas or comprehensive network isolation. The public-address check is not a security boundary against redirects, DNS rebinding, or extractor requests. Ensure enough disk space for both the original and the encoded video. The server must be able to reach the video host; restricted hosting environments may block some sites.
