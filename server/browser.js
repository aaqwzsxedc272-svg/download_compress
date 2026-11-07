'use strict';
/**
 * Optional headless-browser fallback for hosts that only talk to a real browser.
 *
 * gofile ships `/js/wt.obf.js`, which mints the `wt` token the API demands; a
 * plain HTTP client can never produce it. Chromium runs that script exactly as a
 * visitor's browser would, and we read the folder straight out of the API
 * responses the page makes for itself.
 *
 * Playwright is NOT a dependency of this project on purpose: it is ~100 MB and
 * only some deployments need it. Install it where you need it:
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *
 * Without it every function here reports `available() === false` and the app
 * falls back to its normal HTTP paths.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let playwright = null;
let loadError = null;

function load() {
  if (playwright || loadError) return playwright;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    playwright = require('playwright');
  } catch (err) {
    loadError = err;
    playwright = null;
  }
  return playwright;
}

const available = () => Boolean(load() && load().chromium);

/* Module scope, because more than one capture path watches a page now. These
   lived inside captureMedia, and when capturePage grew its own watcher the
   reference below was resolved at *event* time — inside a Playwright callback,
   where a ReferenceError does not fail the capture, it kills the server. */
const MEDIA = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpe?g|ts|m4s|3gp|ogv|m3u8|mpd)(\?|#|$)/i;
const PLAYLIST_TYPE = /(?:mpegurl|dash\+xml|x-mpegurl)/i;

/**
 * Wrap a page event listener so nothing it does can escape.
 *
 * A Playwright listener runs on the event loop, not inside the async function
 * that opened the page: a throw there is an uncaught exception, and an uncaught
 * exception takes the whole server with it — including a download that has been
 * running for twenty minutes. The listener's job is to *observe*, so a failure
 * to observe must never be fatal.
 */
let lastListenerError = null;
function safeListener(name, fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          lastListenerError = { name, message: err && err.message, at: Date.now() };
        });
      }
    } catch (err) {
      lastListenerError = { name, message: err && err.message, at: Date.now() };
    }
  };
}
const listenerErrors = () => lastListenerError;

/** Turn one gofile contents payload into our file shape. */
function mapContents(payload, code) {
  if (!payload || payload.status !== 'ok' || !payload.data) return null;
  const node = payload.data;
  if (node.id && code && node.id !== code && !node.children && !node.contents) return null;
  const children = node.children || node.contents || {};
  const files = Object.values(children)
    .filter((child) => child && child.type === 'file')
    .map((child) => ({
      id: child.id,
      name: child.name || 'video',
      size: Number(child.size) || 0,
      mime: child.mimetype || '',
      kind: /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpe?g|ts|3gp|ogv)$/i.test(child.name || '') ? 'video' : 'other',
      ref: {
        resolver: 'gofile',
        id: child.id,
        name: child.name,
        server: child.server || child.serverChoosen || null,
        link: child.link || null,
      },
    }));
  return files.length ? files : null;
}

/**
 * Open a gofile folder in Chromium and return its files.
 * Throws BROWSER_UNAVAILABLE when Playwright is not installed.
 */
