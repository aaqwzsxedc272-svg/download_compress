"""Exercise the real yt-dlp generic player extraction and FFmpeg pipeline offline."""
import functools
import http.server
import io
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from yt_dlp.extractor.generic import GenericIE
from yt_dlp.networking.common import Response

import app


class MediaHandler(http.server.SimpleHTTPRequestHandler):
    requests_seen = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.requests_seen.append(self.path)
        super().do_GET()


class PlayerSiteTests(unittest.TestCase):
    def test_player_pages_extract_and_compress(self):
        ffmpeg = app.imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as directory:
            video_dir = Path(directory) / 'get_file' / '123'
            video_dir.mkdir(parents=True)
            for name in ('720.mp4', '1080.mp4'):
                subprocess.run([ffmpeg, '-loglevel', 'error', '-f', 'lavfi', '-i',
                                'testsrc2=size=160x120:rate=10', '-t', '1', '-c:v', 'libx264',
                                '-y', str(video_dir / name)], check=True)
            handler = functools.partial(MediaHandler, directory=directory)
            with http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f'http://127.0.0.1:{server.server_port}/get_file/123'
                fixtures = [
                    ('https://watchporn.to/video/123/example/', f'''<!doctype html><html>
                      <head><title>Example Video</title>
                      <script src="https://watchporn.to/player/kt_player.js?v=10.11.14"></script></head>
                      <body><script>var flashvars = {{video_id: '123', license_code: '$532163217556996',
                      preview_url: 'https://watchporn.to/example.jpg',
                      video_url: '{base}/720.mp4', video_url_text: '720p',
                      video_alt_url: '{base}/1080.mp4', video_alt_url_text: '1080p'}};</script></body></html>'''),
                    ('https://www.trendyporn.com/video/example-123.html', f'''<!doctype html><html>
                      <head><title>Example Video</title></head><body>
                      <video class="video-js" controls><source src="{base}/1080.mp4" type="video/mp4"></video>
                      </body></html>'''),
                ]
                try:
                    for index, (page_url, html) in enumerate(fixtures):
                        with self.subTest(page_url=page_url):
                            MediaHandler.requests_seen = []
                            job_id = f'player-site-{index}'
                            app.JOBS[job_id] = {'id': job_id, 'url': page_url,
                                                'preset': 'balanced', 'stage': 'queued'}
                            def fake_page(*args, **kwargs):
                                return Response(io.BytesIO(html.encode()), page_url,
                                                {'Content-Type': 'text/html'})
                            # Only the page fetch is mocked; the selected video is actually
                            # downloaded from the loopback HTTP server and encoded by FFmpeg.
                            with patch.object(GenericIE, '_request_webpage', side_effect=fake_page):
                                app.run_job(job_id)
                            job = app.JOBS[job_id]
                            self.assertEqual(job['stage'], 'done', job.get('error'))
                            self.assertGreater(job['output_size'], 0)
                            self.assertIn('/get_file/123/1080.mp4', MediaHandler.requests_seen)
                            if index == 0:
                                self.assertNotIn('/get_file/123/720.mp4', MediaHandler.requests_seen)
                finally:
                    server.shutdown()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
