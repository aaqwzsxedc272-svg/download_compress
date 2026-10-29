"""Single-video file-host downloads using gallery-dl's site extractors."""
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from gallery_dl import extractor

VIDEO_EXTENSIONS = ('mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts')


def supported(url):
    """Only use the intended extractors, not gallery-dl's generic direct-link handler."""
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return False
    obj = extractor.find(url)
    category = getattr(obj, 'category', None)
    subcategory = getattr(obj, 'subcategory', None)
    return ((category == 'bunkr' and subcategory == 'media')
            or (category == 'pixeldrain' and subcategory == 'file')
            or (category == 'gofile' and subcategory == 'folder'))


def download(url, folder: Path):
    """Download the first video of a public share; never recurse into subfolders."""
    command = [sys.executable, '-m', 'gallery_dl', '--config-ignore', '--no-input',
               '--no-colors', '--quiet', '--retries', '2', '--http-timeout', '30',
               '-o', 'extractor.gofile.recursive=false', '--range', '1',
               '--filter', 'extension.lower() in ' + repr(VIDEO_EXTENSIONS),
               '-D', str(folder), '-f', 'source.{extension}', '--', url]
    with subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True) as process:
        _, errors = process.communicate()
        if process.returncode:
            # Extractor errors can contain temporary links or cookies; don't expose them.
            raise RuntimeError('The file host could not provide this video. It may be unavailable, private, password-protected, or blocked by the host.')
    sources = [path for path in folder.glob('source.*')
               if path.is_file() and path.suffix.lower().lstrip('.') in VIDEO_EXTENSIONS]
    if not sources:
        raise RuntimeError('No supported video was found. For GoFile, use a public link containing a video in its top-level folder.')
    return 'Downloaded video'