async function gofileFolder(code, { timeoutMs = 60_000 } = {}) {
  const pw = load();
  if (!pw || !pw.chromium) {
    throw Object.assign(new Error('The headless browser is not installed on this machine.'), {
      code: 'BROWSER_UNAVAILABLE',
    });
  }

  const browser = await pw.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    const page = await context.newPage();
    const payloads = [];

    page.on(
      'response',
      safeListener('gofile.response', (response) => {
        const url = response.url();
        if (!/api\.gofile\.io\/contents\//i.test(url)) return;
        response
          .json()
          .then((payload) => payloads.push(payload))
          .catch(() => {
            /* not json, ignore */
          });
      }),
    );

    await page.goto(`https://gofile.io/d/${code}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // The token script runs after load; give the folder call time to happen.
    const deadline = Date.now() + timeoutMs;
    while (!payloads.length && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }

    /* gofile ties a download to this browser session, so hand its cookie back to
       the caller: the plain fetch that streams the file then looks like the same
       visitor who opened the folder. */
    const cookies = await context.cookies('https://gofile.io').catch(() => []);
    const account = cookies.find((c) => /accounttoken/i.test(c.name));
    const cookie = account ? `${account.name}=${account.value}` : null;

    /* The download URL the page itself uses is signed per session; capture it by
       letting the page start a download and aborting it before the bytes arrive. */
    let downloadUrl = null;
    try {
      await context.route('**/download/**', async (route) => {
        if (!downloadUrl) downloadUrl = route.request().url();
        await route.abort();
      });
      const button = page.locator('text=/^\s*Download\s*$/').first();
      if (await button.count()) {
        await button.click({ timeout: 5000 }).catch(() => {});
        for (let i = 0; i < 20 && !downloadUrl; i += 1) await page.waitForTimeout(200);
      }
      await context.unroute('**/download/**');
    } catch {
      /* no clickable download, keep the API link */
    }

    for (const payload of payloads) {
      const files = mapContents(payload, code);
      if (files) {
        if (downloadUrl) {
          const first = files.find((f) => f.kind === 'video') || files[0];
          if (first) first.ref.link = downloadUrl;
        }
        return { files, cookie, downloadUrl };
      }
    }

    // Last resort: whatever download links the rendered page exposes.
    const links = await page
      .$$eval('a[href*="/download/"]', (nodes) => nodes.map((n) => ({ href: n.href, text: n.textContent || '' })))
      .catch(() => []);
    const fromDom = links
      .filter((l) => /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(new URL(l.href).pathname))
      .map((l) => {
        const name = decodeURIComponent(new URL(l.href).pathname.split('/').pop() || 'video.mp4');
        return {
          id: name,
          name,
          size: 0,
          mime: '',
          kind: 'video',
          ref: { resolver: 'gofile', id: name, name, link: l.href },
        };
      });
    return fromDom.length ? { files: fromDom, cookie, downloadUrl } : null;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Load any page in Chromium and catch whatever video it plays.
 *
 * Bot-protected hosts (filester behind DDoS-Guard, fileditch behind hotlink
 * rules) answer a plain fetch with a challenge page and refuse cross-origin
 * reads from your browser. A real browser solves the challenge and its own
 * player requests the media, so the URL can simply be observed.
 */
async function captureMedia(url, { timeoutMs = 45_000, settleMs = 6000, includeAnchors = false } = {}) {
  const pw = load();
  if (!pw || !pw.chromium) {
    throw Object.assign(new Error('The headless browser is not installed on this machine.'), {
      code: 'BROWSER_UNAVAILABLE',
    });
  }

  const seen = new Map();

  const browser = await pw.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });
    const page = await context.newPage();

    const remember = (rawUrl, meta = {}) => {
      if (!rawUrl || !/^https?:/i.test(rawUrl)) return;
      const clean = rawUrl.split('#')[0];
      if (!MEDIA.test(clean) && !meta.force) return;
      if (seen.has(clean)) return;
      seen.set(clean, {
        url: clean,
        contentType: meta.contentType || '',
        size: Number(meta.size) || 0,
        referer: meta.referer || '',
        cookie: meta.cookie || '',
      });
    };

    page.on(
      'request',
      safeListener('media.request', (request) => {
        const headers = request.headers();
        const meta = {
          force: request.resourceType() === 'media',
          referer: headers.referer || '',
          cookie: headers.cookie || '',
        };
        remember(request.url(), meta);
      }),
    );
    page.on(
      'response',
      safeListener('media.response', (response) => {
        const type = (response.headers()['content-type'] || '').toLowerCase();
        if (type.startsWith('video/') || type === 'application/octet-stream' || PLAYLIST_TYPE.test(type)) {
          remember(response.url(), {
            force: type.startsWith('video/') || PLAYLIST_TYPE.test(type),
            contentType: type,
            size: response.headers()['content-length'],
          });
        }
      }),
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(settleMs);
    const cookieHeader =
      (await context.cookies().catch(() => [])).map((c) => `${c.name}=${c.value}`).join('; ') || '';

    // Some players only start on a click; try the usual suspects once. A
    // player that needs a real play() call is the difference between seeing
    // its segments and seeing nothing at all.
    for (const selector of ['video', 'button[class*="play" i]', '[class*="player" i]']) {
      const target = page.locator(selector).first();
      if (await target.count().catch(() => 0)) {
        await target.click({ timeout: 1500, force: true }).catch(() => {});
      }
    }
    await page
      .evaluate(() => {
        for (const video of document.querySelectorAll('video')) {
          video.muted = true;
          Promise.resolve(video.play && video.play()).catch(() => {});
        }
      })
      .catch(() => {});
    await page.waitForTimeout(3000);

    // Read what the DOM advertises too: <video src>, <source>, og:video, and —
    // when asked — the anchors, which is where a "Download" button points once
    // JavaScript has built it.
    const playing = await page
      .evaluate(() =>
        [...document.querySelectorAll('video')].map((v) => ({
          url: v.currentSrc || v.src || '',
          duration: Number(v.duration) || 0,
          paused: Boolean(v.paused),
          readyState: Number(v.readyState) || 0,
        })),
      )
      .catch(() => []);

    const dom = await page
      .evaluate((withAnchors) => {
        const out = [];
        const anchors = [];
        const push = (value) => {
          if (value) out.push(new URL(value, location.href).href);
        };
        document.querySelectorAll('video').forEach((v) => push(v.currentSrc || v.src));
        document.querySelectorAll('video source, source').forEach((s) => push(s.src));
        const og = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
        if (og) push(og.getAttribute('content'));
        if (withAnchors) {
          document.querySelectorAll('a[href]').forEach((a) => {
            const label = `${a.textContent || ''} ${a.className || ''} ${a.id || ''}`;
            anchors.push({
              href: new URL(a.getAttribute('href'), location.href).href,
              download: /download|⬇|save|get file/i.test(label),
            });
          });
        }
        return { media: out, anchors };
      }, Boolean(includeAnchors))
      .catch(() => ({ media: [], anchors: [] }));
    /* `|| ...`: evaluate() can resolve to nothing on a page whose document is
       already gone, and reading `.media` of nothing is how one bad page becomes
       a dead server. */
    (dom || { media: [], anchors: [] }).media.forEach((u) => remember(u, { force: true }));

    if (includeAnchors) {
      for (const anchor of (dom || {}).anchors || []) {
        const clean = String(anchor.href || '').split('#')[0];
        if (!/^https?:/i.test(clean)) continue;
        /* Either it names a file, or it is an opaque signed token (base64-ish,
           no extension) such as fileditch hands out. */
        const tokenish = /\/[A-Za-z0-9_-]{24,}$/.test(new URL(clean).pathname);
        const named = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpe?g|ts|3gp|ogv)(\?|#|$)/i.test(clean);
        if (!anchor.download && !named && !tokenish) continue;
        remember(clean, { force: true, cookie: cookieHeader });
      }
    }

    const cookies = await context.cookies().catch(() => []);
    return {
      media: [...seen.values()],
      playing,
      title: await page.title().catch(() => null),
      url: page.url(),
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') || null,
      /* Cloudflare ties cf_clearance to this string: the download has to use
         the same one or the cookie is worthless. */
      userAgent: UA,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/* A page that is a bot check rather than the file's own page. */
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verifying you are human|ddos-guard|one more step/i;

/**
 * Load a page in a real browser and hand back its DOM once any bot check has
 * run, plus the cookies the browser earned.
 *
 * This is the part Cloudflare actually checks: the challenge script runs, the
 * browser solves it and gets a `cf_clearance` cookie. Passing that cookie back
 * is what lets the server download the video afterwards — the CDN checks it
 * again on the file request.
 *
 * @returns {Promise<{url: string, title: string, html: string, cookie: string|null, challenged: boolean}>}
 */
async function capturePage(url, { timeoutMs = 60_000, settleMs = 2500, waitFor = null } = {}) {
  const pw = load();
  if (!pw || !pw.chromium) {
    throw Object.assign(new Error('The headless browser is not installed on this machine.'), {
      code: 'BROWSER_UNAVAILABLE',
    });
  }

  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      timezoneId: 'Europe/Lisbon',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });
    await context.addInitScript(() => {
      // The cheapest automation tell there is; Cloudflare scores it.
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();

    /* One visit has to answer three questions — what does the HTML say, what
       did the player actually request, and how long was the video — because a
       second visit costs another Cloudflare challenge and can drop the
       clearance the first one earned. */
    const seen = new Map();
    const remember = (rawUrl, meta = {}) => {
      if (!rawUrl || !/^https?:/i.test(rawUrl)) return;
      const clean = rawUrl.split('#')[0];
      if (!MEDIA.test(clean) && !meta.force) return;
      if (seen.has(clean)) return;
      seen.set(clean, {
        url: clean,
        contentType: meta.contentType || '',
        size: Number(meta.size) || 0,
        referer: meta.referer || '',
        cookie: meta.cookie || '',
      });
    };
    page.on(
      'request',
      safeListener('page.request', (request) => {
        const headers = request.headers();
        remember(request.url(), {
          force: request.resourceType() === 'media',
          referer: headers.referer || '',
          cookie: headers.cookie || '',
        });
      }),
    );
    page.on(
      'response',
      safeListener('page.response', (response) => {
        const type = (response.headers()['content-type'] || '').toLowerCase();
        if (type.startsWith('video/') || type === 'application/octet-stream' || PLAYLIST_TYPE.test(type)) {
          remember(response.url(), {
            force: true,
            contentType: type,
            size: response.headers()['content-length'],
          });
        }
      }),
    );

    const started = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});

    /* Wait for the challenge to finish: their interstitial reloads the page
       itself, so the title is the reliable signal. */
    let title = '';
    let challenged = false;
    while (Date.now() - started < timeoutMs) {
      title = await page.title().catch(() => '');
      challenged = CHALLENGE_TITLE.test(title);
      if (!challenged) break;
      await page.waitForTimeout(1200);
    }
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: Math.max(2000, timeoutMs - (Date.now() - started)) }).catch(() => {});
    }
    await page.waitForTimeout(settleMs);

    /* A player that has not started has not requested its playlist, and a page
       whose video only appears on a click looks identical to a page with no
       video at all. Press play the ways a person does, then give the player a
       few seconds to ask for its manifest. */
    const playlistsSeen = () => [...seen.keys()].filter((candidate) => /\.(m3u8|mpd)(?:\?|$)/i.test(candidate));
    if (!playlistsSeen().length) {
      for (const selector of ['video', 'button[class*="play" i]', '[class*="player" i]', '[class*="vjs" i]']) {
        const target = page.locator(selector).first();
        if (await target.count().catch(() => 0)) {
          await target.click({ timeout: 1500, force: true }).catch(() => {});
        }
      }
      await page
        .evaluate(() => {
          for (const video of document.querySelectorAll('video')) {
            video.muted = true;
            Promise.resolve(video.play && video.play()).catch(() => {});
          }
        })
        .catch(() => {});
      const deadline = Date.now() + Math.min(12_000, Math.max(3_000, timeoutMs - (Date.now() - started)));
      while (Date.now() < deadline && !playlistsSeen().length) {
        await page.waitForTimeout(500);
      }
    }

    /* Which stream is the film? The page answers that itself: a <video>
       element that is playing says so, and reports how long the video is. On a
       page with three players (the film, a banner, a trailer) that is the one
       fact an advert cannot fake. */
    const playing = await page
      .evaluate(() =>
        [...document.querySelectorAll('video')].map((v) => ({
          url: v.currentSrc || v.src || '',
          duration: Number(v.duration) || 0,
          paused: Boolean(v.paused),
          readyState: Number(v.readyState) || 0,
        })),
      )
      .catch(() => []);

    /* The player is often in an iframe on another host, and that frame's HTML
       is where its playlist lives — the main document's HTML would miss it. */
    const mainHtml = await page.content().catch(() => '');
    const frameHtml = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const content = await frame.content().catch(() => '');
      if (content && content.length > 200) frameHtml.push(content);
    }
    const html = [mainHtml, ...frameHtml].join('\n<!-- frame -->\n');
    const cookies = await context.cookies().catch(() => []);
    return {
      url: page.url(),
      title: await page.title().catch(() => title),
      html,
      media: [...seen.values()],
      playing,
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') || null,
      /* cf_clearance is bound to the user agent that earned it, so the
         download has to use this exact string. */
      userAgent: UA,
      challenged: CHALLENGE_TITLE.test(await page.title().catch(() => '')),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}


/**
 * Fetch one URL *inside* a browser and report what came back.
 *
 * Two callers, one question. The doctor asks it to split a broken link from a
 * broken *client*: a CDN that serves this URL to Chromium and refuses it to us
 * is refusing the request's origin, not its URL. The resolver asks it to read a
 * playlist that no request of ours could read, so a pasted .m3u8 link is not a
 * dead end.
 *
 * `want` decides what crosses back: text (a playlist), or just the byte count
 * (a segment, which may be gigabytes and must not be copied twice).
 */
async function fetchInBrowser(pageUrl, url, { timeoutMs = 45_000, want = 'text' } = {}) {
  const pw = load();
  if (!pw || !pw.chromium) {
    throw Object.assign(new Error('The headless browser is not installed on this machine.'), {
      code: 'BROWSER_UNAVAILABLE',
    });
  }
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();

    /* Opening the page first is the whole point: whatever the CDN wants is
       issued to the visit, and `credentials: 'include'` replays it. */
    const started = Date.now();
    if (pageUrl) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      while (Date.now() - started < timeoutMs) {
        const title = await page.title().catch(() => '');
        if (!CHALLENGE_TITLE.test(title)) break;
        await page.waitForTimeout(1200);
      }
      await page.waitForTimeout(1000);
    }

    const evaluateFetch = ({ href, asText }) =>
      page
        .evaluate(
          async ({ target, text }) => {
            try {
              const res = await fetch(target, { credentials: 'include' });
              const contentType = res.headers.get('content-type') || '';
              if (!res.ok) return { status: res.status, bytes: 0, contentType, finalUrl: res.url || target };
              if (text) {
                const body = await res.text();
                return { status: res.status, bytes: body.length, contentType, finalUrl: res.url || target, text: body };
              }
              const body = await res.arrayBuffer();
              return { status: res.status, bytes: body.byteLength, contentType, finalUrl: res.url || target };
            } catch (err) {
              /* status 0: the page could not make the request. Either the
                 network failed or the response was opaque to it — CORS. */
              return { status: 0, bytes: 0, error: String(err && err.message) };
            }
          },
          { target: href, text: asText },
        )
        .catch(() => null);

    /* A cross-origin response without `Access-Control-Allow-Origin` is a
       TypeError in JS, and the CDN never learns it was refused: from the
       server's point of view there was no answer at all. A top-level navigation
       is not CORS-checked, so it is the second way in — still Chromium, still
       the same session. */
    const readViaNavigation = async (href, asText) => {
      const wanted = String(href).split('?')[0];
      const seen = page
        .waitForResponse((response) => String(response.url()).split('?')[0] === wanted, {
          timeout: Math.min(timeoutMs, 45_000),
        })
        .catch(() => null);
      const going = page.goto(href, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => null);
      const response = await seen;
      await going;
      if (!response) return { status: 0, bytes: 0 };
      const status = response.status();
      const headers = response.headers ? response.headers() : {};
      const contentType = headers['content-type'] || '';
      if (status < 200 || status >= 300) return { status, bytes: 0, contentType, finalUrl: href };
      const body = await response.body().catch(() => null);
      if (asText) {
        const text = body ? body.toString('utf8') : '';
        return { status, bytes: text.length, contentType, finalUrl: href, text };
      }
      /* A byte probe is a size question, not a copy: prefer the header. */
      const declared = Number(headers['content-length'] || 0);
      return { status, bytes: declared || (body ? body.length : 0), contentType, finalUrl: href };
    };

    let answer = await evaluateFetch({ href: url, asText: want === 'text' });
    if (!answer || !answer.status) answer = await readViaNavigation(url, want === 'text');

    const jar = await context.cookies().catch(() => []);
    return {
      ...(answer || { status: 0, bytes: 0 }),
      cookie: (jar || []).map((item) => `${item.name}=${item.value}`).join('; '),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The doctor's question: does a real browser get served? */
async function probeInBrowser(pageUrl, url, { timeoutMs = 45_000 } = {}) {
  return fetchInBrowser(pageUrl, url, { timeoutMs, want: 'bytes' });
}

/* ------------------------------------------------------------------ streams */

/**
 * Download a stream *through the browser*.
 *
 * Why this exists: the CDN in the field (surrit.com, behind DDoS-Guard) serves
 * its playlist and its segments to a real Chromium and refuses the very same
 * URLs to Node and to ffmpeg — with the page's cookies, the page's referer and
 * the page's user agent. A request can be identical in every header and still
 * be a different client: TLS fingerprint, HTTP/2 settings, ALPN. No amount of
 * header work fixes that, and pretending otherwise is how a job fails again.
 *
 * So the bytes are fetched by the only client the CDN accepts. The page loads
 * in Chromium, and `fetch()` runs *inside* it with `credentials: 'include'`:
 * same origin policy, same cookie jar, same TLS stack, same request the player
 * makes. Each piece comes back base64 (the only way bytes cross the CDP
 * boundary) and is written straight to disk, so a 2.5 GB film never sits in
 * memory.
 *
 * What comes out is a directory holding the segments and a rewritten playlist
 * that points at them — ffmpeg then remuxes local files and touches no network.
 */
async function streamDownload(
  pageUrl,
  streamUrl,
  { destDir, onProgress, duration = 0, signal, timeoutMs = 60_000, concurrency = 3 } = {},
) {
  const pw = load();
  if (!pw || !pw.chromium) {
    throw Object.assign(new Error('The headless browser is not installed on this machine.'), {
      code: 'BROWSER_UNAVAILABLE',
    });
  }
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  await fsp.mkdir(destDir, { recursive: true });

  const aborted = () => Boolean(signal && signal.aborted);
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      timezoneId: 'Europe/Lisbon',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();

    /* The page is opened first and its player is allowed to run: that is what
       earns whatever the CDN wants, and it is the only reason to have a page at
       all. A failure here is not fatal — streaming from the page's own origin
       may still work. */
    const started = Date.now();
    if (pageUrl) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      while (Date.now() - started < timeoutMs) {
        const title = await page.title().catch(() => '');
        if (!CHALLENGE_TITLE.test(title)) break;
        await page.waitForTimeout(1200);
      }
      await page
        .evaluate(() => {
          for (const video of document.querySelectorAll('video')) {
            video.muted = true;
            Promise.resolve(video.play && video.play()).catch(() => {});
          }
        })
        .catch(() => {});
      await page.waitForTimeout(1500);
    }

    /* One way in, two ways through: ask the page's own JavaScript first, and if
       it cannot (a CDN that sends no CORS headers makes that request a network
       error, not a 403), navigate to the URL instead — a top-level navigation is
       never CORS-checked, and it is still Chromium making the request.

       Both paths hand back a Buffer, so what follows does not care which one
       ran. Base64 is only used on the first path because that is the only way
       bytes cross the CDP boundary from JS; the navigation path hands them over
       directly. */
    const readViaJavaScript = async (url, asText) => {
      const out = await page
        .evaluate(async ({ target, asText }) => {
          try {
            const res = await fetch(target, { credentials: 'include' });
            if (asText) {
              return { status: res.status, finalUrl: res.url || target, text: await res.text() };
            }
            if (!res.ok) return { status: res.status, b64: null };
            const buffer = new Uint8Array(await res.arrayBuffer());
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < buffer.length; i += chunk) {
              binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
            }
            return { status: res.status, b64: btoa(binary), length: buffer.length };
          } catch (err) {
            /* status 0: the page could not make the request at all. */
            return { status: 0, b64: null, text: '', finalUrl: target, error: String(err && err.message) };
          }
        }, { target: url, asText })
        .catch(() => null);
      return out || { status: 0, b64: null, text: '' };
    };

    /* One navigation at a time: the page has one top-level document, and two
       `goto`s racing would tear each other's response out from under it. */
    let navigating = Promise.resolve();
    const readViaNavigation = (url) => {
      const run = navigating.then(() => navigateAndRead(url));
      navigating = run.catch(() => {});
      return run;
    };
    const navigateAndRead = async (url) => {
      /* A navigation is not CORS-checked, so this is the path that works when
         the CDN refuses to let the page read its own response. */
      const wanted = url.split('?')[0];
      const seen = page
        .waitForResponse((response) => String(response.url()).split('?')[0] === wanted, {
          timeout: Math.min(timeoutMs, 45_000),
        })
        .catch(() => null);
      const going = page.goto(url, { waitUntil: 'commit', timeout: timeoutMs }).catch(() => null);
      const response = await seen;
      await going;
      if (!response) return { status: 0, buffer: null, via: 'navigation' };
      const status = response.status();
      const buffer =
        status >= 200 && status < 300
          ? await response.body().catch(() => null)
          : null;
      return { status, buffer, via: 'navigation' };
    };

    /** Read one URL through the browser: JS first, navigation if it must. */
    const readUrl = async (url, { asText = false } = {}) => {
      const viaJs = await readViaJavaScript(url, asText);
      if (viaJs.status) {
        return {
          status: viaJs.status,
          /* A text read gives text; a byte read gives a Buffer. Never both
             encodings of the same piece — a 2.5 GB film must not be copied. */
          buffer: asText ? null : viaJs.b64 ? Buffer.from(viaJs.b64, 'base64') : null,
          text: asText ? viaJs.text || '' : '',
          finalUrl: viaJs.finalUrl || url,
          via: 'fetch',
        };
      }
      const viaNav = await readViaNavigation(url);
      return {
        status: viaNav.status,
        buffer: viaNav.buffer,
        text: viaNav.buffer ? viaNav.buffer.toString('utf8') : '',
        finalUrl: url,
        via: viaNav.via,
      };
    };

    const fetchText = async (url) => {
      const out = await readUrl(url, { asText: true });
      return { status: out.status, finalUrl: out.finalUrl, text: out.text };
    };

    const fetchBytes = async (url) => {
      const out = await readUrl(url);
      return { status: out.status, b64: out.buffer ? out.buffer : null };
    };

    /* ---- the playlists, read in the browser ------------------------------ */
    let playlistUrl = streamUrl;
    let master = await fetchText(playlistUrl);
    if (!master.status || master.status >= 400 || !/#EXTM3U|#EXT-X-|<MPD/i.test(master.text || '')) {
      throw Object.assign(
        new Error(
          `The browser could not read the playlist either (HTTP ${master.status || 'no answer'}). ` +
            'If the video plays in your own browser, copy the .m3u8 address from its network tab and paste that.',
        ),
        { code: 'STREAM_FORBIDDEN' },
      );
    }

    /* A master is a menu of qualities: take the best, exactly like the resolver
       does, so what downloads here is what the card promised. */
    let mediaText = master.text;
    let mediaUrl = master.finalUrl || playlistUrl;
    if (/#EXT-X-STREAM-INF/i.test(mediaText)) {
      const variants = [];
      const lines = mediaText.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!/^#EXT-X-STREAM-INF/i.test(line)) continue;
        const attrs = line.slice(line.indexOf(':') + 1);
        const resolution = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
        const bandwidth = /BANDWIDTH=(\d+)/i.exec(attrs);
        let uri = '';
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j].trim();
          if (!next || next.startsWith('#')) continue;
          uri = next;
          break;
        }
        if (uri) {
          variants.push({
            uri: new URL(uri, mediaUrl).href,
            height: resolution ? Number(resolution[2]) : 0,
            bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
          });
        }
      }
      if (!variants.length) throw Object.assign(new Error('That playlist lists no qualities.'), { code: 'STREAM_NO_VARIANTS' });
      variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
      const best = variants[0];
      const variant = await fetchText(best.uri);
      if (!variant.status || variant.status >= 400) {
        throw Object.assign(new Error(`The best quality playlist answered HTTP ${variant.status}.`), {
          code: 'STREAM_BAD_STATUS',
        });
      }
      mediaText = variant.text;
      mediaUrl = variant.finalUrl || best.uri;
    }

    if (/#EXT-X-KEY:[^\n]*(SAMPLE-AES|com\.apple\.streamingkeydelivery|widevine|playready|fairplay)/i.test(mediaText)) {
      throw Object.assign(new Error('That stream is protected by DRM, so its video cannot be saved.'), {
        code: 'STREAM_DRM',
      });
    }

    /* ---- segments, and whatever keys or init pieces they need ------------ */
    const dirOf = (href) => href.slice(0, href.lastIndexOf('/') + 1);
    const base = dirOf(mediaUrl);
    const lines = mediaText.split(/\r?\n/);
    const pieces = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      pieces.push(new URL(line, base).href);
    }
    if (!pieces.length) throw Object.assign(new Error('That playlist lists no video segments.'), { code: 'STREAM_EMPTY' });
    if (pieces.some((piece) => /\.(m3u8|mpd)(\?|$)/i.test(piece))) {
      /* A playlist of playlists is not handled here on purpose: ffmpeg does
         that well locally, and guessing would produce a broken file. */
      throw Object.assign(new Error('That stream nests playlists; its media playlist is needed.'), {
        code: 'STREAM_NESTED',
      });
    }

    const localFor = (index, href) => {
      const ext = (/\.(m4s|mp4|aac|ts|cmfv|cmfa)(\?|$)/i.exec(href) || [null, 'ts'])[1].toLowerCase();
      return `piece-${String(index).padStart(5, '0')}.${ext}`;
    };

    /* EXT-X-MAP (fragmented MP4) and AES-128 keys are fetched the same way, and
       the playlist is rewritten to point at the local copies — ffmpeg is then
       only ever reading files. */
    const extraTags = [];
    let mapName = null;
    let keyName = null;
    let keyIv = null;
    const mapTag = /#EXT-X-MAP:([^\n]*URI="([^"]+)")/i.exec(mediaText);
    if (mapTag) {
      mapName = 'init.mp4';
      const got = await fetchBytes(new URL(mapTag[2], base).href);
      if (!got.b64) throw Object.assign(new Error('The stream’s init segment could not be fetched.'), { code: 'STREAM_BAD_STATUS' });
      await fsp.writeFile(path.join(destDir, mapName), got.b64);
      extraTags.push(`#EXT-X-MAP:URI="${mapName}"`);
    }
    const keyTag = /#EXT-X-KEY:([^\n]*)/i.exec(mediaText);
    if (keyTag) {
      const attrs = keyTag[1];
      const method = (/METHOD=([A-Z0-9-]+)/i.exec(attrs) || [])[1] || 'NONE';
      const uri = (/URI="([^"]+)"/i.exec(attrs) || [])[1];
      if (method === 'AES-128' && uri) {
        keyName = 'key.bin';
        keyIv = (/IV=0x([0-9A-Fa-f]+)/i.exec(attrs) || [])[1] || null;
        const got = await fetchBytes(new URL(uri, base).href);
        if (!got.b64) throw Object.assign(new Error('The stream’s key could not be fetched.'), { code: 'STREAM_BAD_STATUS' });
        await fsp.writeFile(path.join(destDir, keyName), got.b64);
        extraTags.push(`#EXT-X-KEY:METHOD=AES-128,URI="${keyName}"${keyIv ? `,IV=0x${keyIv}` : ''}`);
      } else if (method !== 'NONE') {
        throw Object.assign(new Error(`That stream is encrypted with ${method}, which cannot be saved.`), {
          code: 'STREAM_DRM',
        });
      }
    }

    /* ---- the bytes ------------------------------------------------------- */
    const extinf = lines.filter((line) => /^#EXTINF:/i.test(line)).map((line) => Number(line.slice(8).split(',')[0]) || 0);
    const durations = pieces.map((_, index) => extinf[index] || extinf[extinf.length - 1] || 0);
    const totalSeconds = duration || durations.reduce((sum, value) => sum + value, 0);
    let written = 0;
    let bytes = 0;
    let lastReport = 0;

    const queue = pieces.map((href, index) => ({ href, index }));
    const worker = async () => {
      for (;;) {
        if (aborted()) throw Object.assign(new Error('Stopped.'), { code: 'CANCELLED' });
        const next = queue.shift();
        if (!next) return;
        const got = await fetchBytes(next.href);
        if (!got.b64) {
          throw Object.assign(
            new Error(`The browser was refused a piece of the video (HTTP ${got.status || 'no answer'}).`),
            { code: 'STREAM_FORBIDDEN' },
          );
        }
        const buffer = Buffer.isBuffer(got.b64) ? got.b64 : Buffer.from(got.b64, 'base64');
        await fsp.writeFile(path.join(destDir, localFor(next.index, next.href)), buffer);
        bytes += buffer.length;
        written += 1;
        const now = Date.now();
        if (onProgress && now - lastReport > 400) {
          lastReport = now;
          const secondsDone = durations.slice(0, written).reduce((sum, value) => sum + value, 0);
          onProgress({ seconds: secondsDone, bytes, done: written, total: pieces.length });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(6, concurrency)) }, worker));

    /* ---- the playlist ffmpeg will read ---------------------------------- */
    const localLines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations, 1))}`, '#EXT-X-PLAYLIST-TYPE:VOD'];
    if (mapName) localLines.splice(1, 0, ...extraTags.filter((tag) => tag.startsWith('#EXT-X-MAP')));
    if (keyName) localLines.splice(1, 0, ...extraTags.filter((tag) => tag.startsWith('#EXT-X-KEY')));
    pieces.forEach((href, index) => {
      localLines.push(`#EXTINF:${durations[index] || 0},`, localFor(index, href));
    });
    localLines.push('#EXT-X-ENDLIST');
    const playlistPath = path.join(destDir, 'local.m3u8');
    await fsp.writeFile(playlistPath, `${localLines.join('\n')}\n`);

    const heightMatch = /RESOLUTION=\d+x(\d+)/i.exec(master.text);
    return {
      playlistPath,
      dir: destDir,
      segments: pieces.length,
      bytes,
      duration: totalSeconds,
      height: heightMatch ? Number(heightMatch[1]) : 0,
      mediaUrl,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  available,
  gofileFolder,
  captureMedia,
  capturePage,
  fetchInBrowser,
  probeInBrowser,
  streamDownload,
  listenerErrors,
  UA,
};

