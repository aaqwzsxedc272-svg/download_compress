import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gallery_dl import util

import app
import filehosts


class FileHostTests(unittest.TestCase):
    def test_explicit_supported_links_only(self):
        for url in ('https://bunkr.cr/f/example.mp4', 'https://pixeldrain.com/u/abcdefgh',
                    'https://gofile.io/d/abcdef'):
            self.assertTrue(filehosts.supported(url), url)
        for url in ('https://bunkr.cr/a/album', 'https://pixeldrain.com/l/abcdefgh',
                    'https://mega.nz/file/abcd#key', 'https://example.com/video.mp4'):
            self.assertFalse(filehosts.supported(url), url)

    def test_gofile_download_link_resolves_through_public_api_with_exact_id_filter(self):
        item_id = '12345678-1234-1234-1234-123456789abc'
        url = f'https://file-na-phx-1.gofile.io/download/web/{item_id}/example.mp4?token=secret'
        self.assertTrue(filehosts.supported(url))
        target, expression = filehosts.gallery_target(url)
        self.assertEqual(target, 'https://gofile.io/d/' + item_id)
        predicate = util.compile_filter(expression)
        self.assertTrue(predicate({'extension': 'mp4', 'id': item_id}))
        self.assertFalse(predicate({'extension': 'mp4', 'id': item_id[:-1] + 'd'}))
        self.assertFalse(predicate({'extension': 'txt', 'id': item_id}))
        commands = []
        class FakeProcess:
            returncode = 0
            def __init__(self, command, **kwargs):
                commands.append(command)
                Path(command[command.index('-D') + 1], 'source.mp4').write_bytes(b'video')
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def communicate(self): return None, ''
        with tempfile.TemporaryDirectory() as directory, patch.object(filehosts.subprocess, 'Popen', FakeProcess):
            filehosts.download(url, Path(directory))
        self.assertEqual(commands[0][-1], target)
        self.assertEqual(commands[0][commands[0].index('--filter') + 1], expression)
        self.assertNotIn('secret', str(commands))

    def test_gofile_server_error_does_not_suggest_piracy_and_points_to_share_page(self):
        class FakeProcess:
            returncode = 1
            def __init__(self, *args, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def communicate(self): return None, 'secret'
        url = 'https://file-na-phx-1.gofile.io/download/web/12345678-1234-1234-1234-123456789abc/example.mp4'
        with tempfile.TemporaryDirectory() as directory, patch.object(filehosts.subprocess, 'Popen', FakeProcess):
            with self.assertRaises(RuntimeError) as context:
                filehosts.download(url, Path(directory))
        self.assertIn('https://gofile.io/d/', str(context.exception))
        self.assertNotIn('secret', str(context.exception))
        self.assertNotIn('Piracy', str(context.exception))

    def test_job_does_not_send_gofile_server_link_to_yt_dlp(self):
        job_id = 'direct-gofile-error'
        url = 'https://file-na-phx-1.gofile.io/download/web/12345678-1234-1234-1234-123456789abc/example.mp4'
        app.JOBS[job_id] = {'id': job_id, 'url': url, 'preset': 'balanced', 'stage': 'queued'}
        with patch.object(app.filehosts, 'download', side_effect=RuntimeError(filehosts.GOFILE_DIRECT_HELP)) as download, \
             patch.object(app.yt_dlp, 'YoutubeDL', side_effect=AssertionError('wrong downloader')):
            app.run_job(job_id)
        download.assert_called_once()
        self.assertEqual(app.JOBS[job_id]['stage'], 'error')
        self.assertIn('share-page', app.JOBS[job_id]['error'])
        self.assertNotIn('Piracy', app.JOBS[job_id]['error'])

    def test_invalid_gofile_server_urls_cannot_be_sent_to_gallery(self):
        for url in ('https://file-na.gofile.io/download/web/not-an-id/name.mp4',
                    'https://api.gofile.io/download/web/12345678-1234-1234-1234-123456789abc/a.mp4',
                    'https://file-na.gofile.io:444/download/web/12345678-1234-1234-1234-123456789abc/a.mp4'):
            self.assertTrue(filehosts.supported(url))
            with self.assertRaisesRegex(RuntimeError, 'share-page'):
                filehosts.gallery_target(url)
        self.assertIsNone(filehosts.gofile_direct_id('https://file-na.gofile.io.evil.test/download/web/12345678-1234-1234-1234-123456789abc/a.mp4'))

    def test_gallery_download_first_video_without_recursive_folders(self):
        class FakeProcess:
            returncode = 0
            def __init__(self, command, **kwargs):
                self.command = command
                Path(command[command.index('-D') + 1], 'source.mp4').write_bytes(b'video')
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def communicate(self): return None, ''
        with tempfile.TemporaryDirectory() as directory, patch.object(filehosts.subprocess, 'Popen', FakeProcess):
            title = filehosts.download('https://gofile.io/d/abcdef', Path(directory))
            self.assertEqual(title, 'Downloaded video')
            self.assertEqual((Path(directory) / 'source.mp4').read_bytes(), b'video')

    def test_download_failure_does_not_expose_temporary_urls(self):
        class FakeProcess:
            returncode = 1
            def __init__(self, *args, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def communicate(self): return None, 'https://secret-token.example/'
        with tempfile.TemporaryDirectory() as directory, patch.object(filehosts.subprocess, 'Popen', FakeProcess):
            with self.assertRaises(RuntimeError) as context:
                filehosts.download('https://gofile.io/d/abcdef', Path(directory))
            self.assertNotIn('secret-token', str(context.exception))

    def test_duration_probe_and_eta(self):
        ffmpeg = app.imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'video.mp4'
            subprocess.run([ffmpeg, '-loglevel', 'error', '-f', 'lavfi', '-i',
                            'testsrc2=size=160x120:rate=10', '-t', '2', '-c:v', 'libx264',
                            '-y', str(source)], check=True)
            self.assertAlmostEqual(app.probe_duration(ffmpeg, source), 2, delta=.2)
        self.assertIsNone(app.remaining_seconds(50, 100, 1))
        self.assertEqual(app.remaining_seconds(50, 100, 10), 10)
        self.assertIsNone(app.remaining_seconds(0, 100, 10))


if __name__ == '__main__': unittest.main()
