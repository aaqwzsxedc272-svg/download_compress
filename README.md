# Clipwell

A local web app that downloads a video from a supported public link and compresses it to a shareable MP4. It uses yt-dlp for downloading and FFmpeg (provided by imageio-ffmpeg) for encoding.

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

## How it works

Paste a direct video URL, a public Filester file link (`/d/...`), or a URL supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), and choose a quality preset. Filester support uses an undocumented endpoint that may change; private or expired files are not supported. The app requests the best available video and audio, then encodes without deliberately reducing resolution, using H.264 video and AAC audio in an MP4. Presets use CRF 18, 23, and 28 respectively; lower CRF generally means more detail and a larger file. The result depends on the source: re-encoding can reduce quality and may even make an already-efficient file larger. Videos with DRM, login requirements, site restrictions or unsupported formats may not work. Only download content you have permission to use.

Jobs and results are temporary and held on the machine running the app; they are not restored after a restart. Downloaded files are stored in a temporary directory, which is removed on normal shutdown (a forced termination may leave it behind). The app binds to all interfaces for preview compatibility and is designed for personal use on a trusted network, not exposure as a public multi-user service: it has no authentication, resource quotas, or comprehensive network isolation. The public-address check is not a security boundary against redirects, DNS rebinding, or extractor requests. Ensure enough disk space for both the original and the encoded video. The server must be able to reach the video host; restricted hosting environments may block some sites.
