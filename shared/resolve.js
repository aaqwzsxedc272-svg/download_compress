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

  /* ------------------------------------------------------- pages vs bot checks
   * fileditch (and a growing number of hosts) sit behind Cloudflare. A plain
   * request gets a 403 carrying "Just a moment…", which no amount of headers
   * will get past: the page has to run its JavaScript and earn a clearance
   * cookie. So a page is fetched like a browser would fetch it, and when that is
   * still refused the headless browser is asked to do it — the cookie it earns
   * is handed back with the file, because the CDN wants it again for the video.
   */
  const PAGE_HEADERS = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
  };

  /* The fingerprints of a bot check, whatever the host calls it. */
  const CHALLENGE_HTML =
    /just a moment|checking your browser|verify you are human|enable javascript and cookies|cf-browser-verification|challenge-platform|__cf_chl|ddos-guard|captcha/i;

  function isChallenge(res, html) {
    if (!res) return false;
    const mitigated = String(res.headers?.get?.('cf-mitigated') || '').toLowerCase();
    if (mitigated === 'challenge') return true;
    const text = String(html || '');
    const status = Number(res.status) || 0;

    /* Cloudflare's interstitial is not always labelled: it can answer 403 with
       a tiny page, or 200 with a wall of inline JavaScript. What it never has
       is a video or a link, which is the signal used below. */
    const lookedChallenged =
      CHALLENGE_HTML.test(text) ||
      /cf_chl|challenge-platform|_cf_chl_opt|window\.turnstile/i.test(text);
    if (lookedChallenged) {
      return text.length < 30000 || status === 403 || status === 503;
    }

    /* Refused, and the body is a web page: a real browser may be allowed where
       a plain client is not. That costs one attempt, and it is the difference
       between "removed" and "blocked". */
    const contentType = String(res.headers?.get?.('content-type') || '');
    if ((status === 403 || status === 503) && contentType.includes('html')) return true;

    return false;
  }

  /** True when a page contains nothing that could be a file, only a player. */
  function looksEmptyPage(html) {
    const text = String(html || '');
    if (!text.trim()) return true;
    if (/<(video|source)\b/i.test(text)) return false;
    if (/og:video/i.test(text)) return false;
    if (/<a\b[^>]*href=["'][^"']*\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpe?g|ts|3gp|ogv)/i.test(text)) return false;
    return true;
  }

  const CHALLENGE_HELP =
    'That host answers with a Cloudflare browser check, which a plain request cannot pass. ' +
    'Install the browser helper once (`npm run browser:install` in this project) and it will open ' +
    'the page like a visitor — or use "Save file" to download it in your browser and drop it here.';

  /** <title> as a browser tab would show it. */
  function pageTitleOf(html) {
    const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''));
    if (!match) return null;
    const text = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&#0?39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? text.slice(0, 180) : null;
  }

  /**
   * Fetch a page with a browser's headers, and through a real browser when the
   * site demands one.
   *
   * Returns { html, title, cookie, viaBrowser } — `cookie` is what makes the
   * download work afterwards, since the CDN checks the clearance again.
   */
  async function fetchPage(url, { timeoutMs = 20000, referer = null } = {}) {
    const headers = { ...PAGE_HEADERS, ...(referer ? { referer } : {}) };
    let res = null;
    let html = '';
    try {
      res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, timeoutMs);
      html = await res.text();
    } catch (err) {
      // Unreachable from here is not a bot check; the browser may still manage.
      res = null;
    }

    if (!isChallenge(res, html) && res && res.ok) {
      return {
        html,
        title: pageTitleOf(html),
        cookie: null,
        viaBrowser: false,
        url: res.url || url,
        status: res.status,
      };
    }

    const viaBrowser = await pageHtmlViaBrowser(url);
    if (viaBrowser && viaBrowser.html) {
      return {
        html: viaBrowser.html,
        title: viaBrowser.title || pageTitleOf(viaBrowser.html),
        cookie: viaBrowser.cookie || null,
        userAgent: viaBrowser.userAgent || null,
        viaBrowser: true,
        url: viaBrowser.url || url,
        status: 200,
      };
    }

    if (isChallenge(res, html)) throw new ResolveError(CHALLENGE_HELP, 'CLOUDFLARE');
    return {
      html,
      title: pageTitleOf(html),
      cookie: null,
      viaBrowser: false,
      url: (res && res.url) || url,
      status: res ? res.status : 0,
    };
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
  /* Set by the server when Chromium is installed: returns the DOM of a page
     after its bot check has run, plus the cookies the browser earned. */
  let pageHtmlHook = null;

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

  /* ------------------------------------------------------------ streams (HLS)
   * A stream is a text file that lists the parts of a video. As a *master* it
   * names several qualities; as a *media playlist* it names the segments. There
   * is no one URL a plain downloader can take, which is why these links used to
   * be refused with "paste a direct MP4 instead" — and why a page that streams
   * its video (missav, and most of that family) used to resolve to whatever
   * .mp4 was lying around in its ad slot.
   *
   * ffmpeg reads a playlist natively: it pulls every segment and remuxes them
   * into one MP4 with `-c copy`, so nothing is re-encoded and nothing is lost.
   * What a stream needs is a different *fetch*, not a different pipeline.
   */

  const isPlaylistUrl = (url) => /\.(m3u8|mpd)(?:[?#]|$)/i.test(String(url || ''));

  /* Adverts are shaped exactly like the video: a <video> element, an .mp4 URL,
     sometimes even an .m3u8. These are the networks that serve them, and the
     path words that give them away. A page that streams its video through an
     HLS master and also carries one of these is a page whose "video" is the HLS
     one — which is the whole bug behind "it only detected an ad". */
  const AD_HOST = /(?:^|\.)(?:doubleclick|googlesyndication|googleadservices|adservice|adnxs|adsystem|amazon-adsystem|exoclick|juicyads|tsyndicate|trafficjunky|realsrv|adsterra|popads|popcash|clickadu|adcash|propellerads|onclickads|mgid|taboola|outbrain|revcontent|zergnet|criteo|smartadserver|rubiconproject|pubmatic|openx|yieldmo|sharethrough|teads|spotxchange|springserve|advertising|adserver|adnium|hilltopads|adspyglass|clickaine|adnanny)\./i;
  const AD_PATH = /(?:^|[/_.-])(?:ads?|advert|adverts|advertisement|advertising|preroll|pre-roll|midroll|postroll|vast|vpaid|popunder|popup|banner|sponsor|promo)(?:[/_.-]|$)/i;

  function isAdUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (AD_HOST.test(parsed.hostname)) return true;
    if (isAdCreativeUrl(url)) return true;
    const path = `${parsed.pathname}${parsed.search}`;
    return AD_PATH.test(path) && !/\.(m3u8|mpd)$/i.test(parsed.pathname);
  }

  /**
   * Is this URL a *piece* of a video rather than a video?
   *
   * A page that streams reports its segments as ordinary media requests, and
   * they are shaped exactly like files. The report that produced this list —
   * twelve "files", 1.4 MB altogether, one of them a 300x250 banner and the rest
   * `117761513_240p_h264_init_…mp4`, `…_1324_…mp4`, `…_1325_…mp4` — is what a
   * segment list looks like when nobody noticed. Offering them to a person is
   * worse than offering nothing: each one is a fifth of a second of an advert.
   *
   * Rules, in order of how sure they are:
   *   - a segment extension (.ts, .m4s, CMAF) is never a file;
   *   - `init` segments (fMP4/CMAF) only exist to start a stream;
   *   - a numbered piece (`seg12`, `chunk_4`, `_1324_`, `part-3`) is a piece.
   */
  function looksLikeMediaSegment(rawUrl) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl || ''));
    } catch {
      return false;
    }
    const path = parsed.pathname;
    if (/\.(ts|m4s|cmfv|cmfa|cmft)$/i.test(path)) return true;
    const name = decodeURIComponent(path.split('/').filter(Boolean).pop() || '');
    if (/^(?:init|init-\w+)\.(?:mp4|m4s)$/i.test(name)) return true;
    if (/(?:^|[._-])init(?:[._-]|$)/i.test(name)) return true;
    /* `…_1324_kztiJgf5nAdkJ7y9_1793730536.mp4`: a sequence number, an opaque
       token and a timestamp — the shape every ad server and most packagers use
       for one segment of a fragmented stream. */
    if (/^\d+_\w+_\d+_[A-Za-z0-9_-]+_\d{9,}\.mp4$/i.test(name)) return true;
    if (/(?:^|[._-])(?:seg|segment|chunk|frag|fragment|part|piece)[._-]?\d+(?:[._-]|$)/i.test(name)) return true;
    if (/(?:^|[._-])(?:seg|segment|chunk|part)[._-]?\d+\.(?:ts|m4s|mp4)$/i.test(name)) return true;
    /* A directory that says what it is holding. */
    if (/\/(?:hls|dash|segments?|chunks?)\//i.test(path) && /\.(?:mp4|m4s|ts)$/i.test(path)) return true;
    return false;
  }

  /**
   * A short sample of the film, published next to the film.
   *
   * Sites put a two-minute preview beside a two-hour feature, and the preview
   * is often the *better encoded* of the two — so "highest quality" alone picks
   * it, which is exactly the report "only previews caught". These are the names
   * those files carry in the wild: `preview.mp4`, `_PR.mp4`, `trailer.mp4`,
   * `sample.m3u8`, `…/teaser/…`, `mediabook_320p.mp4`. Only used to rank: if a
   * page offers nothing else, a preview is still better than an error.
   */
  const PREVIEW_PATH = /(?:^|[\/._-])(?:preview|previewclip|trailer|trailerhg|teaser|sample|mediabook)(?:[\/._-]|\d|$)/i;
  function isPreviewUrl(rawUrl) {
    let path = '';
    try {
      path = decodeURIComponent(new URL(String(rawUrl || '')).pathname);
    } catch {
      return false;
    }
    if (PREVIEW_PATH.test(path)) return true;
    const name = path.split('/').filter(Boolean).pop() || '';
    /* `FNS-257_PR.mp4`: the site's own promo naming. The stem has to *end* in
       `_pr`, so a product code like SOD-PR123.mp4 is not caught. */
    if (/[._-]pr(?:[._-]\d{3,4}p)?\.(?:mp4|m3u8)$/i.test(name)) return true;
    /* `tr_720p.mp4`, the other spelling of the same thing. */
    if (/^tr[_-]?\d{2,4}p?\./i.test(name)) return true;
    return false;
  }

  /**
   * An advert dressed as a video file.
   *
   * The banner in the report was called `9558-0-300x250.medium.mp4`: an IAB
   * size in the name, which no video a person wants is called. The host and
   * path checks in `isAdUrl` cannot see that, so the name gets a look too.
   */
  function isAdCreativeUrl(rawUrl) {
    let name = '';
    try {
      name = decodeURIComponent(new URL(String(rawUrl || '')).pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      return false;
    }
    if (/\b\d{2,4}x\d{2,4}\b/.test(name) && !/\b(?:1920|1280|720|1080|2160|3840)x\d{3,4}\b/.test(name)) return true;
    return /(?:^|[._-])(?:banner|preroll|pre-roll|midroll|overlay|creative|vast|vpaid)(?:[._-]|$)/i.test(name);
  }

  /** `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=512000,RESOLUTION=1280x720` */
  function parseAttributes(text) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    let m;
    while ((m = re.exec(String(text || '')))) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  function absoluteUrl(raw, baseUrl) {
    try {
      const abs = new URL(String(raw).trim().replace(/&amp;/g, '&'), baseUrl).toString();
      return /^https?:/i.test(abs) ? abs : null;
    } catch {
      return null;
    }
  }

  /**
   * Read a playlist into { master, variants, duration, segments, live }.
   *
   * Both kinds are recognised: a master lists qualities, a media playlist lists
   * segments with #EXTINF durations (which sum to the length of the video — the
   * only way to know how long a stream is before downloading it).
   */
  function parsePlaylistText(text, baseUrl) {
    const lines = String(text || '')
      .replace(/\uFEFF/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim());
    const variants = [];
    const segments = [];
    let duration = 0;
    let endList = false;
    let vod = false;
    let drm = false;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;

      if (/^#EXT-X-STREAM-INF/i.test(line)) {
        const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
        let uri = null;
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j];
          if (!next || next.startsWith('#')) continue;
          uri = absoluteUrl(next, baseUrl);
          i = j;
          break;
        }
        const [width, height] = String(attrs.RESOLUTION || '')
          .split('x')
          .map(Number);
        if (uri) {
          variants.push({
            uri,
            bandwidth: Number(attrs.BANDWIDTH) || 0,
            width: width || 0,
            height: height || 0,
            name: attrs.NAME || null,
            codecs: attrs.CODECS || null,
          });
        }
        continue;
      }

      if (/^#EXTINF:/i.test(line)) {
        const value = Number(line.slice(8).split(',')[0]);
        let uri = null;
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j];
          if (!next || next.startsWith('#')) continue;
          uri = next;
          i = j;
          break;
        }
        if (Number.isFinite(value) && value > 0) duration += value;
        if (uri) segments.push(absoluteUrl(uri, baseUrl));
        continue;
      }

      /* A key the browser is not allowed to store, or a key system named
         outright: the stream is protected, and no amount of downloading gives
         back a playable file. Saying so is better than an ffmpeg stack trace. */
      if (/-KEY:/i.test(line) && /(SAMPLE-AES|com\.apple\.streamingkeydelivery|widevine|playready|fairplay|urn:uuid:edef8ba9)/i.test(line)) {
        drm = true;
      }
      if (/^#EXT-X-SESSION-KEY:/i.test(line) && /widevine|playready|fairplay|SAMPLE-AES/i.test(line)) drm = true;
      if (/^#EXT-X-ENDLIST/i.test(line)) endList = true;
      if (/^#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(line)) vod = true;
    }

    const live = segments.length > 0 && !endList && !vod;
    return {
      master: variants.length > 0,
      variants,
      segments,
      segmentCount: segments.length,
      duration: Math.round(duration * 1000) / 1000,
      endList,
      vod,
      live,
      drm,
    };
  }

  /** The height a variant advertises, or one hidden in its name ("1080p/…"). */
  function variantHeight(variant) {
    if (variant && variant.height) return variant.height;
    const text = `${(variant && variant.name) || ''} ${(variant && variant.uri) || ''}`;
    const p = /\b(2160|1440|1080|720|480|360|240)p\b/i.exec(text);
    if (p) return Number(p[1]);
    const pair = /(\d{3,4})x(\d{3,4})/.exec(text);
    return pair ? Number(pair[2]) : 0;
  }

  /**
   * The best quality on offer.
   *
   * Quality first, always: the app re-encodes to a target afterwards, so the
   * input should be the sharpest one the host has. Ties (and variants with no
   * resolution at all) are broken by bandwidth.
   */
  function pickBestVariant(variants) {
    const list = (variants || []).filter((variant) => variant && variant.uri);
    if (!list.length) return null;
    return [...list].sort((a, b) => {
      const byHeight = variantHeight(b) - variantHeight(a);
      if (byHeight) return byHeight;
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    })[0];
  }

  /* Reading a playlist costs two requests (master, then its media playlist) and
     a job does it twice: once to list the file, once to fetch it. A short cache
     keeps the second one free without serving a stale variant list for long. */
  const streamInfoCache = new Map();
  const STREAM_TTL = 90 * 1000;

  function clearStreamCache() {
    streamInfoCache.clear();
  }

  /**
   * The header sets a CDN might want, in the order worth trying.
   *
   * A bare playlist pasted on its own carries no referer, and a CDN that only
   * serves its streams to the site that embeds them answers 403 — which is
   * exactly what was reported ("the video server refused the request"). The
   * page path has the right referer already; a pasted stream does not, so the
   * next best guesses are tried: the CDN's own origin (some check "referer is
   * me"), then a same-site fetch shape. Whoever answers is remembered, and the
   * download reuses those exact headers, because the segments are guarded the
   * same way.
   */
  const HLS_ACCEPT = 'application/vnd.apple.mpegurl, application/x-mpegURL, */*';

  /**
   * Streaming CDNs that only serve the site that embeds them.
   *
   * A bare playlist pasted on its own has no page, so there is no referer to
   * derive — and this CDN answers 403 without one. The pairing is not a guess:
   * it is how the player on that site loads it, and it is the one case where
   * the missing piece can be supplied. Anything not listed here gets the
   * generic ladder, which tries the CDN's own origin and then nothing.
   */
  const PARENT_SITE = [
    [/(^|\.)surrit\.com$/i, 'https://missav.ws/'],
    [/(^|\.)fourhoi\.com$/i, 'https://missav.ws/'],
    [/(^|\.)streamhls\.click$/i, 'https://www.javdock.com/'],
  ];

  function knownParentReferer(url) {
    try {
      const host = new URL(url).hostname;
      const hit = PARENT_SITE.find(([pattern]) => pattern.test(host));
      return hit ? hit[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * The headers a browser would send for a playlist, computed the way a browser
   * computes them.
   *
   * This is the difference the field report turned on: surrit.com (missav's
   * video CDN) serves the *film* to a request whose Referer is
   * `https://missav.ws/` — the page's **origin** — because a cross-site
   * subresource is sent with `strict-origin-when-cross-origin`, not with the
   * full page address. A deep link as Referer is a different string, and on
   * some of these CDNs a wrong Referer gets a decoy playlist instead of an
   * error. Sending the page address where the browser sends the origin is a
   * mistake that only shows up on the one site you care about.
   */
  function browserHeaders(pageUrl, streamUrl) {
    const out = { accept: HLS_ACCEPT, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' };
    try {
      const page = new URL(pageUrl);
      const stream = new URL(streamUrl);
      const crossSite = page.host !== stream.host;
      out.referer = crossSite ? `${page.origin}/` : page.href;
      out.origin = page.origin;
      out['sec-fetch-site'] = crossSite ? 'cross-site' : 'same-origin';
    } catch {
      /* not a URL — send nothing extra */
    }
    return out;
  }

  /**
   * The sets of headers worth trying, in order, for one playlist URL.
   *
   * Nothing about a stream tells you which of these a given CDN wants, and the
   * wrong answer is a 403 (or, worse, a decoy playlist of advert images). So
   * they are tried cheapest-first: browser-correct, then the full page address,
   * then no origin at all, then the CDN as its own referer. Whoever answers is
   * remembered and reused for every segment, because segments are guarded
   * exactly like the playlist.
   */
  function headerLadder(url, headers) {
    const tries = [];
    const seen = new Set();
    const push = (extra) => {
      const attempt = {};
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined && value !== null && value !== '') attempt[key] = value;
      }
      const key = JSON.stringify(attempt);
      if (seen.has(key)) return;
      seen.add(key);
      tries.push(attempt);
    };

    const pageUrl = headers.referer || headers.Referer || '';
    if (pageUrl) {
      push({ ...headers, ...browserHeaders(pageUrl, url) });
      push({ ...headers, accept: HLS_ACCEPT });
    }
    push({ ...headers, accept: HLS_ACCEPT, referer: undefined, origin: undefined });
    /* No page to copy from, but this CDN is known to belong to one. */
    const parent = knownParentReferer(url);
    if (parent) {
      push({ ...headers, ...browserHeaders(parent, url) });
      push({ ...headers, accept: HLS_ACCEPT, referer: parent, origin: parent.replace(/\/$/, '') });
    }
    try {
      const own = new URL(url).origin;
      push({
        accept: HLS_ACCEPT,
        referer: `${own}/`,
        origin: own,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': headers['user-agent'] || headers['User-Agent'],
      });
    } catch {
      /* not a URL */
    }
    if (!tries.length) push({ ...headers });
    return tries;
  }

  /**
   * How big one segment is, so the whole stream can be estimated.
   *
   * A master playlist states BANDWIDTH and the arithmetic is free. A media
   * playlist states nothing, and "0 MB" is not a size a person can plan around
   * — the disk guard and the card both need a number. One HEAD for one segment
   * is a few hundred bytes of traffic and gives a good answer, because a film
   * is hundreds of pieces of roughly the same length.
   */
  async function probeSegmentBytes(url, headers) {
    for (const method of ['HEAD', 'GET']) {
      const res = await fetchWithTimeout(
        url,
        method === 'HEAD'
          ? { method, headers: { 'user-agent': UA, ...headers }, redirect: 'follow' }
          : { method, headers: { 'user-agent': UA, range: 'bytes=0-0', ...headers }, redirect: 'follow' },
        3500,
      ).catch(() => null);
      if (!res) continue;
      if (res.body && method === 'GET') res.body.cancel().catch(() => {});
      const total = Number(
        (res.headers.get('content-range') || '').split('/')[1] || res.headers.get('content-length') || 0,
      );
      if (Number.isFinite(total) && total > 0) return total;
    }
    return 0;
  }

  /** `name=value` pairs from a response's Set-Cookie, on top of the ones we had. */
  function mergeCookies(existing, res) {
    const jar = new Map();
    for (const pair of String(existing || '').split(';')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      jar.set(trimmed.split('=')[0].trim(), trimmed);
    }
    const fresh =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const raw of fresh) {
      for (const piece of String(raw).split(/,(?=[^;,]+=)/)) {
        const pair = piece.split(';')[0].trim();
        if (!pair || !pair.includes('=')) continue;
        jar.set(pair.split('=')[0].trim(), pair);
      }
    }
    return jar.size ? [...jar.values()].join('; ') : '';
  }

  async function fetchPlaylistText(url, headers = {}, { timeoutMs = 8000 } = {}) {
    let lastError = null;
    for (const attempt of headerLadder(url, headers)) {
      const res = await fetchWithTimeout(
        url,
        { headers: { 'user-agent': UA, ...attempt }, redirect: 'follow' },
        timeoutMs,
      ).catch(() => null);
      if (res && res.ok) {
        const text = await res.text();
        if (!/#EXTM3U|#EXT-X-|<MPD/i.test(text.slice(0, 4000))) {
          throw new ResolveError(
            'That link answered with a page instead of a playlist — the stream link is probably generated by the page itself.',
            'STREAM_NOT_A_PLAYLIST',
          );
        }
        /* A CDN that hands out a session cookie on the first request expects it
           back on every segment; ffmpeg gets the string with the headers. */
        const cookie = mergeCookies(attempt.cookie, res);
        return { text, url: res.url || url, headers: cookie ? { ...attempt, cookie } : attempt };
      }
      if (res && res.status !== 401 && res.status !== 403) {
        throw new ResolveError(`The stream's playlist answered HTTP ${res.status}.`, 'STREAM_BAD_STATUS');
      }
      lastError = new ResolveError(
        'The video server refused the request. A stream like this is usually served only to the page it is ' +
          'embedded in, and this link arrived without that page. Paste the page the video plays on, or open ' +
          'the page in a browser and copy the .m3u8 address it actually requests.',
        'STREAM_FORBIDDEN',
      );
    }
    throw lastError || new ResolveError('The video server refused the request.', 'STREAM_FORBIDDEN');
  }

  async function inspectPlaylist(url, { headers = {} } = {}) {
    const key = String(url);
    const hit = streamInfoCache.get(key);
    if (hit && Date.now() - hit.at < STREAM_TTL) return hit.value;

    const first = await fetchPlaylistText(url, headers);
    /* Whatever made the first request work is what the segments will need. */
    const working = first.headers;
    const top = parsePlaylistText(first.text, first.url);
    let chosen = { uri: first.url, bandwidth: 0, height: 0, name: null };
    let media = top;
    let master = null;

    if (top.master) {
      master = first.url;
      chosen = pickBestVariant(top.variants);
      if (!chosen) throw new ResolveError('That playlist lists no qualities.', 'STREAM_NO_VARIANTS');
      if (chosen.uri !== first.url) {
        const second = await fetchPlaylistText(chosen.uri, working);
        media = parsePlaylistText(second.text, second.url);
        /* A variant can itself be a master (rare, but valid HLS). */
        if (media.master && !media.segments.length) {
          const deeper = pickBestVariant(media.variants);
          if (deeper) {
            chosen = deeper;
            media = parsePlaylistText((await fetchPlaylistText(deeper.uri, working)).text, deeper.uri);
          }
        }
      }
    }

    if (!media.segments.length && !media.master) {
      throw new ResolveError('That playlist lists no video segments.', 'STREAM_EMPTY');
    }
    if (media.drm || top.drm) {
      throw new ResolveError(
        'That stream is protected by DRM, so its video cannot be saved by any downloader. ' +
          'The page will play it, but a file of it cannot be made.',
        'STREAM_DRM',
      );
    }
    if (media.live) {
      throw new ResolveError(
        'That link is a live stream with no end, so there is no finished video to save. ' +
          'A finished recording of the same page can still be downloaded.',
        'STREAM_LIVE',
      );
    }

    const height = variantHeight(chosen) || Number(media.variants?.[0]?.height) || 0;
    /* BANDWIDTH is the whole rendition (video + audio) in bits per second, so
       the size of the download is duration × bitrate / 8. A rough number, but a
       rough number beats "unknown" on a 32 GB disk. */
    const bandwidth = chosen.bandwidth || 0;
    let estimatedBytes =
      media.duration > 0 && bandwidth > 0 ? Math.round((media.duration * bandwidth) / 8) : 0;
    if (!estimatedBytes && media.segments.length) {
      const oneSegment = await probeSegmentBytes(media.segments[0], working).catch(() => 0);
      if (oneSegment > 0) estimatedBytes = oneSegment * media.segments.length;
    }

    const info = {
      url: chosen.uri,
      master,
      /* The headers that were actually accepted, for ffmpeg to reuse. */
      headers: working,
      height,
      bandwidth,
      duration: media.duration,
      segments: media.segmentCount,
      estimatedBytes,
      variants: top.variants.map((variant) => ({
        uri: variant.uri,
        height: variantHeight(variant),
        bandwidth: variant.bandwidth,
        name: variant.name,
      })),
    };
    streamInfoCache.set(key, { at: Date.now(), value: info });
    return info;
  }

  /**
   * A file name from a page title.
   *
   * `pageDisplayName` only answers when the title already contains a file name,
   * which a streaming page rarely has ("DANDYA-045 … - MissAV"). For those the
   * title itself is the best name there is, minus the site suffix and anything
   * a filesystem would refuse.
   */
  function fileNameFromTitle(title) {
    if (!title) return null;
    let text = String(title).replace(/\s+/g, ' ').trim();
    const parts = text.split(/\s+[|·•—–]\s+|\s+-\s+/);
    if (parts.length > 1 && parts[parts.length - 1].length <= 25) {
      text = parts.slice(0, -1).join(' - ');
    }
    text = text
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 120)
      .trim();
    if (!text) return null;
    return /\.(mp4|mkv|webm|mov|m4v)$/i.test(text) ? text : `${text}.mp4`;
  }

  /** A file name for a stream, when no page title is there to name it. */
  function nameForStream(url, info) {
    let host = 'stream';
    let last = '';
    let parent = '';
    try {
      const parsed = new URL(url);
      /* "surrit", not "surrit.com": the name is going into somebody's
         downloads folder, and a dotted host looks like a file extension. */
      host = parsed.hostname.replace(/^www\./, '').split('.')[0] || 'stream';
      const parts = parsed.pathname.split('/').filter(Boolean);
      last = (parts.pop() || '').replace(/\.(m3u8|mpd)$/i, '');
      parent = parts.pop() || '';
    } catch {
      /* keep defaults */
    }
    const usable = (value) => value && !/^(playlist|index|master|manifest|prog_index|chunklist|video|media|stream)$/i.test(value) &&
      !/^[a-f0-9-]{20,}$/i.test(value);
    const base = usable(last) ? last : usable(parent) ? parent : host;
    const quality = info && info.height ? `-${info.height}p` : '';
    return `${base}${quality}.mp4`.replace(/[\\/:*?"<>|]/g, '-');
  }

  /** The headers a CDN expects, taken from whatever the resolver learned. */
  function streamHeaders(ref) {
    const headers = {};
    if (!ref) return headers;
    if (ref.referer) headers.referer = ref.referer;
    if (ref.cookie) headers.cookie = ref.cookie;
    if (ref.userAgent) headers['user-agent'] = ref.userAgent;
    try {
      if (ref.referer) headers.origin = new URL(ref.referer).origin;
    } catch {
      /* no origin */
    }
    return headers;
  }

  /**
   * Of several playlist URLs on one page, the one that is the film.
   *
   * Three things decide it, in this order:
   *
   *   1. **Not a preview.** A sample is never the feature, whatever its
   *      picture size, and these pages put the sample's URL right next to the
   *      film's.
   *   2. **How long it is.** The media playlist states the length as the sum of
   *      its segments, so it costs nothing to read and it is the one fact an
   *      advert or a preview cannot fake: two hours versus forty seconds. A
   *      short clip at 1080p must lose to the feature at 720p — that is the
   *      "only previews caught" report, exactly.
   *   3. **How good it looks.** Between two long ones, the bigger picture wins;
   *      then bitrate; then the longer one.
   *
   * A page with a quality selector lists one URL per quality, so the loser of
   * rule 3 is simply the other rendition of the same film. Each probe is capped
   * on its own, so one slow host cannot throw the whole comparison away.
   */
  function durationClass(info) {
    const seconds = Number(info && info.duration) || 0;
    if (seconds >= 300) return 2; // a film
    if (seconds >= 90) return 1; // at least a real scene, not a spot
    return 0; // a preview, an advert, or unknown
  }

  async function rankStreams(urls, referer) {
    const headers = streamHeaders({ referer });
    const results = await Promise.all(
      urls
        .slice(0, 4)
        .map((url) =>
          inspectPlaylist(url, { headers })
            .then((info) => ({ info, url }))
            .catch(() => null),
        ),
    );
    return results.filter(Boolean).sort((a, b) => {
      const previewA = isPreviewUrl(a.url) ? 1 : 0;
      const previewB = isPreviewUrl(b.url) ? 1 : 0;
      if (previewA !== previewB) return previewA - previewB;
      const classA = durationClass(a.info);
      const classB = durationClass(b.info);
      if (classA !== classB) return classB - classA;
      const byHeight = (b.info.height || 0) - (a.info.height || 0);
      if (byHeight) return byHeight;
      const byBandwidth = (b.info.bandwidth || 0) - (a.info.bandwidth || 0);
      if (byBandwidth) return byBandwidth;
      return (b.info.duration || 0) - (a.info.duration || 0);
    });
  }

  async function bestOf(urls, referer) {
    const ranked = await rankStreams(urls, referer);
    return ranked.length ? ranked[0].url : urls[0];
  }

  const stream = {
    id: 'stream',
    match: (url) => (isPlaylistUrl(url) ? 'stream' : null),
    async list(url) {
      const info = await inspectPlaylist(url);
      const name = nameForStream(url, info);
      return {
        resolver: 'stream',
        title: null,
        files: [
          {
            id: url,
            name,
            size: info.estimatedBytes || 0,
            mime: 'video/mp2t',
            kind: 'video',
            quality: info.height ? `${info.height}p` : null,
            note: [
              info.variants && info.variants.length > 1 ? `${info.variants.length} qualities` : 'stream',
              info.duration ? `${Math.max(1, Math.round(info.duration / 60))} min` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            ref: { resolver: 'stream', url, name, duration: info.duration, quality: info.height || null },
          },
        ],
      };
    },
    /**
     * The URL to fetch *now* is the media playlist of the best variant, not the
     * master: choosing the quality here means the download and the label on the
     * card cannot disagree.
     */
    async direct(ref) {
      const info = await inspectPlaylist(ref.url, { headers: streamHeaders(ref) });
      /* Hand the findings back to the job: the disk check and the card both
         want the length, the resolution and roughly how many bytes are coming. */
      Object.assign(ref, {
        streamUrl: info.url,
        duration: info.duration || ref.duration || 0,
        quality: info.height || ref.quality || null,
        estimatedBytes: info.estimatedBytes || 0,
        segments: info.segments || 0,
        /* Proven to work for this URL; ffmpeg sends the same to every segment. */
        streamHeaders: info.headers || null,
      });
      return info.url;
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

  /**
   * Every playlist URL a page mentions.
   *
   * Players write theirs into a script (\`file: "…/playlist.m3u8"\`, sometimes
   * with the slashes escaped as \\/ or \\u002F), and a master playlist is
   * usually on a different host than the page — that is the normal shape, not a
   * suspicious one.
   */
  function extractPlaylistUrls(html, baseUrl) {
    /* Escaped slashes are everywhere in inline JSON, and a URL split by them is
       invisible to a plain regex, so the page is flattened once for scanning. */
    const flat = String(html || '')
      .replace(/\\u002[fF]/g, '/')
      .replace(/\\\//g, '/');
    const found = [];
    const push = (raw) => {
      if (!raw) return;
      const abs = absoluteUrl(String(raw).replace(/&amp;/g, '&').trim(), baseUrl);
      if (abs && isPlaylistUrl(abs)) found.push(abs);
    };

    const looseRe = /(https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?)/gi;
    let m;
    while ((m = looseRe.exec(flat))) push(m[1]);

    /* A relative one inside a player's configuration: file/src/source/url/hls */
    const configRe = /(?:file|src|source|url|hls|m3u8)\s*[:=]\s*["']([^"'<>\s]+\.(?:m3u8|mpd)(?:\?[^"'<>\s]*)?)["']/gi;
    while ((m = configRe.exec(flat))) push(m[1]);

    /* <meta property="og:video" content="…playlist.m3u8"> — some players put the
       playlist exactly where a plain video URL would go. */
    const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*>/gi;
    while ((m = metaRe.exec(flat))) {
      const content = /content=["']([^"']+)["']/i.exec(m[0]);
      if (content) push(content[1]);
    }

    /* JSON-LD's contentUrl */
    const jsonRe = /"contentUrl"\s*:\s*"([^"]+)"/gi;
    while ((m = jsonRe.exec(flat))) push(m[1]);

    /* <source src="stream.m3u8"> and data-* attributes */
    const tagRe = /<(?:video|source)\b[^>]*\b(?:src|data-src)=["']([^"']+\.(?:m3u8|mpd)(?:\?[^"']*)?)["']/gi;
    while ((m = tagRe.exec(flat))) push(m[1]);

    const seen = new Set();
    return found.filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
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
    const files = [];
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

    /* The download anchor, whatever its classes look like. A label is a hint,
       not a requirement: some pages put an icon or nothing at all inside the
       anchor, and rejecting those is how the *player* URL ended up being tried
       as if it were the file. */
    const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
    const looksLikeFile = (href) => Boolean(signedPayload(href)) || VIDEO_EXT.test(href.split('?')[0]);
    let m;
    while ((m = anchorRe.exec(html))) {
      const [, href, text] = m;
      if (/report/i.test(text)) continue;
      if (/download|⬇|save file|JDownloader/i.test(text) || looksLikeFile(href)) {
        /* Labels only decide ordering: a real download button first, then any
           anchor that points at a file. */
        const labelled = /download|⬇|save file|JDownloader/i.test(text);
        if (labelled) push(download, href);
        else push(files, href);
      }
    }
    // A player source is the same file shown as HTML — only worth having when
    // there is no download anchor to use instead.
    const srcRe = /<(?:video|source)\b[^>]*src=["']([^"']+)["']/gi;
    while ((m = srcRe.exec(html))) push(players, m[1]);
    const og = /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (og) push(players, og[1]);

    return { download, files, players };
  }

  /**
   * True when a URL is the *player page* rather than a file: a bare media name
   * with no signed token in front of it. fileditch's player answers
   * `text/html` — a download of it fails with "that is a web page", which is
   * honest but unhelpful, so callers can see this flag and say what would
   * actually help.
   */
  function pageOnlyRef(url) {
    if (signedPayload(url)) return false;
    try {
      const parsed = new URL(url);
      return VIDEO_EXT.test(parsed.pathname) && !/\/[A-Za-z0-9_-]{24,}$/.test(parsed.pathname);
    } catch {
      return false;
    }
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
  /**
   * Everything a fileditch page offers, with the browser consulted when the
   * page itself has no download anchor.
   *
   * This is the case the app kept getting wrong: the page served to plain
   * clients has a <video> player and no anchor, because the "Download" button is
   * built by JavaScript. Every URL shape goes through here — the share page, the
   * file host and the signed link — so none of them can quietly settle for the
   * player page, which is a *.mp4 URL that only serves HTML.
   */
  async function fileditchPageLinks(html, base, fetched = {}) {
    let state = {
      html,
      base,
      cookie: fetched.cookie || null,
      userAgent: fetched.userAgent || null,
      title: fetched.title || null,
      viaBrowser: Boolean(fetched.viaBrowser),
    };
    let links = fileditchLinks(html, base);
    const anchors = () => [...links.download, ...links.files];

    if (anchors().length === 0 && !state.viaBrowser) {
      const dom = await pageHtmlViaBrowser(base);
      if (dom && dom.html) {
        const boosted = fileditchLinks(dom.html, dom.url || base);
        const found = [...boosted.download, ...boosted.files];
        /* Only take the browser's version when it found something: an empty
           DOM is not an improvement on an empty page. */
        if (found.length) {
          links = boosted;
          state = {
            html: dom.html,
            base: dom.url || base,
            cookie: dom.cookie || state.cookie,
            userAgent: dom.userAgent || state.userAgent,
            title: dom.title || state.title,
            viaBrowser: true,
          };
        }
      }
    }
    return { ...state, ...links };
  }

  async function fileditchMint(pageUrl, wantPath) {
    /* Their pages are behind Cloudflare, so this goes through fetchPage():
       plain request first, headless browser when the challenge comes back. */
    const fetched = await fetchPage(pageUrl);
    if (!fetched.html) throw new ResolveError(`fileditch answered HTTP ${fetched.status || 'nothing'}.`, 'FILEDITCH_FAILED');
    const html = fetched.html;
    const base = fetched.url || pageUrl;
    /* One place decides whether the page has to be re-read in a browser: see
       fileditchPageLinks(). Skipping it here is what let the share page hand
       back the player URL as if it were the file. */
    const page = await fileditchPageLinks(html, base, fetched);
    const { download, files: fileAnchors, players } = page;
    const anchorList = [...download, ...fileAnchors];
    const baseUrl = page.base || base;

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
    /* An anchor the page itself offers ("⬇ Download") outranks any URL that was
       merely *derived* — the page knows where its file is, and a path that does
       not match is more likely to be their encoding than a different file. A
       player page, by contrast, only counts when it looks like the file asked
       for: it is the thing that serves HTML. */
    const score = (link, isAnchor) => {
      const payload = signedPayload(link);
      const matches = !wantPath || pathOf(link).endsWith(wantPath);
      if (payload) return matches ? 4 : 3;
      /* Any anchor beats a player page, matching path or not: the player page is
         known to serve HTML, so it can only ever be the last resort. */
      if (isAnchor) return matches ? 3 : 2;
      return 0;
    };
    const scored = [
      ...anchorList.map((link) => ({ link, score: score(link, true) })),
      ...players.map((link) => ({ link, score: score(link, false) })),
    ];
    const ranked = scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.link);
    /* Nothing on the page mentions the path we came for. Their own "Download"
       anchor is still what the page tells a visitor to click, so it beats
       giving up and handing back a player URL that serves HTML. */
    if (!ranked.length) {
      for (const entry of scored) {
        if (anchorList.includes(entry.link) && !ranked.includes(entry.link)) ranked.push(entry.link);
      }
    }
    /* Nothing at all matched: a player page is still better than nothing, but
       only as the last resort — the caller filters it out of the queue. */
    /* The page we just loaded is the player URL, token and all; it is the same
       backend that the signed link proxies to. A share page (no file
       extension) is not a route to the bytes, so it does not count. */
    let baseIsFile = false;
    try {
      baseIsFile = VIDEO_EXT.test(new URL(baseUrl).pathname);
    } catch {
      /* no base */
    }
    if (baseIsFile && !ranked.includes(baseUrl)) ranked.push(baseUrl);

    if (ranked.length) {
      /* The player page is not the file, but it is a working route when the CDN
         behind the signed link misbehaves (their proxy is flaky), so it stays in
         the list — at the back, after every real candidate. */
      const links = [...ranked];
      for (const player of players) {
        if (!links.includes(player)) links.push(player);
      }
      return {
        url: ranked[0],
        links,
        html: page.html,
        base: baseUrl,
        cookie: page.cookie,
        userAgent: page.userAgent,
        title: page.title,
        viaBrowser: Boolean(page.viaBrowser),
      };
    }

    // No link at all: the page might itself be a player whose media URL is only
    // visible to a real browser.
    const viaBrowser = await pageBrowserFiles(baseUrl);
    if (viaBrowser && viaBrowser.length) {
      const links = viaBrowser.map((file) => file.ref.url).filter(Boolean);
      return {
        url: links[0],
        links,
        html: page.html,
        base: baseUrl,
        viaBrowser: true,
        cookie: page.cookie,
        userAgent: page.userAgent,
      };
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
          title: fresh.title || name,
          pageTitle: fresh.title || null,
          files: [
            {
              id: fresh.url,
              name,
              size: 0,
              mime: 'video/mp4',
              kind: 'video',
              playerish: pageOnlyRef(fresh.url),
              ref: {
                resolver: 'fileditch',
                url: fresh.url,
                page,
                referer: page,
                name,
                path: signed.path,
                cookie: fresh.cookie || null,
                userAgent: fresh.userAgent || null,
              },
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
            title: fresh.title || name,
            pageTitle: fresh.title || null,
            files: [
              {
                id: fresh.url,
                name,
                size: meta.size || 0,
                mime: 'video/mp4',
                kind: 'video',
                playerish: pageOnlyRef(fresh.url),
                ref: {
                  resolver: 'fileditch',
                  url: fresh.url,
                  page,
                  referer: page,
                  name,
                  path: filePath,
                  cookie: fresh.cookie || null,
                  userAgent: fresh.userAgent || null,
                },
              },
            ],
          };
        } catch (err) {
          /* The player page refused; reading the pasted URL as a page is the
             only thing left, and sometimes new.fileditch.com does serve it. */
          console.log(`[resolve] fileditch player page for ${filePath} failed: ${err.message}`);
        }
      }

      let fetched;
      try {
        fetched = await fetchPage(url);
      } catch (err) {
        /* A Cloudflare block is not fixed by a browser element capture. */
        if (err.code === 'CLOUDFLARE') throw err;
        fetched = { html: '', status: 0, url };
      }
      if (!fetched.html) {
        const viaBrowser = await pageBrowserFiles(url);
        if (viaBrowser && viaBrowser.length) return { resolver: 'fileditch', title: null, files: viaBrowser };
        throw new ResolveError(`fileditch answered HTTP ${fetched.status || 'nothing'}.`, 'FILEDITCH_FAILED');
      }
      const base = fetched.url || url;
      /* The page as a browser renders it, when the plain copy has no download
         anchor — which is the normal case for fileditch: the button is built by
         JavaScript, so the plain page only advertises its own player. */
      const page = await fileditchPageLinks(fetched.html, base, fetched);
      const anchored = [...page.download, ...page.files];
      const candidates = anchored.length ? anchored : page.players;
      if (!candidates.length) {
        const viaBrowser = await pageBrowserFiles(page.base || base);
        if (viaBrowser && viaBrowser.length) {
          return { resolver: 'fileditch', title: page.title || fetched.title || null, files: viaBrowser };
        }
        throw new ResolveError('fileditch did not expose a download link on that page.', 'FILEDITCH_NO_LINK');
      }

      const meta = fileditchMeta(page.html || fetched.html);
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
          playerish: pageOnlyRef(link),
          ref: {
            resolver: 'fileditch',
            url: link,
            page: page.base || base,
            referer: page.base || base,
            name,
            path: payload ? payload.path : null,
            cookie: page.cookie || fetched.cookie || null,
            userAgent: page.userAgent || fetched.userAgent || null,
            viaBrowser: Boolean(page.viaBrowser),
          },
        });
      }
      return {
        resolver: 'fileditch',
        title: page.title || fetched.title || meta.name,
        pageTitle: page.title || fetched.title || meta.name,
        files,
      };
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

      const keep = (fresh) => {
        out.push(...fresh.links);
        /* The clearance cookie belongs to this minting; the CDN wants it back. */
        if (fresh.cookie) ref.cookie = fresh.cookie;
      };
      if (page) {
        try {
          keep(await fileditchMint(page, filePath || null));
        } catch {
          /* page gone: fall back to what we stored */
        }
      }
      if (!out.length && filePath) {
        try {
          keep(await fileditchMint(pageForPath(filePath), filePath));
        } catch {
          /* nothing minted */
        }
      }
      if (ref.url && /^https?:/i.test(ref.url)) out.push(ref.url);

      const unique = [...new Set(out.filter(Boolean))];
      if (!unique.length) throw new ResolveError('fileditch did not give us a download link.', 'FILEDITCH_NO_LINK');
      /* Handing the downloader the player page first wastes a whole round trip
         on HTML (it is what "HTML_PAGE from fileditchvids.st" was), and it used
         to happen because that page is a *.mp4 URL. Their own page base is the
         last resort, always. */
      const pageHost = (() => {
        try {
          return new URL(pageBase()).hostname;
        } catch {
          return '';
        }
      })();
      const isPlayerPage = (link) => {
        if (signedPayload(link)) return false;
        try {
          return new URL(link).hostname === pageHost;
        } catch {
          return true;
        }
      };
      return [...unique.filter((link) => !isPlayerPage(link)), ...unique.filter(isPlayerPage)];
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
        /* The site refuses a plain request (missav is behind a bot check). That
           is exactly the case the browser is for — and its *HTML* is what
           carries the playlist, not its network log. */
        const viaBrowser = await browserPage(url);
        if (viaBrowser) return viaBrowser;
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
      const displayName = pageDisplayName(html);

      /* A page that plays its video from a playlist has exactly one real
         source, and it is usually on a different host than the page (an HLS
         master on the CDN, the page on the site). The loose .mp4 URLs on such a
         page are adverts — that is why this link used to resolve to an ad. A
         playlist wins over anything else, and an advert is never offered. */
      const playlists = extractPlaylistUrls(html, base).filter((u) => !isAdUrl(u));
      const urls = extractVideoUrls(html, base).filter(
        (u) =>
          !isAdUrl(u) &&
          !isPlaylistUrl(u) &&
          !looksLikeMediaSegment(u) &&
          VIDEO_EXT.test(new URL(u).pathname),
      );

      if (playlists.length) {
        /* The same master is often named twice (og:video and the player
           config); different URLs on one page usually mean the page's own
           quality selector. Quality first, so the best of them is chosen here
           and the rest are not offered as separate files to choose between. */
        const unique = [...new Set(playlists.map((url) => url.split('#')[0]))];
        const ranked = unique.length > 1 ? await rankStreams(unique, base) : [];
        const chosen = ranked.length ? ranked[0].url : unique[0];
        const titleName = displayName || fileNameFromTitle(pageTitleOf(html) || '');
        const info = await inspectPlaylist(chosen, {
          headers: streamHeaders({ referer: base }),
        }).catch(() => null);
        const files = [
          streamFileEntry(chosen, {
            name: titleName || undefined,
            referer: base,
            quality: info && info.height ? info.height : null,
            duration: info && info.duration ? info.duration : 0,
            estimatedBytes: info && info.estimatedBytes ? info.estimatedBytes : 0,
            preview: Boolean(info && info.duration > 0 && info.duration < 90),
          }),
        ];
        /* The page's own <title> travels with the job: the card shows the tab
           name of the page the link came from, not the file that comes out. */
        return {
          resolver: 'stream',
          title: null,
          pageTitle: pageTitleOf(html) || null,
          files,
          /* Every playlist the page offered, longest first: the doctor prints
             this, and it is how "it caught the preview" gets diagnosed instead
             of guessed at. */
          streamCandidates: ranked.map((entry) => ({
            url: entry.url,
            duration: entry.info.duration || 0,
            height: entry.info.height || 0,
            preview: isPreviewUrl(entry.url),
          })),
        };
      }

      if (!urls.length) {
        const viaBrowser = await browserPage(base);
        if (viaBrowser) return viaBrowser;
        const hasPlayer = /\.(m3u8|mpd)/i.test(html) || /jwplayer|videojs|hls/i.test(html);
        throw new ResolveError(
          hasPlayer
            ? 'That page streams its video, but its player builds the link in JavaScript and this machine could ' +
                'not read it. Open the player in your own browser once, copy the .m3u8 address it plays, and ' +
                'paste that — or paste the page link again from a machine with `npm run browser:install` done.'
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
      return { resolver: 'page', title: null, pageTitle: pageTitleOf(html) || null, files };
    },
    async direct(ref) {
      return ref.url;
    },
  };

  /* ----------------------------------------------------------------- registry */

  const RESOLVERS = [gofile, turbo, pixeldrain, bunkr, filester, fileditch, stream, direct, page];

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

  /* A rendered DOM is expensive (a browser launch) and the same page is read
     twice per job: once to mint the link, once to mint another at download
     time. Five minutes is short enough that a rotated token is not reused and
     long enough to pay for the launch once. */
  const pageDomCache = new Map();
  const PAGE_DOM_TTL = 5 * 60 * 1000;

  /** Ask the headless browser for a page's DOM, after any bot check has run. */
  async function pageHtmlViaBrowser(url, { fresh = false } = {}) {
    if (!pageHtmlHook) return null;
    const key = String(url);
    const hit = pageDomCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < PAGE_DOM_TTL) return hit.value;
    try {
      const result = await pageHtmlHook(url);
      if (!result || !result.html) return null;
      pageDomCache.set(key, { at: Date.now(), value: result });
      return result;
    } catch {
      return null;
    }
  }

  /** Ask the headless browser what media a page actually plays, if it is there. */
  /**
   * What a page really plays, as a real browser sees it.
   *
   * The order matters, and getting it wrong is what put twelve ad segments in
   * the picker:
   *
   *   1. the **rendered HTML** — a player keeps its playlist in an inline
   *      script, and a site behind a bot check never gets that far with a plain
   *      request. This is where missav's `surrit.com/…/playlist.m3u8` lives;
   *   2. a plain **video URL in the DOM**, when the page advertises one;
   *   3. the **network capture** — last, because a page full of adverts reports
   *      those as media too, and they look exactly like files.
   *
   * Segments and ad creatives are dropped at every step.
   */
  async function browserPage(url) {
    const dom = await pageHtmlViaBrowser(url);
    const pageUrl = (dom && dom.url) || url;
    const cookie = (dom && dom.cookie) || null;
    const userAgent = (dom && dom.userAgent) || null;

    if (dom && dom.html) {
      /* What the HTML names *and* what the player actually asked for. The two
         can disagree: a page states its preview in the markup and builds the
         film's playlist in JavaScript, so taking the HTML alone picks the
         sample. They are ranked together, longest first. */
      const playlists = [
        ...extractPlaylistUrls(dom.html, pageUrl),
        ...(Array.isArray(dom.media) ? dom.media.map((item) => item && item.url).filter(isPlaylistUrl) : []),
      ].filter((candidate) => candidate && !isAdUrl(candidate) && !looksLikeMediaSegment(candidate));
      if (playlists.length) {
        const unique = [...new Set(playlists.map((item) => item.split('#')[0]))];
        const chosen = unique.length > 1 ? await bestOf(unique, pageUrl) : unique[0];
        const name =
          pageDisplayName(dom.html) ||
          fileNameFromTitle(dom.title || pageTitleOf(dom.html)) ||
          nameForStream(chosen, {});
        const detail = await inspectPlaylist(chosen, {
          headers: streamHeaders({ referer: pageUrl, cookie, userAgent }),
        }).catch(() => null);
        const file = streamFileEntry(chosen, {
          name,
          referer: pageUrl,
          cookie,
          userAgent,
          quality: detail && detail.height ? detail.height : null,
          duration: detail && detail.duration ? detail.duration : 0,
          estimatedBytes: detail && detail.estimatedBytes ? detail.estimatedBytes : 0,
          preview: Boolean(detail && detail.duration > 0 && detail.duration < 90),
        });
        return {
          resolver: 'stream',
          title: null,
          pageTitle: dom.title || pageTitleOf(dom.html) || null,
          files: [file],
        };
      }

      const urls = extractVideoUrls(dom.html, pageUrl).filter(
        (candidate) =>
          !isPlaylistUrl(candidate) &&
          !isAdUrl(candidate) &&
          !looksLikeMediaSegment(candidate) &&
          VIDEO_EXT.test(new URL(candidate).pathname),
      );
      if (urls.length) {
        const displayName = pageDisplayName(dom.html) || fileNameFromTitle(dom.title || '');
        const files = urls.slice(0, 10).map((videoUrl, index) => {
          let name = `video-${index + 1}.mp4`;
          try {
            const last = decodeURIComponent(new URL(videoUrl).pathname.split('/').filter(Boolean).pop() || '');
            if (last && VIDEO_EXT.test(last)) name = last;
          } catch {
            /* keep default */
          }
          if (index === 0 && displayName) name = preferPageName(name, displayName);
          return {
            id: videoUrl,
            name,
            size: 0,
            mime: '',
            kind: 'video',
            ref: { resolver: 'direct', url: videoUrl, name, referer: pageUrl, cookie, userAgent },
          };
        });
        return { resolver: 'browser', title: null, pageTitle: dom.title || null, files };
      }
    }

    /* No playlist in the HTML. The same visit already watched the player make
       its requests (a second launch would cost another bot check), so rank
       *those* — by length first, then picture — instead of asking again. */
    const observed = Array.isArray(dom && dom.media) ? dom.media : null;
    if (observed && observed.length) {
      const listed = await filesFromBrowserMedia(observed, { ...(dom || {}), fallbackUrl: pageUrl });
      if (listed && listed.length) return { resolver: 'browser', title: null, files: listed };
    }
    const media = await pageBrowserFiles(url);
    if (media && media.length) return { resolver: 'browser', title: null, files: media };
    return null;
  }

  /** One entry for a stream: the shape the page and the browser both produce. */
  function streamFileEntry(
    streamUrl,
    { name, referer, cookie, userAgent, quality, mime, duration, estimatedBytes, preview } = {},
  ) {
    const fileName = String(name || nameForStream(streamUrl, { height: Number(quality) || 0 }))
      .replace(/\.(m3u8|mpd)$/i, '.mp4');
    const minutes = Number(duration) > 0 ? Math.max(1, Math.round(Number(duration) / 60)) : 0;
    return {
      id: streamUrl,
      name: fileName,
      size: Number(estimatedBytes) || 0,
      mime: mime || 'application/vnd.apple.mpegurl',
      kind: 'video',
      quality: quality ? `${quality}p` : null,
      /* The length is what tells a film apart from a sample, so it belongs on
         the card, not only in the encoder. */
      duration: Number(duration) || 0,
      note: preview ? 'a short preview, not the film' : minutes ? `stream · ${minutes} min` : 'stream',
      ref: {
        resolver: 'stream',
        url: streamUrl,
        name: fileName,
        referer: referer || null,
        cookie: cookie || null,
        userAgent: userAgent || null,
      },
    };
  }

  /**
   * Turn what a browser saw into files, dropping everything that is not a
   * video: adverts, segments, and — when ranking playlists — the shorter one.
   */
  async function filesFromBrowserMedia(
    rawMedia,
    { cookie = null, userAgent = null, title = null, fallbackUrl = null } = {},
  ) {
    const media = Array.isArray(rawMedia) ? rawMedia : [];
    const pageUrl = fallbackUrl || '';

    /* A player that streams reports every segment as "media": hundreds of
       URLs that are pieces of one video, not hundreds of videos. Only the
       playlist is a file worth listing. */
    const playable = media.filter((item) => {
      if (!item || !item.url || isAdUrl(item.url)) return false;
      if (isPlaylistUrl(item.url)) return true;
      /* Everything else must be a whole file: a segment is a piece of one,
         and an advert pretending to be a file is not the video. */
      return !looksLikeMediaSegment(item.url);
    });

    /* A stream wins over anything else the browser saw: the .mp4s on such a
       page are adverts (and the ad filter above only knows the ones it has
       heard of). Several playlists mean the page's own quality selector — or a
       preview next to the feature — so `bestOf` weighs them by length and
       picture, exactly like a page that names them in HTML. */
    const playlistUrls = [...new Set(playable.filter((item) => isPlaylistUrl(item.url)).map((item) => item.url))];
    if (playlistUrls.length) {
      const chosen = playlistUrls.length > 1 ? await bestOf(playlistUrls, pageUrl) : playlistUrls[0];
      const item = playable.find((entry) => entry.url === chosen) || { url: chosen };
      /* The browser knows the clearance cookie it earned, and the user agent
         that earned it — both are needed again by the CDN. */
      const refCookie = item.cookie || cookie || null;
      const refUserAgent = item.userAgent || userAgent || null;
      const referer = item.referer || pageUrl;
      const info = await inspectPlaylist(chosen, {
        headers: streamHeaders({ referer, cookie: refCookie, userAgent: refUserAgent }),
      }).catch(() => null);
      return [
        streamFileEntry(chosen, {
          name: (title && fileNameFromTitle(title)) || undefined,
          referer,
          cookie: refCookie,
          userAgent: refUserAgent,
          quality: info && info.height ? info.height : null,
          duration: (info && info.duration) || 0,
          estimatedBytes: (info && info.estimatedBytes) || 0,
          preview: Boolean(info && info.duration > 0 && info.duration < 90),
          mime: item.contentType,
        }),
      ];
    }

    /* Whole files only, and a preview sorts below a film: a page can carry
       both a two-minute sample and the real download link. */
    const files = playable
      .slice()
      .sort((a, b) => {
        const previewA = isPreviewUrl(a.url) ? 1 : 0;
        const previewB = isPreviewUrl(b.url) ? 1 : 0;
        if (previewA !== previewB) return previewA - previewB;
        return (Number(b.size) || 0) - (Number(a.size) || 0);
      })
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
          ref: {
            resolver: 'direct',
            url: item.url,
            name,
            referer: item.referer || pageUrl,
            cookie: item.cookie || cookie || null,
            userAgent: item.userAgent || userAgent || null,
          },
        };
      });
    return files.length ? files : null;
  }

  async function pageBrowserFiles(url) {
    if (!pageBrowserHook) return null;
    try {
      const result = await pageBrowserHook(url);
      const media = Array.isArray(result) ? result : (result && result.media) || [];
      return await filesFromBrowserMedia(media, { ...(result || {}), fallbackUrl: url });
    } catch {
      return null;
    }
  }

  function setPageBrowser(hook) {
    pageBrowserHook = typeof hook === 'function' ? hook : null;
  }

  function setPageHtmlBrowser(hook) {
    pageHtmlHook = typeof hook === 'function' ? hook : null;
    /* A different browser (or none) must not be answered from the old cache. */
    pageDomCache.clear();
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
    setPageHtmlBrowser,
    pageTitleOf,
    isChallenge,
    gofileDownloadHeaders,
    /* streams */
    isPlaylistUrl,
    isAdUrl,
    isAdCreativeUrl,
    isPreviewUrl,
    looksLikeMediaSegment,
    extractPlaylistUrls,
    parsePlaylistText,
    pickBestVariant,
    variantHeight,
    inspectPlaylist,
    rankStreams,
    nameForStream,
    fileNameFromTitle,
    clearStreamCache,
  };
});
