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

    page.on('response', async (response) => {
      const url = response.url();
      if (!/api\.gofile\.io\/contents\//i.test(url)) return;
      try {
        payloads.push(await response.json());
      } catch {
        /* not json, ignore */
      }
    });

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
async function captureMedia(url, { timeoutMs = 45_000, settleMs = 6000 } = {}) {
  const pw = load();
  if (!pw || !pw.chromium) {
    throw Object.assign(new Error('The headless browser is not installed on this machine.'), {
      code: 'BROWSER_UNAVAILABLE',
    });
  }

  const MEDIA = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpe?g|ts|3gp|ogv)(\?|#|$)/i;
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

    page.on('request', (request) => {
      const headers = request.headers();
      const meta = {
        force: request.resourceType() === 'media',
        referer: headers.referer || '',
        cookie: headers.cookie || '',
      };
      remember(request.url(), meta);
    });
    page.on('response', async (response) => {
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (type.startsWith('video/') || type === 'application/octet-stream') {
        remember(response.url(), {
          force: type.startsWith('video/'),
          contentType: type,
          size: response.headers()['content-length'],
        });
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    await page.waitForTimeout(settleMs);

    // Some players only start on a click; try the usual suspects once.
    for (const selector of ['video', 'button[class*="play" i]', '[class*="player" i]']) {
      const target = page.locator(selector).first();
      if (await target.count().catch(() => 0)) {
        await target.click({ timeout: 1500, force: true }).catch(() => {});
      }
    }
    await page.waitForTimeout(3000);

    // Read what the DOM advertises too: <video src>, <source>, og:video.
    const dom = await page
      .evaluate(() => {
        const out = [];
        const push = (value) => {
          if (value) out.push(new URL(value, location.href).href);
        };
        document.querySelectorAll('video').forEach((v) => push(v.currentSrc || v.src));
        document.querySelectorAll('video source, source').forEach((s) => push(s.src));
        const og = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]');
        if (og) push(og.getAttribute('content'));
        return out;
      })
      .catch(() => []);
    dom.forEach((u) => remember(u, { force: true }));

    const cookies = await context.cookies().catch(() => []);
    return {
      media: [...seen.values()],
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') || null,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { available, gofileFolder, captureMedia, UA };

