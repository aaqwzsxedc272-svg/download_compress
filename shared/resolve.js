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
  /* gofile keeps a short-lived "wt" website token next to the guest account.
     It used to be a constant, but a stale one makes every folder look premium,
     so it is read from gofile.io itself and cached for half an hour. */
  let gofileWt = { value: GOFILE_WT, at: 0 };
  /* Set by the server when a headless browser is available: gofile's wt token
     is minted by an obfuscated script, so only a real browser can list a folder
     once the API starts refusing. */
  let gofileBrowserHook = null;
  /* The accountToken of the browser session that listed the folder. gofile ties
     a download to the account that opened it, so this is reused verbatim. */
  let gofileSessionCookie = null;
  /* Set by the server when a headless browser is available: bot-protected pages
     are opened for real, and whatever video the page play()s is observed. */
  let pageBrowserHook = null;

  async function gofileWebToken(force = false) {
    if (!force && gofileWt.at && Date.now() - gofileWt.at < 30 * 60 * 1000) return gofileWt.value;
    const lookForToken = (text) => {
      const m = String(text || '').match(/\bwt\b\s*[:=]\s*["']([A-Za-z0-9]{8,64})["']/);
      return m ? m[1] : null;
    };
    try {
      const res = await fetch('https://gofile.io/', { headers: { 'user-agent': UA, accept: 'text/html' } });
      if (res.ok) {
        const html = await res.text();
        let found = lookForToken(html);
        if (!found) {
          const sources = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
            .map((m) => m[1])
            .slice(0, 6);
          for (const src of sources) {
            try {
              const jsUrl = new URL(src, 'https://gofile.io/').href;
              const jsRes = await fetch(jsUrl, { headers: { 'user-agent': UA } });
              if (!jsRes.ok) continue;
              found = lookForToken(await jsRes.text());
              if (found) break;
            } catch {
              /* try the next bundle */
            }
          }
        }
        if (found) {
          gofileWt = { value: found, at: Date.now() };
          return found;
        }
      }
    } catch {
      /* offline or blocked: keep whatever token we have */
    }
    gofileWt = { value: gofileWt.value || GOFILE_WT, at: Date.now() - 25 * 60 * 1000 };
    return gofileWt.value;
  }

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

  /* When the API refuses (a rotated wt token makes everything look premium),
     the public share page is still server-rendered and carries the real download
     URLs, so read them from there. */
  async function gofileScrape(code) {
    try {
      const res = await fetch(`https://gofile.io/d/${code}`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
      });
      if (!res.ok) return null;
      const html = await res.text();
      const found = new Map();
      const absolute = /https?:\/\/([A-Za-z0-9.-]*gofile\.io)\/download\/web\/([A-Za-z0-9-]+)\/([^"'\\\s<>]+)/g;
      let match;
      while ((match = absolute.exec(html))) {
        const [, host, id, rawName] = match;
        let name = rawName;
        try {
          name = decodeURIComponent(rawName);
        } catch {
          /* keep the raw name */
        }
        name = name.split('/').pop();
        if (/^thumb_/i.test(name)) continue;
        if (!isVideo(name, '')) continue;
        found.set(id, {
          id,
          name,
          size: 0,
          mime: '',
          kind: 'video',
          ref: {
            resolver: 'gofile',
            id,
            name,
            link: `https://${host}/download/web/${id}/${encodeURIComponent(name)}`,
          },
        });
      }
      return [...found.values()];
    } catch {
      return null;
    }
  }

  const gofile = {
    id: 'gofile',
    match: (url) => hostPath(url, /(^|\.)gofile\.io$/i, /\/d\/([A-Za-z0-9_-]+)/i),
    async list(url) {
      const code = gofile.match(url);
      const wt = await gofileWebToken();
      const endpoint = `https://api.gofile.io/contents/${code}?wt=${wt}&cache=true`;

      let data = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const token = await gofileGuestToken(attempt > 0);
        if (attempt === 2) {
          // Both the account and the folder call refused: refresh the website
          // token too, then give up.
          const fresh = await gofileWebToken(true);
          if (fresh && fresh !== wt) {
            try {
              data = await getJson(`https://api.gofile.io/contents/${code}?wt=${fresh}&cache=true`, {
                headers: { authorization: `Bearer ${token}` },
              });
            } catch (err) {
              lastError = err;
            }
            if (data && data.status === 'ok') break;
          }
        }
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
        if (gofileBrowserHook) {
          try {
            const viaBrowser = await gofileBrowserHook(code);
            const files = Array.isArray(viaBrowser) ? viaBrowser : viaBrowser && viaBrowser.files;
            if (files && files.length) {
              if (viaBrowser && viaBrowser.cookie) gofileSessionCookie = viaBrowser.cookie;
              return { resolver: 'gofile', title: null, files };
            }
          } catch (err) {
            lastError = lastError || err;
          }
        }
        const scraped = await gofileScrape(code);
        if (scraped && scraped.length) {
          return { resolver: 'gofile', title: null, files: scraped };
        }
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
        const data = await getJson(`https://api.gofile.io/contents/${ref.id}?wt=${await gofileWebToken()}&cache=true`, {
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


  /* ------------------------------------------------------------------ bunkr */

  // bunkr rotates domains constantly, so match the whole family.
  const BUNKR_HOST = /(^|\.)bunkr(\.[a-z]{2,})+$/i;

  function bunkrExtractSigned(html) {
    // Item pages declare the CDN path and a signing endpoint as plain vars.
    const cdn = /(?:jsCDN|cdnUrl)\s*=\s*['"]([^'"]+)['"]/i.exec(html);
    const sign = /(?:signUrl|sign)\s*=\s*['"]([^'"]+)['"]/i.exec(html);
    return {
      cdn: cdn ? cdn[1].replace(/\\\//g, '/') : null,
      sign: sign ? sign[1].replace(/\\\//g, '/') : null,
    };
  }

  const bunkr = {
    id: 'bunkr',
    match: (url) => {
      const parsed = safeUrl(url);
      if (!parsed || !BUNKR_HOST.test(parsed.hostname)) return null;
      return /\/(?:f|v|i|d)\/([A-Za-z0-9]+)/i.exec(parsed.pathname)?.[1]
        || /\/a\/([A-Za-z0-9]+)/i.exec(parsed.pathname)?.[1]
        || null;
    },
    async list(url) {
      const parsed = safeUrl(url);
      const isAlbum = /\/a\//i.test(parsed.pathname);

      if (isAlbum) {
        const res = await fetchWithTimeout(url, { headers: { 'user-agent': UA } });
        if (!res.ok) throw new ResolveError(`bunkr answered HTTP ${res.status} (it is often bot-protected).`, 'BUNKR_FAILED');
        const html = await res.text();
        const found = new Set();
        const re = /href=["'](\/[fv]\/[A-Za-z0-9]+)["']/gi;
        let m;
        while ((m = re.exec(html))) {
          found.add(new URL(m[1], parsed.origin).toString());
        }
        if (!found.size) {
          const viaBrowser = await pageBrowserFiles(url);
          if (viaBrowser && viaBrowser.length) {
            return { resolver: 'bunkr', title: null, files: viaBrowser };
          }
          throw new ResolveError('bunkr returned a bot-check page instead of the album.', 'BUNKR_BLOCKED');
        }
        const files = [];
        for (const itemUrl of [...found].slice(0, 25)) {
          try {
            const single = await bunkr.list(itemUrl);
            files.push(...single.files);
          } catch {
            /* skip items that fail */
          }
        }
        if (!files.length) throw new ResolveError('No downloadable files in that bunkr album.', 'EMPTY');
        return { resolver: 'bunkr', title: 'bunkr album', files };
      }

      const res = await fetchWithTimeout(url, { headers: { 'user-agent': UA } }).catch(() => null);
      const html = res && res.ok ? await res.text() : '';
      const { cdn, sign } = bunkrExtractSigned(html);
      if (!cdn) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) {
          return { resolver: 'bunkr', title: null, files: viaBrowser };
        }
        throw new ResolveError(
          res && !res.ok
            ? `bunkr answered HTTP ${res.status} (it is often bot-protected).`
            : 'bunkr served a bot-check page, and the browser found no video either. Open the link, download the file and drop it here.',
          'BUNKR_BLOCKED',
        );
      }
      const title = /<h1[^>]*>([^<]{1,200})<\/h1>/i.exec(html)?.[1]?.trim();
      return {
        resolver: 'bunkr',
        title: null,
        files: [
          {
            id: bunkr.match(url),
            name: title || `${bunkr.match(url)}.mp4`,
            size: 0,
            mime: 'video/mp4',
            kind: 'video',
            ref: { resolver: 'bunkr', cdn, sign, name: title || null },
          },
        ],
      };
    },
    async direct(ref) {
      if (!ref.sign) return ref.cdn;
      // Signed URLs are short lived: mint a token right before downloading.
      const base = safeUrl(ref.cdn);
      const path = base ? base.pathname : ref.cdn;
      const signed = await getJson(`${ref.sign}?path=${encodeURIComponent(path)}`);
      const token = signed.token || signed.t;
      const expires = signed.ex || signed.exp;
      if (!token) return ref.cdn;
      const separator = ref.cdn.includes('?') ? '&' : '?';
      return `${ref.cdn}${separator}token=${encodeURIComponent(token)}&ex=${encodeURIComponent(expires ?? '')}`;
    },
  };

  /* ---------------------------------------------------------------- filester */

  const filester = {
    id: 'filester',
    match: (url) => hostPath(url, /(^|\.)filester\.me$/i, /\/(?:d|f)\/([A-Za-z0-9_-]+)/i),
    async list(url) {
      const slug = filester.match(url);
      // Public metadata first; fall back to scraping the share page.
      try {
        const meta = await getJson(`https://u1.filester.me/api/v1/file/${encodeURIComponent(slug)}`);
        const data = meta && (meta.data || meta);
        if (data && (data.name || data.url)) {
          return {
            resolver: 'filester',
            title: null,
            files: [
              {
                id: slug,
                name: data.name || `${slug}.mp4`,
                size: Number(data.size) || 0,
                mime: data.type || '',
                kind: isVideo(data.name, data.type) ? 'video' : 'other',
                ref: { resolver: 'filester', slug, page: url },
              },
            ],
          };
        }
      } catch {
        /* needs auth or blocked; fall through to the page */
      }
      const res = await fetchWithTimeout(url, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new ResolveError(`filester answered HTTP ${res.status}.`, 'FILESTER_FAILED');
      const html = await res.text();
      let urls = extractVideoUrls(html, url);
      const displayName = pageDisplayName(html);
      if (!urls.length) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) {
          const named = viaBrowser.map((file, index) => ({
            ...file,
            name: index === 0 ? preferPageName(file.name, displayName) : file.name,
          }));
          return { resolver: 'filester', title: displayName, files: named };
        }
        throw new ResolveError(
          'filester refused a plain request (DDoS-Guard) and the browser found no video either. Open the link, download the file and drop it here.',
          'FILESTER_BLOCKED',
        );
      }
      return {
        resolver: 'filester',
        title: displayName,
        files: urls.map((videoUrl, index) => {
          let urlName = 'video.mp4';
          try {
            urlName = decodeURIComponent(new URL(videoUrl).pathname.split('/').pop() || 'video.mp4');
          } catch {
            /* keep default */
          }
          /* The CDN calls it a UUID; the page knows what it really is. */
          const name = index === 0 ? preferPageName(urlName, displayName) : urlName;
          return {
            id: videoUrl,
            name,
            size: 0,
            mime: '',
            kind: 'video',
            ref: { resolver: 'direct', url: videoUrl, name, page: url, referer: url },
          };
        }),
      };
    },
    async direct(ref) {
      if (ref.url) return ref.url;
      const res = await fetchWithTimeout(ref.page, { headers: { 'user-agent': UA } }).catch(() => null);
      const html = res && res.ok ? await res.text() : '';
      const urls = extractVideoUrls(html, ref.page);
      if (urls.length) return urls[0];
      const viaBrowser = await pageBrowserFiles(ref.page);
      if (viaBrowser && viaBrowser.length) return viaBrowser[0].ref.url;
      throw new ResolveError('filester did not expose a download link.', 'FILESTER_BLOCKED');
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


/** The file name inside a page title, junk and site suffix removed. */
const NAME_WITH_EXT = /^(.*?\.(?:mp4|m4v|mkv|mov|avi|webm|flv|wmv|mpg|mpeg|m2ts|mts|ts|3gp))(?![a-z0-9])/i;

/**
 * The name a person sees on a share page.
 *
 * CDNs love handing out a UUID ("e78f1c92-7cbd-4065-84a0-36d240d61814.mkv")
 * while the page itself says "Kate Dalia - Lazy Day Off.mp4". The page wins:
 * it is the only place the real name exists. Falls back through og:title,
 * <title>, <h1> and a few JSON fields, and strips site suffixes like "| Filester".
 */
function pageDisplayName(html) {
  if (!html) return null;
  const candidates = [];
  const push = (value) => {
    if (!value) return;
    const text = String(value)
      .replace(/&amp;/g, '&')
      .replace(/&#0?39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && text.length <= 180) candidates.push(text);
  };

  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
    const tag = re.exec(html);
    if (!tag) return null;
    const content = /content=["']([^"']+)["']/i.exec(tag[0]);
    return content ? content[1] : null;
  };

  push(meta('og:title'));
  push(meta('twitter:title'));
  push((/<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html) || [])[1]);
  push((/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(html) || [])[1]);
  for (const key of ['name', 'filename', 'fileName', 'title']) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{3,180})"`, 'i');
    const m = re.exec(html);
    if (m) push(m[1]);
  }

  /* A title is usually "<file name> | <site>" or "<file name> - <site>", so
     take everything up to the file extension and throw the decoration away.
     Pages that carry only a plain title ("Filester — free file host") yield
     nothing, which is correct: there is no file name to be found there. */
  for (const text of candidates) {
    const match = NAME_WITH_EXT.exec(text);
    if (!match) continue;
    const name = match[1].replace(/^[\s"'|·•—–-]+/, '').replace(/\s+/g, ' ').trim();
    if (name && name.length <= 160) return name;
  }
  return null;
}

/** Does this name look like a machine made it (uuid, hash, no words)? */
function looksGenerated(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  if (!base) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) return true;
  if (/^[0-9a-f]{16,}$/i.test(base)) return true;
  if (/^[A-Za-z0-9_-]{20,}$/.test(base) && !/[aeiou]{2}/i.test(base)) return true;
  return base.length <= 12 && /^[0-9a-z_-]+$/i.test(base) && !/\s/.test(base) && /^[0-9]/.test(base);
}

/** The name to use for a file: the page's, when the URL only offers a token. */
function preferPageName(urlName, pageName) {
  if (!pageName) return urlName;
  if (!urlName) return pageName;
  if (looksGenerated(urlName) && !looksGenerated(pageName)) return pageName;
  return urlName;
}

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

  /* ------------------------------------------------- fileditch / theditch */
  /* These share hosts serve an HTML player at the file's own URL and hide the
     real file behind a short-lived signed link on a rotating hostname:
       theditch.st/qhygxukd
         -> fileditchvids.st/b78/NAME.mp4       (the player page)
         -> https://<random host>/<base64>      (signed, ~30 minutes)
     The base64 decodes to "<expiry>:<signature>:<port>/<path>", so the page
     that mints a fresh link can always be rebuilt from it:
       https://fileditchvids.st/b78/NAME.mp4
     Two rules follow, and both matter:
       - never hand a signed link to the queue as-is; it expires, so mint a new
         one at download time (this is what made both files "not work"),
       - never offer the player URL as a second "file": it is the same video,
         served as HTML. */
  const fileditchHosts = (process.env.FILEDITCH_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const FILEDITCH_HOST = new RegExp(
    `(^|\\.)(${[
      'fileditch\\.com',
      'fileditch\\.st',
      'fileditchfiles\\.me',
      'fileditchvids\\.st',
      'theditch\\.st',
      'theditch\\.com',
      'deltabit\\.co',
      'new\\.fileditch\\.com',
      ...fileditchHosts.map((host) => host.replace(/\./g, '\\.')),
    ].join('|')})$`,
    'i',
  );

  /** base64url -> text, in Node and in the browser. */
  function decodeBase64Url(token) {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    try {
      if (typeof atob === 'function') {
        const binary = atob(padded);
        let out = '';
        for (let i = 0; i < binary.length; i += 1) out += String.fromCharCode(binary.charCodeAt(i));
        return out;
      }
      if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('binary');
    } catch {
      /* not base64 */
    }
    return null;
  }

  /**
   * A fileditch signed link is a base64 blob in place of a path.
   * Returns { expiry, port, path } or null for anything else.
   */
  function signedPayload(url) {
    const parsed = safeUrl(url);
    if (!parsed) return null;
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    if (last.length < 24 || !/^[A-Za-z0-9_-]+$/.test(last)) return null;
    const text = decodeBase64Url(last);
    if (!text) return null;
    const m = /^(\d{9,}):([^:]{8,}):(\d+)\/(.+\.[a-z0-9]{2,5})$/i.exec(text);
    if (!m) return null;
    return { expiry: Number(m[1]), port: Number(m[3]), path: m[4] };
  }

  /** The player page a signed link was minted from. */
  const pageBase = () =>
    (process.env.FILEDITCH_PAGE_BASE || 'https://fileditchvids.st').replace(/\/+$/, '');
  const pageForPath = (filePath) => `${pageBase()}/${String(filePath).replace(/^\/+/, '')}`;

  function fileditchLinks(html, pageUrl) {
    const download = [];
    const players = [];
    const push = (list, raw) => {
      if (!raw) return;
      let absolute;
      try {
        absolute = new URL(String(raw).replace(/&amp;/g, '&'), pageUrl).href;
      } catch {
        return;
      }
      if (!/^https?:/i.test(absolute)) return;
      if (/abuse\.fileditch\.com|new\.fileditch\.com\/faq|\/report/i.test(absolute)) return;
      if (!list.includes(absolute)) list.push(absolute);
    };

    // The download anchor, whatever its classes look like.
    const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html))) {
      const [, href, text] = m;
      if (/download|⬇|save file|JDownloader/i.test(text) && !/report/i.test(text)) push(download, href);
    }
    // A player source is the same file shown as HTML — only worth having when
    // there is no download anchor to use instead.
    const srcRe = /<(?:video|source)\b[^>]*src=["']([^"']+)["']/gi;
    while ((m = srcRe.exec(html))) push(players, m[1]);
    const og = /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (og) push(players, og[1]);

    return { download, players };
  }

  function fileditchMeta(html) {
    const title = (/<title>\s*([^<]{1,180}?)\s*<\/title>/i.exec(html) || [])[1] || null;
    const size = /(\d+(?:\.\d+)?)\s*(GB|MB|TB)\b/i.exec(html);
    const toBytes = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2 };
    return {
      // fileditch titles the page with the file name itself.
      name: title && VIDEO_EXT.test(title.trim()) ? title.trim().replace(/\s+/g, ' ') : null,
      size: size ? Math.round(Number(size[1]) * toBytes[size[2].toUpperCase()]) : 0,
    };
  }

  /**
   * Fetch a fileditch page and return every URL that might serve the file, best
   * first. The signed link is the intended one, but their proxies are flaky
   * enough that the player URL itself (with its fdrh token) is worth a try
   * before giving up and opening a browser.
   */
  async function fileditchMint(pageUrl, wantPath) {
    const res = await fetchWithTimeout(pageUrl, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) throw new ResolveError(`fileditch answered HTTP ${res.status}.`, 'FILEDITCH_FAILED');
    const html = await res.text();
    const base = res.url || pageUrl;
    const { download, players } = fileditchLinks(html, base);

    /* The signed link is the intended route; the player URL that carries the
       same file path is the backup when their proxy misbehaves. */
    const pathOf = (link) => {
      const payload = signedPayload(link);
      if (payload) return payload.path;
      try {
        return decodeURIComponent(new URL(link).pathname).replace(/^\/+/, '');
      } catch {
        return '';
      }
    };
    const score = (link) => {
      const payload = signedPayload(link);
      if (!wantPath) return payload ? 2 : 1;
      const path = pathOf(link);
      // -1 means "a different file": that is worth knowing, but see below.
      if (!path.endsWith(wantPath)) return -1;
      return payload ? 3 : 2;
    };
    const scored = [...download, ...players].map((link) => ({ link, score: score(link) }));
    const ranked = scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.link);
    /* Nothing on the page mentions the path we came for. Their own "Download"
       anchor is still what the page tells a visitor to click, so it beats
       giving up and handing back a player URL that serves HTML. */
    if (!ranked.length) {
      for (const entry of scored) {
        if (download.includes(entry.link) && !ranked.includes(entry.link)) ranked.push(entry.link);
      }
    }
    /* The page we just loaded is the player URL, token and all; it is the same
       backend that the signed link proxies to. A share page (no file
       extension) is not a route to the bytes, so it does not count. */
    let baseIsFile = false;
    try {
      baseIsFile = VIDEO_EXT.test(new URL(base).pathname);
    } catch {
      /* no base */
    }
    if (baseIsFile && !ranked.includes(base)) ranked.push(base);

    if (ranked.length) return { url: ranked[0], links: ranked, html, base };

    // No link at all: the page might itself be a player whose media URL is only
    // visible to a real browser.
    const viaBrowser = await pageBrowserFiles(base);
    if (viaBrowser && viaBrowser.length) {
      const links = viaBrowser.map((file) => file.ref.url).filter(Boolean);
      return { url: links[0], links, html, base, viaBrowser: true };
    }
    throw new ResolveError('fileditch did not expose a download link on that page.', 'FILEDITCH_NO_LINK');
  }

  /**
   * The file's own path (b78/NAME.mp4) when the URL carries one, else null.
   *
   * fileditch hands out three shapes for the same video, and only one of them
   * is a page worth reading:
   *   theditch.st/qhygxukd                      share page   -> read it
   *   <random host>/<base64>                    signed       -> decode, re-mint
   *   fileditchfiles.me/b78/NAME.mp4            file host    -> mint from the
   *                                               player page; the file host
   *                                               itself answers 500 to a GET
   */
  function filePathOf(url) {
    try {
      const filePath = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
      return VIDEO_EXT.test(filePath) ? filePath : null;
    } catch {
      return null;
    }
  }

  const fileditch = {
    id: 'fileditch',
    match: (url) => {
      const parsed = safeUrl(url);
      if (!parsed) return null;
      // A signed link on one of their rotating hosts, pasted straight in.
      if (signedPayload(url)) return 'signed';
      if (FILEDITCH_HOST.test(parsed.hostname)) return 'page';
      return null;
    },
    async list(url) {
      const signed = signedPayload(url);
      /* A signed link that is pasted in has usually expired by the time anyone
         uses it. Go back to the page that minted it and mint another. */
      if (signed) {
        const page = pageForPath(signed.path);
        const fresh = await fileditchMint(page, signed.path);
        const name = signed.path.split('/').pop();
        return {
          resolver: 'fileditch',
          title: name,
          files: [
            {
              id: fresh.url,
              name,
              size: 0,
              mime: 'video/mp4',
              kind: 'video',
              ref: { resolver: 'fileditch', url: fresh.url, page, referer: page, name, path: signed.path },
            },
          ],
        };
      }

      /* A URL that already names the file (fileditchfiles.me/b78/NAME.mp4) is
         not readable on its own: that host returns 500 to a plain GET and the
         bytes only come from a link minted by the player page. Ask the player
         for one instead of failing on the file host. */
      const filePath = filePathOf(url);
      if (filePath) {
        const page = pageForPath(filePath);
        try {
          const fresh = await fileditchMint(page, filePath);
          /* The player page carries the real name and size even when the file
             host itself refuses to talk. */
          const meta = fileditchMeta(fresh.html || '');
          const name = meta.name || decodeURIComponent(filePath.split('/').pop());
          return {
            resolver: 'fileditch',
            title: name,
            files: [
              {
                id: fresh.url,
                name,
                size: meta.size || 0,
                mime: 'video/mp4',
                kind: 'video',
                ref: { resolver: 'fileditch', url: fresh.url, page, referer: page, name, path: filePath },
              },
            ],
          };
        } catch (err) {
          /* The player page refused; reading the pasted URL as a page is the
             only thing left, and sometimes new.fileditch.com does serve it. */
          console.log(`[resolve] fileditch player page for ${filePath} failed: ${err.message}`);
        }
      }

      const res = await fetchWithTimeout(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
      }).catch(() => null);
      if (!res || !res.ok) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) return { resolver: 'fileditch', title: null, files: viaBrowser };
        throw new ResolveError(`fileditch answered HTTP ${res ? res.status : 'nothing'}.`, 'FILEDITCH_FAILED');
      }
      const html = await res.text();
      const base = res.url || url;
      const { download, players } = fileditchLinks(html, base);
      const candidates = download.length ? download : players;
      if (!candidates.length) {
        const viaBrowser = await pageBrowserFiles(base);
        if (viaBrowser && viaBrowser.length) return { resolver: 'fileditch', title: null, files: viaBrowser };
        throw new ResolveError('fileditch did not expose a download link on that page.', 'FILEDITCH_NO_LINK');
      }

      const meta = fileditchMeta(html);
      /* One file, one entry. Duplicates are the same video behind different
         URLs, and offering both is what made both of them fail. */
      const seen = new Set();
      const files = [];
      for (const link of candidates) {
        const payload = signedPayload(link);
        const key =
          (payload && payload.path) ||
          (() => {
            try {
              const parsed = new URL(link);
              return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
            } catch {
              return link;
            }
          })();
        if (seen.has(key)) continue;
        seen.add(key);
        const name =
          meta.name || (payload && payload.path.split('/').pop()) || `video-${files.length + 1}.mp4`;
        /* The page that issued the link is the one to ask again later, whether
           the link is signed (it expires) or a player URL (it is HTML). */
        files.push({
          id: link,
          name,
          size: files.length === 0 ? meta.size : 0,
          mime: 'video/mp4',
          kind: 'video',
          ref: {
            resolver: 'fileditch',
            url: link,
            page: base,
            referer: base,
            name,
            path: payload ? payload.path : null,
          },
        });
      }
      return { resolver: 'fileditch', title: meta.name, files };
    },
    /**
     * Every URL worth trying, best first, freshly minted.
     *
     * A signed link lives about half an hour — shorter than a queue wait — so
     * nothing is reused from resolve time. When the page cannot be reached the
     * stored link is still worth one attempt.
     */
    async candidates(ref) {
      const signed = signedPayload(ref.url);
      const filePath = (ref.path || (signed && signed.path) || '').replace(/^\/+/, '');
      const page = ref.page && !signedPayload(ref.page) ? ref.page : null;
      const out = [];

      if (page) {
        try {
          const fresh = await fileditchMint(page, filePath || null);
          out.push(...fresh.links);
        } catch {
          /* page gone: fall back to what we stored */
        }
      }
      if (!out.length && filePath) {
        try {
          const fresh = await fileditchMint(pageForPath(filePath), filePath);
          out.push(...fresh.links);
        } catch {
          /* nothing minted */
        }
      }
      if (ref.url && /^https?:/i.test(ref.url)) out.push(ref.url);

      const unique = [...new Set(out.filter(Boolean))];
      if (!unique.length) throw new ResolveError('fileditch did not give us a download link.', 'FILEDITCH_NO_LINK');
      return unique;
    },
    async direct(ref) {
      return (await fileditch.candidates(ref))[0];
    },
  };


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
      }).catch(() => null);
      if (!res || !res.ok) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) return { resolver: 'browser', title: null, files: viaBrowser };
        throw new ResolveError(
          res ? `That page answered HTTP ${res.status}.` : 'That page could not be reached.',
          'BAD_STATUS',
        );
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType && !/(text\/html|application\/xhtml|text\/plain)/.test(contentType)) {
        throw new ResolveError('That address served a file, not a web page.', 'NOT_A_PAGE');
      }
      const html = await res.text();
      const base = res.url || url;
      const urls = extractVideoUrls(html, base).filter((u) => !PLAYLIST_EXT.test(new URL(u).pathname));

      if (!urls.length) {
        const viaBrowser = await pageBrowserFiles(base);
        if (viaBrowser && viaBrowser.length) return { resolver: 'browser', title: null, files: viaBrowser };
        const hasPlayer = /\.(m3u8|mpd)/i.test(html) || /jwplayer|videojs|hls/i.test(html);
        throw new ResolveError(
          hasPlayer
            ? 'That page streams its video (no single file to download).'
            : 'No video file was advertised on that page.',
          'NO_VIDEO_ON_PAGE',
        );
      }

      const displayName = pageDisplayName(html);
      const files = urls.slice(0, 10).map((videoUrl, index) => {
        let name = 'video.mp4';
        try {
          const parsed = new URL(videoUrl);
          const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
          name = last && VIDEO_EXT.test(last) ? last : `video-${index + 1}.mp4`;
        } catch {
          /* keep default */
        }
        if (index === 0) name = preferPageName(name, displayName);
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

  const RESOLVERS = [gofile, turbo, pixeldrain, bunkr, filester, fileditch, direct, page];

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

  /**
   * Every URL that might serve this file, best first.
   *
   * Most resolvers have exactly one. fileditch has several because its signed
   * links rot and its proxies are temperamental, so a download tries them in
   * order instead of failing on the first.
   */
  async function directCandidates(ref) {
    if (!ref || !ref.resolver) throw new ResolveError('Missing file reference.', 'BAD_REF');
    const resolver = RESOLVERS.find((r) => r.id === ref.resolver);
    if (!resolver) throw new ResolveError(`Unknown resolver ${ref.resolver}.`, 'BAD_REF');
    if (typeof resolver.candidates === 'function') {
      const list = await resolver.candidates(ref);
      if (list && list.length) return [...new Set(list.map((url) => String(url).trim()).filter(Boolean))];
    }
    const url = await directUrl(ref);
    return [url];
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

  /** Headers gofile's store hosts want before they stream a file instead of
      answering with an HTML "not allowed" page. */
  async function gofileDownloadHeaders() {
    const headers = { referer: 'https://gofile.io/', origin: 'https://gofile.io' };
    if (gofileSessionCookie) {
      headers.cookie = gofileSessionCookie;
      return headers;
    }
    try {
      const token = await gofileGuestToken();
      if (token) headers.cookie = `accountToken=${token}`;
    } catch {
      /* anonymous attempt */
    }
    return headers;
  }

  /** Ask the headless browser what media a page actually plays, if it is there. */
  async function pageBrowserFiles(url) {
    if (!pageBrowserHook) return null;
    try {
      const result = await pageBrowserHook(url);
      const media = Array.isArray(result) ? result : (result && result.media) || [];
      const files = media
        .filter((item) => item && item.url)
        .slice(0, 12)
        .map((item, index) => {
          let name = `video-${index + 1}.mp4`;
          try {
            const last = decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || '');
            if (last && VIDEO_EXT.test(last)) name = last;
          } catch {
            /* keep default */
          }
          return {
            id: item.url,
            name,
            size: Number(item.size) || 0,
            mime: item.contentType || '',
            kind: 'video',
            ref: { resolver: 'direct', url: item.url, name },
          };
        });
      return files.length ? files : null;
    } catch {
      return null;
    }
  }

  function setPageBrowser(hook) {
    pageBrowserHook = typeof hook === 'function' ? hook : null;
  }

  function setGofileBrowser(hook) {
    gofileBrowserHook = typeof hook === 'function' ? hook : null;
  }

  return {
    resolve,
    directUrl,
    directCandidates,
    extractVideoUrls,
    pageDisplayName,
    preferPageName,
    looksGenerated,
    RESOLVERS,
    ResolveError,
    isVideo,
    setGofileBrowser,
    setPageBrowser,
    gofileDownloadHeaders,
  };
});
