"""Local video downloader and quality-first compressor."""
from __future__ import annotations

import atexit
import ipaddress
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import imageio_ffmpeg
import yt_dlp
import filester
from flask import Flask, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024

# Files live outside the repository and are removed on normal shutdown.
WORK_DIR = Path(tempfile.mkdtemp(prefix="clipwell-"))
atexit.register(shutil.rmtree, WORK_DIR, ignore_errors=True)
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()
PRESETS = {
    "high": {"crf": 18, "label": "Highest quality"},
    "balanced": {"crf": 23, "label": "Balanced"},
    "small": {"crf": 28, "label": "Smallest file"},
}


def public_job(job: dict) -> dict:
    return {k: v for k, v in job.items() if k not in {"url", "path"}}


def update(job_id: str, **values):
    with LOCK:
        JOBS[job_id].update(values)


def validate_url(url: str):
    """Reject local addresses. This is a local-use app, not an SSRF sandbox."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Enter a valid public http or https video link.")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(addr[4][0]).is_global for addr in addresses):
            raise ValueError("Please use a public video link, not a local or private address.")
    except (socket.gaierror, ValueError) as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError("Could not find that website. Check the link and try again.") from exc


def readable_error(exc: Exception) -> str:
    message = re.sub(r"\x1b\[[0-9;]*m", "", str(exc)).replace("ERROR: ", "")
    # Avoid exposing local file paths or very long extractor diagnostics in the UI.
    message = re.sub(r"/[^\s:]+/clipwell-[^\s:]+", "[working directory]", message)
    return message[:350] or "Something went wrong. Please try again."


def run_job(job_id: str):
    job = JOBS[job_id]
    folder = WORK_DIR / job_id
    try:
        folder.mkdir()
        source_template = str(folder / "source.%(ext)s")
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

        def progress(data):
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate")
                percent = min(99, int(data.get("downloaded_bytes", 0) / total * 100)) if total else None
                update(job_id, stage="downloading", progress=percent)
            elif data.get("status") == "finished":
                update(job_id, stage="preparing", progress=None)

        options = {
            "format": "bestvideo*+bestaudio/best",
            "outtmpl": source_template,
            "noplaylist": True,
            "ffmpeg_location": ffmpeg,
            "merge_output_format": "mkv",
            "progress_hooks": [progress],
            "quiet": True,
            "no_warnings": True,
            "restrictfilenames": True,
            "socket_timeout": 30,
        }
        update(job_id, stage="downloading", progress=None)
        if filester.share_slug(job["url"]):
            def filester_progress(downloaded, total):
                percentage = min(99, int(downloaded / total * 100)) if total else None
                update(job_id, stage="downloading", progress=percentage)
            title = filester.download(job["url"], folder / "source.bin", filester_progress)
            duration = 0  # Filester does not supply video duration in its download ticket.
        else:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(job["url"], download=True)
                title = info.get("title") or "Video"
                duration = info.get("duration") or 0
        # yt-dlp may merge streams; pick the final media, not partial files.
        sources = [p for p in folder.glob("source.*") if p.is_file() and not p.name.endswith((".part", ".ytdl"))]
        if not sources:
            raise RuntimeError("The download finished but no video file was found.")
        source = max(sources, key=lambda p: p.stat().st_size)
        source_size = source.stat().st_size
        update(job_id, stage="compressing", progress=0 if duration else None, title=title, source_size=source_size)
        output = folder / "compressed.mp4"
        # CRF controls perceptual quality; slow encoding improves compression at the same quality.
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
               "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "slow",
               "-crf", str(PRESETS[job["preset"]]["crf"]), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
               "-progress", "pipe:1", "-nostats", str(output)]
        # A file for stderr avoids pipe deadlocks while reading progress.
        with tempfile.TemporaryFile(mode="w+") as errors:
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors, text=True)
            assert process.stdout is not None
            for line in process.stdout:
                if line.startswith("out_time_us=") and duration:
                    try:
                        percentage = min(99, max(0, int(int(line.split("=", 1)[1]) / 1_000_000 / duration * 100)))
                        update(job_id, progress=percentage)
                    except ValueError:
                        pass
            process.stdout.close()
            code = process.wait()
            if code:
                errors.seek(0)
                raise RuntimeError("Compression failed: " + errors.read()[-500:])
        output_size = output.stat().st_size
        # Only retain the result once encoding succeeds.
        for path in folder.iterdir():
            if path != output and path.is_file():
                path.unlink()
        update(job_id, stage="done", progress=100, output_size=output_size, path=str(output), finished_at=time.time())
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        update(job_id, stage="error", progress=None, error=readable_error(exc), finished_at=time.time())


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.post("/api/jobs")
def create_job():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(error="Invalid request."), 400
    url = data.get("url", "")
    preset = data.get("preset", "balanced")
    if not isinstance(url, str) or len(url) > 4096 or not isinstance(preset, str) or preset not in PRESETS:
        return jsonify(error="Please provide a valid link and quality preset."), 400
    url = url.strip()
    try:
        validate_url(url)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "url": url, "preset": preset, "stage": "queued", "progress": None, "created_at": time.time()}
    with LOCK:
        JOBS[job_id] = job
        response_job = public_job(job)
    threading.Thread(target=run_job, args=(job_id,), daemon=True).start()
    return jsonify(response_job), 202


@app.get("/api/jobs/<job_id>")
def get_job(job_id):
    with LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify(error="Job not found."), 404
        return jsonify(public_job(job))


@app.get("/api/jobs/<job_id>/download")
def download(job_id):
    with LOCK:
        job = JOBS.get(job_id)
        if not job or job["stage"] != "done":
            return jsonify(error="Your video is not ready yet."), 404
        path = job["path"]
        title = re.sub(r'[^\w\- .]', '', job.get("title", "video"), flags=re.UNICODE).strip(' .')[:100] or "video"
    return send_file(path, as_attachment=True, download_name=f"{title} - compressed.mp4", mimetype="video/mp4")


@app.errorhandler(RequestEntityTooLarge)
def too_large(_):
    return jsonify(error="Request is too large."), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), threaded=True)
