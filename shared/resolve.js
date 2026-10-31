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
      if (!urls.length) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) {
          return { resolver: 'filester', title: null, files: viaBrowser };
        }
        throw new ResolveError(
          'filester refused a plain request (DDoS-Guard) and the browser found no video either. Open the link, download the file and drop it here.',
          'FILESTER_BLOCKED',
        );
      }
      return {
        resolver: 'filester',
        title: null,
        files: urls.map((videoUrl) => ({
          id: videoUrl,
          name: (() => {
            try {
              return decodeURIComponent(new URL(videoUrl).pathname.split('/').pop() || 'video.mp4');
            } catch {
              return 'video.mp4';
            }
          })(),
          size: 0,
          mime: '',
          kind: 'video',
          ref: { resolver: 'direct', url: videoUrl },
        })),
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
     real file behind a signed link on a rotating hostname, e.g.
       fileditchfiles.me/b78/x.mp4  ->  lumistretcheseverymorning.xyz/MTc5...
     The only reliable way in is to read the page's "Download" anchor. */
  /* The share hosts move between domains, and the signed links live on random
     ones, so the list can be extended without a code change:
       FILEDITCH_HOSTS=fileditchfiles.me,theirdomain.example */
  const fileditchHosts = (process.env.FILEDITCH_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const FILEDITCH_HOST = new RegExp(
    `(^|\\.)(${[
      'fileditch\\.com',
      'fileditchfiles\\.me',
      'fileditchvids\\.st',
      'theditch\\.st',
      'deltabit\\.co',
      'new\\.fileditch\\.com',
      ...fileditchHosts.map((host) => host.replace(/\./g, '\\.')),
    ].join('|')})$`,
    'i',
  );

  function fileditchLinks(html, pageUrl) {
    const out = [];
    const push = (raw) => {
      if (!raw) return;
      let absolute;
      try {
        absolute = new URL(raw.replace(/&amp;/g, '&'), pageUrl).href;
      } catch {
        return;
      }
      if (!/^https?:/i.test(absolute)) return;
      if (/abuse\.fileditch\.com|new\.fileditch\.com\/faq|\/report/i.test(absolute)) return;
      if (!out.includes(absolute)) out.push(absolute);
    };

    // The download anchor, whatever its classes look like.
    const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html))) {
      const [, href, text] = m;
      if (/download|⬇|save file/i.test(text) && !/report/i.test(text)) push(href);
    }
    // Player sources, in case the page streams the file directly.
    const srcRe = /<(?:video|source)\b[^>]*src=["']([^"']+)["']/gi;
    while ((m = srcRe.exec(html))) push(m[1]);
    const og = /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (og) push(og[1]);

    return out;
  }

  function fileditchMeta(html) {
    const name = (/<title>\s*([^<]{1,180}?)\s*<\/title>/i.exec(html) || [])[1] || null;
    const size = /(\d+(?:\.\d+)?)\s*(GB|MB|TB)\b/i.exec(html);
    const toBytes = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2 };
    return {
      name: name && /\.(mp4|mkv|webm|mov|avi)$/i.test(name) ? name : null,
      size: size ? Math.round(Number(size[1]) * toBytes[size[2].toUpperCase()]) : 0,
    };
  }

  const fileditch = {
    id: 'fileditch',
    match: (url) => {
      const parsed = safeUrl(url);
      if (!parsed || !FILEDITCH_HOST.test(parsed.hostname)) return null;
      return 'page';
    },
    async list(url) {
      const res = await fetchWithTimeout(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      }).catch(() => null);
      if (!res || !res.ok) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) return { resolver: 'fileditch', title: null, files: viaBrowser };
        throw new ResolveError(`fileditch answered HTTP ${res ? res.status : 'nothing'}.`, 'FILEDITCH_FAILED');
      }
      const html = await res.text();
      const links = fileditchLinks(html, url);
      if (!links.length) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) return { resolver: 'fileditch', title: null, files: viaBrowser };
        throw new ResolveError('fileditch did not expose a download link on that page.', 'FILEDITCH_NO_LINK');
      }
      const meta = fileditchMeta(html);
      return {
        resolver: 'fileditch',
        title: null,
        files: links.slice(0, 10).map((link, index) => {
          let name = meta.name || `video-${index + 1}.mp4`;
          if (index > 0) name = name.replace(/(\.\w+)$/, `-${index + 1}$1`);
          return {
            id: link,
            name,
            size: index === 0 ? meta.size : 0,
            mime: 'video/mp4',
            kind: 'video',
            ref: { resolver: 'fileditch', url: link, page: url, referer: url, name },
          };
        }),
      };
    },
    async direct(ref) {
      return ref.url;
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
    extractVideoUrls,
    RESOLVERS,
    ResolveError,
    isVideo,
    setGofileBrowser,
    setPageBrowser,
    gofileDownloadHeaders,
  };
});
