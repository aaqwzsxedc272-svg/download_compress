import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
