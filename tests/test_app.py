import socket
import subprocess
import unittest
from unittest.mock import patch

import app


class AppTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        app.JOBS.clear()

    def test_index_and_validation(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        response.close()
        for url in ('file:///etc/passwd', 'http://127.0.0.1/video', 'http://localhost/video', 'not a URL'):
            self.assertEqual(self.client.post('/api/jobs', json={'url': url}).status_code, 400)
        self.assertEqual(self.client.post('/api/jobs', json={'url': 'https://example.com', 'preset': 'bad'}).status_code, 400)
        self.assertEqual(self.client.get('/api/jobs/missing').status_code, 404)

    def test_real_transcode_and_download(self):
        ffmpeg = app.imageio_ffmpeg.get_ffmpeg_exe()
        class FakeYDL:
            def __init__(self, options):
                self.options = options
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def extract_info(self, url, download):
                path = self.options['outtmpl'].replace('%(ext)s', 'mp4')
                subprocess.run([ffmpeg, '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '1', '-c:v', 'libx264', '-y', path], check=True)
                self.options['progress_hooks'][0]({'status': 'finished'})
                return {'title': 'Test video', 'duration': 1}
        job_id = 'testjob'
        app.JOBS[job_id] = {'id': job_id, 'url': 'https://example.com/video', 'preset': 'balanced', 'stage': 'queued', 'progress': None}
        with patch.object(app.yt_dlp, 'YoutubeDL', FakeYDL):
            app.run_job(job_id)
        job = app.JOBS[job_id]
        self.assertEqual(job['stage'], 'done', job.get('error'))
        self.assertGreater(job['source_size'], 0)
        self.assertGreater(job['output_size'], 0)
        response = self.client.get('/api/jobs/testjob/download')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'video/mp4')
        self.assertIn('attachment;', response.headers['Content-Disposition'])
        response.close()

    def test_job_creation(self):
        public_address = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        with patch.object(app.socket, 'getaddrinfo', return_value=public_address), patch.object(app.threading.Thread, 'start'):
            response = self.client.post('/api/jobs', json={'url': 'https://example.com/video', 'preset': 'high'})
        self.assertEqual(response.status_code, 202)
        self.assertNotIn('url', response.json)
        self.assertEqual(self.client.get('/api/jobs/' + response.json['id']).json['stage'], 'queued')


if __name__ == '__main__':
    unittest.main()
