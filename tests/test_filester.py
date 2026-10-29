import io
import json
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch

import app
import filester


class Response:
    def __init__(self, body, headers=None):
        self.stream = io.BytesIO(body)
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size=-1): return self.stream.read(size)


class FilesterTests(unittest.TestCase):
    def test_share_link_and_cdn_validation(self):
        self.assertEqual(filester.share_slug('https://filester.si/d/lzg3xX6'), 'lzg3xX6')
        self.assertIsNone(filester.share_slug('https://filester.si.evil.com/d/abc'))
        self.assertIsNone(filester.share_slug('https://filester.si/f/abc'))
        self.assertTrue(filester.allowed_cdn_url('https://fsc2.cdn.cr', origin_only=True))
        for url in ('http://fsc2.cdn.cr', 'https://cdn.cr.evil.test',
                    'https://user@cdn.cr', 'https://cdn.cr/path', 'https://127.0.0.1'):
            self.assertFalse(filester.allowed_cdn_url(url, origin_only=True))

    def test_download_resolves_ticket_and_streams(self):
        ticket = {'server': 'https://fsc2.cdn.cr', 'file': 'video.mp4', 'token': 'secret'}
        class Opener:
            def __init__(self): self.requests = []
            def open(self, request, timeout):
                self.requests.append(request)
                if len(self.requests) == 1:
                    return Response(json.dumps(ticket).encode())
                return Response(b'video', {'Content-Length': '5', 'Content-Disposition': 'attachment; filename="original.mp4"'})
        opener = Opener()
        progress = []
        with tempfile.TemporaryDirectory() as directory, patch.object(filester, 'build_opener', return_value=opener):
            path = Path(directory) / 'source.bin'
            name = filester.download('https://filester.si/d/lzg3xX6', path, lambda got, total: progress.append((got, total)))
            self.assertEqual(path.read_bytes(), b'video')
        self.assertEqual(name, 'original.mp4')
        self.assertEqual(progress, [(5, 5)])
        self.assertEqual(json.loads(opener.requests[0].data), {'file_slug': 'lzg3xX6'})
        self.assertTrue(opener.requests[1].full_url.startswith('https://fsc2.cdn.cr/v2/video.mp4?'))

    def test_unsafe_server_rejected(self):
        class Opener:
            def open(self, request, timeout):
                return Response(json.dumps({'server': 'https://evil.example', 'file': 'x', 'token': 'secret'}).encode())
        with tempfile.TemporaryDirectory() as directory, patch.object(filester, 'build_opener', return_value=Opener()):
            with self.assertRaisesRegex(RuntimeError, 'valid public download'):
                filester.download('https://filester.si/d/abc', Path(directory) / 'source', lambda *_: None)

    def test_terminal_colors_removed_from_errors(self):
        self.assertEqual(app.readable_error(Exception('\x1b[0;31mERROR:\x1b[0m Unsupported URL')), 'Unsupported URL')


if __name__ == '__main__': unittest.main()
