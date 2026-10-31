/**
 * Turns "share page" links into real, downloadable video URLs.
 *
 * Written to run unchanged in Node (require) and in the browser (<script>), so a
 * deployed server and a restricted one use exactly the same logic.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.SqueezeResolve = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GOFILE_WT = '4fd6sg89d7s6'; // public web token used by gofile's own frontend
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpe?g|ts|3gp|ogv)$/i;
  const PLAYLIST_EXT = /\.(m3u8|mpd)$/i;
  const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36';

  class ResolveError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ResolveError';
      this.code = code || 'RESOLVE_FAILED';
    }
  }

  const isVideo = (name, mime) =>
    (mime && /^video\//i.test(String(mime))) || VIDEO_EXT.test(String(name || ''));

  function safeUrl(input) {
    try {
      return new URL(input);
    } catch {
      return null;
    }
  }

  /** Match a path pattern on a host (and its subdomains). */
  function hostPath(input, hostRe, pathRe) {
    const parsed = safeUrl(input);
    if (!parsed || !hostRe.test(parsed.hostname)) return null;
    return pathRe.exec(parsed.pathname)?.[1] || null;
  }

  async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ResolveError('The site took too long to answer.', 'TIMEOUT');
      }
      const blocked = err instanceof TypeError;
      throw new ResolveError(
        blocked
          ? 'The request was blocked (network unreachable, or the site refused a cross-origin call).'
          : (err && err.message) || 'Request failed.',
        blocked ? 'BLOCKED' : 'NETWORK',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(url, init, timeoutMs) {
    const res = await fetchWithTimeout(url, init, timeoutMs);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ResolveError(`Expected JSON from ${new URL(url).hostname}.`, 'BAD_RESPONSE');
    }
  }

  /* --------------------------------------------------------------- gofile.io */

  let gofileToken = { value: null, at: 0 };

  async function gofileGuestToken(force = false) {
    if (!force && gofileToken.value && Date.now() - gofileToken.at < 45 * 60 * 1000) {
      return gofileToken.value;
    }
    const data = await getJson('https://api.gofile.io/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!data || data.status !== 'ok' || !data.data || !data.data.token) {
      throw new ResolveError('gofile would not issue a guest account.', 'GOFILE_AUTH');
    }
    gofileToken = { value: data.data.token, at: Date.now() };
    return gofileToken.value;
  }

  function gofileDirectUrl(file) {
    if (file && file.link) return file.link;
    if (!file) return null;
    const store = file.server || 'store1';
    const host = /\./.test(store) ? store : `${store}.gofile.io`;
    return `https://${host}/download/${file.id}/${encodeURIComponent(file.name || 'video.mp4')}`;
  }

  const gofile = {
    id: 'gofile',
    match: (url) => hostPath(url, /(^|\.)gofile\.io$/i, /\/d\/([A-Za-z0-9_-]+)/i),
    async list(url) {
      const code = gofile.match(url);
      const endpoint = `https://api.gofile.io/contents/${code}?wt=${GOFILE_WT}&cache=true`;

      let data = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await gofileGuestToken(attempt > 0);
        try {
          data = await getJson(endpoint, { headers: { authorization: `Bearer ${token}` } });
        } catch (err) {
          lastError = err;
          continue;
        }
        if (data && data.status === 'ok') break;
        if (data && /token|auth/i.test(String(data.status))) continue; // stale token, retry once
        break;
      }

      if (!data || data.status !== 'ok') {
        const status = data && data.status ? String(data.status) : null;
        if (status === 'error-notFound') throw new ResolveError('That gofile link no longer exists.', 'NOT_FOUND');
        if (status === 'error-passwordRequired') {
          throw new ResolveError('This gofile folder is password protected.', 'PASSWORD');
        }
        if (status === 'error-notPremium') {
          throw new ResolveError(
            'gofile only releases this folder to a premium account. Open the link and download the file yourself, then drop it here.',
            'GOFILE_PREMIUM',
          );
        }
        throw lastError || new ResolveError(`gofile refused the request${status ? ` (${status})` : ''}.`, 'GOFILE_FAILED');
      }

      const node = data.data || {};
      const children = node.children || node.contents || {};
      const files = Object.values(children)
        .filter((child) => child && child.type === 'file')
        .map((child) => ({
          id: child.id,
          name: child.name || 'video',
          size: Number(child.size) || 0,
          mime: child.mimetype || '',
          kind: isVideo(child.name, child.mimetype) ? 'video' : 'other',
          ref: {
            resolver: 'gofile',
            id: child.id,
            name: child.name,
            server: child.server || child.serverChoosen || null,
            link: child.link || null,
          },
        }));

      if (!files.length) throw new ResolveError('That gofile link has no files in it.', 'EMPTY');

      return {
        resolver: 'gofile',
        title: node.name && node.name !== code ? node.name : null,
        files: orderFiles(files),
      };
    },
    async direct(ref) {
      if (ref.link) return ref.link;
      // Links are signed per session, so ask again instead of trusting a stale one.
      try {
        const token = await gofileGuestToken();
        const data = await getJson(`https://api.gofile.io/contents/${ref.id}?wt=${GOFILE_WT}&cache=true`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const child = data?.data?.children?.[ref.id] || data?.data?.contents?.[ref.id];
        if (child && child.link) return child.link;
      } catch {
        /* fall back to the constructed URL */
      }
      return gofileDirectUrl(ref);
    },
  };

  /* ---------------------------------------------------------------- turbo.cr */

  const turbo = {
    id: 'turbo',
    match: (url) => hostPath(url, /(^|\.)turbo\.cr$/i, /\/(?:d|v|embed)\/([A-Za-z0-9_-]+)/i),
    async list(url) {
      const id = turbo.match(url);
      const data = await getJson(`https://turbo.cr/api/sign?v=${encodeURIComponent(id)}`);
      if (!data || !data.success || !data.url) {
        throw new ResolveError('turbo.cr did not return a download link for that file.', 'TURBO_FAILED');
      }
      const name = data.original_filename || data.filename || `${id}.mp4`;
      return {
        resolver: 'turbo',
        title: null,
        files: [
          {
            id,
            name: String(name).replace(/[/\\]/g, '_'),
            size: 0, // filled in by whoever can reach the file
            mime: 'video/mp4',
            kind: 'video',
            ref: { resolver: 'turbo', id, url: data.url, name },
          },
        ],
      };
    },
    async direct(ref) {
      if (ref.url) return ref.url;
      const data = await getJson(`https://turbo.cr/api/sign?v=${encodeURIComponent(ref.id)}`);
      if (!data || !data.url) throw new ResolveError('turbo.cr would not sign that link again.', 'TURBO_FAILED');
      return data.url;
    },
  };

  /* --------------------------------------------------------------- pixeldrain */

  const pixeldrain = {
    id: 'pixeldrain',
    match: (url) => hostPath(url, /(^|\.)pixeldrain\.com$/i, /\/(?:u|l)\/([A-Za-z0-9_-]+)/i),
    async list(url) {
      const id = pixeldrain.match(url);
      const single = /\/u\//i.test(url);
      if (single) {
        const info = await getJson(`https://pixeldrain.com/api/file/${id}/info`).catch(() => null);
        return {
          resolver: 'pixeldrain',
          title: null,
          files: [
            {
              id,
              name: (info && info.name) || `${id}.mp4`,
              size: (info && Number(info.size)) || 0,
              mime: (info && info.mime_type) || '',
              kind: 'video',
              ref: { resolver: 'pixeldrain', id, name: (info && info.name) || `${id}.mp4` },
            },
          ],
        };
      }
      const list = await getJson(`https://pixeldrain.com/api/list/${id}`);
      const files = (list.files || []).map((file) => ({
        id: file.id,
        name: file.name,
        size: Number(file.size) || 0,
        mime: file.mime_type || '',
        kind: isVideo(file.name, file.mime_type) ? 'video' : 'other',
        ref: { resolver: 'pixeldrain', id: file.id, name: file.name },
      }));
      if (!files.length) throw new ResolveError('That pixeldrain link has no files in it.', 'EMPTY');
      return { resolver: 'pixeldrain', title: list.title || null, files: orderFiles(files) };
    },
    async direct(ref) {
      return `https://pixeldrain.com/api/file/${ref.id}?download`;
    },
  };

  /* ------------------------------------------------------------ direct files */

  const direct = {
    id: 'direct',
    match: (url) => {
      const parsed = safeUrl(url);
      return parsed && VIDEO_EXT.test(parsed.pathname) ? 'file' : null;
    },
    async list(url) {
      const parsed = safeUrl(url);
      const clean = parsed ? parsed.pathname : url.split('?')[0];
      const name = decodeURIComponent(clean.split('/').filter(Boolean).pop() || 'video.mp4');
      return {
        resolver: 'direct',
        title: null,
        files: [
          {
            id: clean,
            name,
            size: 0,
            mime: '',
            kind: 'video',
            ref: { resolver: 'direct', url, name },
          },
        ],
      };
    },
    async direct(ref) {
      return ref.url;
    },
  };

  /* ----------------------------------------------------------- generic pages */

  function extractVideoUrls(html, baseUrl) {
    const found = [];
    const push = (raw) => {
      if (!raw) return;
      let value = String(raw)
        .replace(/&amp;/g, '&')
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .trim();
      if (!value || value.startsWith('data:') || value.startsWith('blob:')) return;
      try {
        const abs = new URL(value, baseUrl).toString();
        if (/^https?:/i.test(abs)) found.push(abs);
      } catch {
        /* not a url */
      }
    };

    // <meta property="og:video:secure_url" content="...">
    const metaRe = /<meta[^>]+(?:property|name)=["'](og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*>/gi;
    let m;
    while ((m = metaRe.exec(html))) {
      const content = /content=["']([^"']+)["']/i.exec(m[0]);
      if (content) push(content[1]);
    }

    // <video src>, <source src>, and data-src variants
    const tagRe = /<(?:video|source)\b[^>]*\b(?:src|data-src)=["']([^"']+)["']/gi;
    while ((m = tagRe.exec(html))) push(m[1]);

    // JSON-LD / inline JSON contentUrl
    const jsonRe = /"contentUrl"\s*:\s*"([^"]+)"/gi;
    while ((m = jsonRe.exec(html))) push(m[1]);

    // last resort: any absolute mp4/webm URL in the page
    const looseRe = /(https?:\/\/[^\s"'<>\\]+?\.(?:mp4|webm|m4v)(?:\?[^\s"'<>\\]*)?)/gi;
    while ((m = looseRe.exec(html))) push(m[1]);

    const seen = new Set();
    return found.filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }

  const page = {
    id: 'page',
    match: (url) => {
      const parsed = safeUrl(url);
      if (!parsed) return null;
      if (VIDEO_EXT.test(parsed.pathname) || PLAYLIST_EXT.test(parsed.pathname)) return null;
      return 'page';
    },
    async list(url) {
      const res = await fetchWithTimeout(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new ResolveError(`That page answered HTTP ${res.status}.`, 'BAD_STATUS');
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType && !/(text\/html|application\/xhtml|text\/plain)/.test(contentType)) {
        throw new ResolveError('That address served a file, not a web page.', 'NOT_A_PAGE');
      }
      const html = await res.text();
      const base = res.url || url;
      const urls = extractVideoUrls(html, base).filter((u) => !PLAYLIST_EXT.test(new URL(u).pathname));

      if (!urls.length) {
        const hasPlayer = /\.(m3u8|mpd)/i.test(html) || /jwplayer|videojs|hls/i.test(html);
        throw new ResolveError(
          hasPlayer
            ? 'That page streams its video (no single file to download).'
            : 'No video file was advertised on that page.',
          'NO_VIDEO_ON_PAGE',
        );
      }

      const files = urls.slice(0, 10).map((videoUrl, index) => {
        let name = 'video.mp4';
        try {
          const parsed = new URL(videoUrl);
          const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
          name = last && VIDEO_EXT.test(last) ? last : `video-${index + 1}.mp4`;
        } catch {
          /* keep default */
        }
        return {
          id: videoUrl,
          name,
          size: 0,
          mime: '',
          kind: 'video',
          ref: { resolver: 'direct', url: videoUrl, name },
        };
      });
      return { resolver: 'page', title: null, files };
    },
    async direct(ref) {
      return ref.url;
    },
  };

  /* ----------------------------------------------------------------- registry */

  const RESOLVERS = [gofile, turbo, pixeldrain, direct, page];

  /** Videos first, biggest first — the file people usually want. */
  function orderFiles(files) {
    return [...files].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
      return (b.size || 0) - (a.size || 0);
    });
  }

  /**
   * Work out what a link actually points at.
   * Returns { resolver, title, files: [{ id, name, size, mime, kind, ref }] }.
   */
  async function resolve(url, { allowPage = true } = {}) {
    const input = String(url || '').trim();
    if (!/^https?:\/\//i.test(input)) throw new ResolveError('That is not a link.', 'BAD_URL');

    let firstError = null;
    let matched = false;
    for (const resolver of RESOLVERS) {
      if (resolver.id === 'page' && !allowPage) continue;
      if (!resolver.match(input)) continue;
      matched = true;
      try {
        const result = await resolver.list(input);
        if (result && result.files && result.files.length) return result;
        firstError = firstError || new ResolveError('Nothing downloadable was found.', 'EMPTY');
      } catch (err) {
        // A dedicated resolver failing is worth reporting; a generic page miss is not.
        if (resolver.id !== 'page') throw err;
        firstError = err;
      }
    }
    // Nothing recognised the link at all: let the caller probe it before guessing.
    if (!matched && !allowPage) return null;
    throw firstError || new ResolveError('Could not find a video behind that link.', 'NO_VIDEO_FOUND');
  }

  /** Resolve a file reference to a URL that can be downloaded right now. */
  async function directUrl(ref) {
    if (!ref || !ref.resolver) throw new ResolveError('Missing file reference.', 'BAD_REF');
    const resolver = RESOLVERS.find((r) => r.id === ref.resolver);
    if (!resolver || !resolver.direct) throw new ResolveError(`Unknown resolver ${ref.resolver}.`, 'BAD_REF');
    const url = await resolver.direct(ref);
    if (!url) throw new ResolveError('That host did not give us a download link.', 'NO_DIRECT_URL');
    return String(url).trim();
  }

  return { resolve, directUrl, extractVideoUrls, RESOLVERS, ResolveError, isVideo };
});
