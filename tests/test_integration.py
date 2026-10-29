"""Exercise the real downloader and encoder without relying on an external site."""
import functools
import http.server
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class IntegrationTests(unittest.TestCase):
    def test_real_direct_link_download_and_transcode(self):
        ffmpeg = app.imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'sample.mp4'
            subprocess.run([
                ffmpeg, '-loglevel', 'error', '-f', 'lavfi', '-i',
                'testsrc2=size=160x120:rate=10', '-f', 'lavfi', '-i',
                'sine=frequency=440:sample_rate=44100', '-t', '1',
                '-c:v', 'libx264', '-c:a', 'aac', '-y', str(source),
            ], check=True)
            handler = functools.partial(QuietHandler, directory=directory)
            with http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                job_id = 'integration-job'
                app.JOBS[job_id] = {
                    'id': job_id, 'url': f'http://127.0.0.1:{server.server_port}/sample.mp4',
                    'preset': 'high', 'stage': 'queued', 'progress': None,
                }
                try:
                    # run_job is called directly: the public API intentionally rejects loopback URLs.
                    app.run_job(job_id)
                finally:
                    server.shutdown()
                    thread.join()
                job = app.JOBS[job_id]
                self.assertEqual(job['stage'], 'done', job.get('error'))
                self.assertGreater(job['source_size'], 0)
                self.assertGreater(job['output_size'], 0)
                result = app.app.test_client().get(f'/api/jobs/{job_id}/download')
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.mimetype, 'video/mp4')
                result.close()

    def test_setup_errors_are_reported(self):
        job_id = 'setup-error'
        app.JOBS[job_id] = {'id': job_id, 'url': 'https://example.com/video',
                            'preset': 'balanced', 'stage': 'queued'}
        with patch.object(app.imageio_ffmpeg, 'get_ffmpeg_exe', side_effect=RuntimeError('FFmpeg unavailable')):
            app.run_job(job_id)
        self.assertEqual(app.JOBS[job_id]['stage'], 'error')
        self.assertIn('FFmpeg unavailable', app.JOBS[job_id]['error'])


if __name__ == '__main__':
    unittest.main()
