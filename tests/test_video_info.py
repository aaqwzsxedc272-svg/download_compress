import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import app
import colab_ui
import video_info
from test_filester import Response


class VideoInfoTests(unittest.TestCase):
    def test_selected_sizes_resolution_and_scenario(self):
        result = video_info._selected_metadata({
            'title': 'Test', 'duration': 60,
            'requested_formats': [
                {'vcodec': 'h264', 'width': 1920, 'height': 1080, 'fps': 30, 'filesize': 1000000},
                {'vcodec': 'none', 'filesize_approx': 200000},
            ],
        })
        self.assertEqual(result['source_size'], 1200000)
        self.assertTrue(result['source_size_approx'])
        self.assertEqual(result['height'], 1080)
        estimate = video_info.estimate_output(result, 'balanced')
        self.assertGreater(estimate['max_bytes'], estimate['min_bytes'])
        self.assertFalse(estimate['assumed_fps'])
        self.assertIsNone(video_info.estimate_output({'source_size': 1200000}, 'balanced'))
        self.assertIsNone(video_info.estimate_output({'width': float('nan'), 'height': 1080, 'duration': 10}, 'balanced'))

    def test_inspect_uses_metadata_only(self):
        class FakeYDL:
            def __init__(self, opts): self.options = opts
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def extract_info(self, url, download):
                assert download is False
                return {'title': 'Sample', 'duration': 10, 'width': 1280, 'height': 720, 'filesize': 12345}
        with patch.object(video_info.yt_dlp, 'YoutubeDL', FakeYDL), patch.object(video_info.filehosts, 'supported', return_value=False):
            result = video_info.inspect('https://example.com/video', 'high')
        self.assertEqual(result['source_size'], 12345)
        self.assertTrue(result['estimate']['assumed_fps'])
        self.assertNotIn('url', result)

    def test_gallery_info_extracts_only_metadata(self):
        def fake_run(command, stdout, **kwargs):
            stdout.write(json.dumps([[2, None, {}], [3, 'https://temporary.example/?secret=x',
                                      {'filename': 'Video', 'size': 5500, 'width': 640, 'height': 480}]]).encode())
            return SimpleNamespace(returncode=0)
        with patch.object(video_info.subprocess, 'run', side_effect=fake_run):
            result = video_info._gallery_info('https://gofile.io/d/example')
        self.assertEqual(result['source_size'], 5500)
        self.assertNotIn('secret', str(result))

    def test_filester_probe_uses_head_without_exposing_token(self):
        ticket = {'server': 'https://fsc2.cdn.cr', 'file': 'video.mp4', 'token': 'secret'}
        class Opener:
            def __init__(self): self.requests = []
            def open(self, request, timeout):
                self.requests.append(request)
                return Response(json.dumps(ticket).encode()) if len(self.requests) == 1 else Response(b'', {
                    'Content-Length': '123456', 'Content-Disposition': 'attachment; filename="video.mp4"'})
        opener = Opener()
        with patch.object(video_info.filester, 'build_opener', return_value=opener):
            result = video_info.inspect('https://filester.si/d/abc')
        self.assertEqual(opener.requests[1].get_method(), 'HEAD')
        self.assertEqual(result['source_size'], 123456)
        self.assertIsNone(result['estimate'])
        self.assertNotIn('secret', str(result))

    def test_inspect_api_validates_and_redacts(self):
        address = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        client = app.app.test_client()
        with patch.object(app.socket, 'getaddrinfo', return_value=address), patch.object(app.video_info, 'inspect', side_effect=RuntimeError('secret-token')):
            response = client.post('/api/inspect', json={'url': 'https://example.com/video'})
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('secret-token', response.get_data(as_text=True))
        self.assertEqual(client.post('/api/inspect', json={'url': 'file:///tmp/video'}).status_code, 400)

    def test_widget_preview_and_process_multiple_files(self):
        downloads = []
        info = {'title': '<Video>', 'source_size': 200, 'source_size_approx': False,
                'width': 640, 'height': 480, 'fps': 30, 'duration': 10, 'codec': 'h264'}
        def fake_run(job_id):
            folder = app.WORK_DIR / job_id
            folder.mkdir()
            output = folder / 'compressed.mp4'
            output.write_bytes(b'output')
            app.update(job_id, stage='done', progress=100, source_size=200, output_size=6, path=str(output))
        with tempfile.TemporaryDirectory() as directory:
            ui = colab_ui.ClipwellUI(downloads.append, output_dir=directory)
            ui.input_urls.value = 'https://example.com/1\nhttps://example.com/2'
            with patch.object(app, 'validate_url'), patch.object(video_info, 'inspect', return_value=info):
                ui._check(None)
            self.assertEqual(len(ui.previews.children), 2)
            self.assertIn('&lt;Video&gt;', ui.previews.children[0].value)
            self.assertIn('not a CRF prediction', ui.previews.children[0].value)
            ui.quality.value = 'small'
            self.assertIn('CRF 28', ui.previews.children[0].value)
            with patch.object(app, 'validate_url'), patch.object(app, 'run_job', side_effect=fake_run), patch.object(colab_ui.time, 'sleep'):
                ui._start(None)
            self.assertEqual(len(ui.results.children), 2)
            for item in ui.results.children:
                item.children[-1].click()
            self.assertEqual(len(downloads), 2)
            self.assertTrue(all(Path(path).exists() for path in downloads))


if __name__ == '__main__': unittest.main()
