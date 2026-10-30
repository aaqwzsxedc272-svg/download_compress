"""Resolve and download public Filester share links.

Filester's download endpoint is undocumented and may change without notice.
"""
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


SHARE_HOSTS = {'filester.me', 'filester.si', 'filester.sh', 'filester.gg'}
CDN_HOSTS = ('cdn.cr', 'filester.me')
TOKEN_URL = 'https://filester.me/v2/api/public/download'


def share_slug(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower().removeprefix('www.')
    match = re.fullmatch(r'/d/([a-zA-Z0-9]+)\/?', parsed.path)
    return match.group(1) if host in SHARE_HOSTS and match else None


def allowed_cdn_url(url, origin_only=False):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    try:
        port_ok = parsed.port in (None, 443)
    except ValueError:
        return False
    return (parsed.scheme == 'https' and not parsed.username and not parsed.password and port_ok
            and any(host == domain or host.endswith('.' + domain) for domain in CDN_HOSTS)
            and (not origin_only or (parsed.path in ('', '/') and not parsed.query and not parsed.fragment)))


class SafeRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed_cdn_url(newurl):
            raise RuntimeError('Filester redirected to an untrusted download server.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _ticket(opener, url):
    slug = share_slug(url)
    if not slug:
        raise ValueError('Not a supported Filester file link.')
    headers = {'User-Agent': 'Mozilla/5.0', 'Referer': url}
    request = Request(TOKEN_URL, data=json.dumps({'file_slug': slug}).encode(),
                      headers={**headers, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    with opener.open(request, timeout=30) as response:
        body = response.read(65537)
        if len(body) > 65536:
            raise RuntimeError('Filester returned an unexpectedly large response.')
        payload = json.loads(body)
    server, filename, token = payload.get('server'), payload.get('file'), payload.get('token')
    if (not all(isinstance(value, str) and value for value in (server, filename, token))
            or not allowed_cdn_url(server, origin_only=True) or filename in ('.', '..')
            or '/' in filename or '\\' in filename):
        raise RuntimeError('Filester did not return a valid public download. The link may be private, expired, or unavailable.')
    direct_url = server.rstrip('/') + '/v2/' + quote(filename, safe='') + '?' + urlencode({'token': token, 'download': 'true'})
    return direct_url, headers


def probe(url):
    """Read only response headers; never return the short-lived download token."""
    opener = build_opener(SafeRedirects())
    try:
        direct_url, headers = _ticket(opener, url)
        with opener.open(Request(direct_url, headers=headers, method='HEAD'), timeout=30) as response:
            length = response.headers.get('Content-Length', '')
            return {'title': response.headers.get_filename() or 'Filester video',
                    'source_size': int(length) if length.isdigit() and int(length) > 0 else None}
    except (HTTPError, URLError, OSError, ValueError, AttributeError) as exc:
        # File hosts can reject HEAD even if downloads work. Don't leak the ticket.
        raise RuntimeError('Filester could not provide file details before download.') from exc


def download(url, destination, progress):
    opener = build_opener(SafeRedirects())
    try:
        direct_url, headers = _ticket(opener, url)
        with opener.open(Request(direct_url, headers=headers), timeout=120) as response:
            total_header = response.headers.get('Content-Length', '')
            total = int(total_header) if total_header.isdigit() else None
            name = response.headers.get_filename() or 'Filester video'
            received = 0
            with destination.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    received += len(chunk)
                    progress(received, total)
            if total is not None and received != total:
                raise RuntimeError('The Filester download was incomplete. Please try again.')
        return name
    except HTTPError as exc:
        raise RuntimeError(f'Filester refused the download (HTTP {exc.code}). The file may be private, expired, or unavailable.') from exc
    except (URLError, OSError) as exc:
        # Avoid exposing the short-lived token in errors.
        raise RuntimeError('Could not download from Filester. Check your connection and try again.') from exc
    except (ValueError, AttributeError) as exc:
        raise RuntimeError('Filester returned an unexpected response. Its download API may have changed.') from exc
