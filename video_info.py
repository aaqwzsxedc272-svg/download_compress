"""Best-effort metadata inspection and clearly labelled size scenarios."""
import json
import math
import subprocess
import sys
import tempfile

import yt_dlp
import filester
import filehosts

# Illustrative bits-per-pixel-per-frame ranges, not a CRF prediction or guarantee.
# Real CRF output varies widely with motion, noise, source codec and encoder settings.
BPP_SCENARIOS = {'high': (0.08, 0.20), 'balanced': (0.035, 0.12), 'small': (0.018, 0.065)}


def positive(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and value > 0 else None


def estimate_output(info, preset):
    """Compute an illustrative size range from video dimensions and duration.

    This is a bitrate scenario with a stated assumption, not a CRF forecast.
    Return None instead of inventing an estimate when required metadata is missing.
    """
    width, height, duration = (positive(info.get(key)) for key in ('width', 'height', 'duration'))
    if not all((width, height, duration)) or preset not in BPP_SCENARIOS:
        return None
    fps = positive(info.get('fps'))
    assumed_fps = fps is None
    fps = fps or 30
    if width > 16384 or height > 16384 or fps > 240 or duration > 7 * 86400:
        return None
    low, high = BPP_SCENARIOS[preset]
    audio_bps = 192_000  # AAC configured by the encoder; conservative if no audio.
    return {
        'min_bytes': int((width * height * fps * low + audio_bps) * duration / 8),
        'max_bytes': int((width * height * fps * high + audio_bps) * duration / 8),
        'assumed_fps': assumed_fps,
        'fps': fps,
    }


def _selected_metadata(info):
    duration = positive(info.get('duration'))
    selected = info.get('requested_formats') or [info]
    video = next((fmt for fmt in selected if fmt.get('vcodec') != 'none'), selected[0])
    sizes = []
    approximate = False
    for fmt in selected:
        size = positive(fmt.get('filesize'))
        if size is None:
            size = positive(fmt.get('filesize_approx'))
            approximate = approximate or size is not None
        if size is None and duration and positive(fmt.get('tbr')):
            size = int(fmt['tbr'] * 1000 * duration / 8)
            approximate = True
        if size is None:
            sizes = []
            break
        sizes.append(size)
    return {
        'title': str(info.get('title') or 'Video')[:200],
        'source_size': int(sum(sizes)) if sizes else None,
        'source_size_approx': approximate if sizes else False,
        'width': positive(video.get('width') or info.get('width')),
        'height': positive(video.get('height') or info.get('height')),
        'fps': positive(video.get('fps') or info.get('fps')),
        'duration': duration,
        'codec': str(video.get('vcodec') or info.get('vcodec') or '')[:40] or None,
    }


def _gallery_info(url):
    target, item_filter = filehosts.gallery_target(url)
    command = [sys.executable, '-m', 'gallery_dl', '--config-ignore', '--no-input',
               '--no-colors', '--quiet', '--retries', '2', '--http-timeout', '30',
               '-o', 'extractor.gofile.recursive=false', '--range', '1',
               '--filter', item_filter,
               '--dump-json', '--', target]
    with tempfile.TemporaryFile(mode='w+b') as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.DEVNULL, timeout=90)
        if result.returncode:
            raise RuntimeError('The file host could not provide video details.')
        output.seek(0)
        raw = output.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise RuntimeError('The file host returned too much metadata.')
    data = json.loads(raw)
    for record in data:
        if isinstance(record, list) and len(record) >= 3 and record[0] == 3 and isinstance(record[2], dict):
            meta = record[2]
            return {'title': str(meta.get('name') or meta.get('filename') or 'Video')[:200],
                    'source_size': positive(meta.get('size') or meta.get('filesize')),
                    'source_size_approx': False,
                    'width': positive(meta.get('width')), 'height': positive(meta.get('height')),
                    'fps': positive(meta.get('fps')), 'duration': positive(meta.get('duration')),
                    'codec': None}
    raise RuntimeError('No supported video details found in this link.')


def inspect(url, preset='balanced'):
    """Resolve metadata without downloading the video or exposing direct URLs."""
    if preset not in BPP_SCENARIOS:
        raise ValueError('Invalid quality preset.')
    if filester.share_slug(url):
        result = {'title': 'Filester video', 'source_size': None, 'source_size_approx': False,
                  'width': None, 'height': None, 'fps': None, 'duration': None, 'codec': None}
        result.update(filester.probe(url))
    elif filehosts.supported(url):
        result = _gallery_info(url)
    else:
        with yt_dlp.YoutubeDL({'format': 'bestvideo*+bestaudio/best', 'noplaylist': True,
                               'quiet': True, 'no_warnings': True, 'socket_timeout': 30}) as ydl:
            raw = ydl.extract_info(url, download=False)
        if not isinstance(raw, dict) or raw.get('_type') in ('playlist', 'multi_video'):
            raise RuntimeError('Please use a link to a single video.')
        result = _selected_metadata(raw)
    result['estimate'] = estimate_output(result, preset)
    return result
