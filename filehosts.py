"""Single-video file-host downloads using gallery-dl's site extractors."""
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from gallery_dl import extractor

VIDEO_EXTENSIONS = ('mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts')


GOFILE_DIRECT_HELP = ('GoFile could not open this download-server link. Copy the public share-page URL '
                      'from the GoFile page instead (https://gofile.io/d/...), then try again. '
                      'Private or password-protected files are not supported.')


def is_gofile_download(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    return (host == 'gofile.io' or host.endswith('.gofile.io')) and parsed.path.startswith('/download/')


def gofile_direct_id(url):
    """Extract a content UUID from a GoFile server URL, never trusting the server URL itself."""
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    if (parsed.scheme != 'https' or parsed.username or parsed.password or
            not re.fullmatch(r'(?:file|store)[a-z0-9-]*\.gofile\.io', host)):
        return None
    try:
        if parsed.port not in (None, 443):
            return None
    except ValueError:
        return None
    match = re.fullmatch(r'/download/(?:web/)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/[^/]+', parsed.path)
    return match.group(1).lower() if match else None


def gallery_target(url):
    """Resolve a direct link through the API, requiring an exact file ID match."""
    content_id = gofile_direct_id(url)
    if content_id:
        return ('https://gofile.io/d/' + content_id,
                'extension.lower() in ' + repr(VIDEO_EXTENSIONS) + ' and id.lower() == ' + repr(content_id))
    if is_gofile_download(url):
        raise RuntimeError(GOFILE_DIRECT_HELP)
    return url, 'extension.lower() in ' + repr(VIDEO_EXTENSIONS)


def supported(url):
    """Only use the intended extractors, not gallery-dl's generic direct-link handler."""
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        return False
    if is_gofile_download(url):
        return True
    obj = extractor.find(url)
    category = getattr(obj, 'category', None)
    subcategory = getattr(obj, 'subcategory', None)
    return ((category == 'bunkr' and subcategory == 'media')
            or (category == 'pixeldrain' and subcategory == 'file')
            or (category == 'gofile' and subcategory == 'folder'))


def download(url, folder: Path):
    """Download the first video of a public share; never recurse into subfolders."""
    target, item_filter = gallery_target(url)
    command = [sys.executable, '-m', 'gallery_dl', '--config-ignore', '--no-input',
               '--no-colors', '--quiet', '--retries', '2', '--http-timeout', '30',
               '-o', 'extractor.gofile.recursive=false', '--range', '1',
               '--filter', item_filter,
               '-D', str(folder), '-f', 'source.{extension}', '--', target]
    with subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True) as process:
        _, errors = process.communicate()
        if process.returncode:
            # Extractor errors can contain temporary links or cookies; don't expose them.
            if is_gofile_download(url):
                raise RuntimeError(GOFILE_DIRECT_HELP)
            raise RuntimeError('The file host could not provide this video. It may be unavailable, private, password-protected, or blocked by the host.')
    sources = [path for path in folder.glob('source.*')
               if path.is_file() and path.suffix.lower().lstrip('.') in VIDEO_EXTENSIONS]
    if not sources:
        if is_gofile_download(url):
            raise RuntimeError(GOFILE_DIRECT_HELP)
        raise RuntimeError('No supported video was found. For GoFile, use a public link containing a video in its top-level folder.')
    return 'Downloaded video'
