'use strict';
/**
 * Retry a download through a real browser when a plain HTTP fetch is refused.
 *
 * Hotlink-protected CDNs (fileditch), bot-protected hosts (filester behind
 * DDoS-Guard) and players that only hand out signed URLs all behave the same
 * way: the plain request gets 403, or gets an HTML challenge page with a 200.
 * A browser solves that, and the capture reports both the media URL and the
 * headers (referer, cookie) the page used to fetch it.
 *
 * Kept separate from server.js so it can be tested without Chromium installed:
 * the capture function is injected.
 */

const RECOVERABLE = new Set(['HTML_PAGE', 'BAD_STATUS', 'UNREACHABLE']);

/**
 * @param {object}   opts
 * @param {string}   opts.url        direct media URL to try first
 * @param {string}   opts.pageUrl    the page to open if that fails
 * @param {string}   opts.destPath   where the bytes go
 * @param {object}   opts.download   an async (url, destPath, options) => void
 * @param {Function} opts.capture    async (pageUrl) => { media: [{url, referer}], cookie }
 * @param {object}   opts.options    options forwarded to the downloader
 */
async function downloadWithFallback({ url, pageUrl, destPath, download, capture, options = {} }) {
  try {
    await download(url, destPath, options);
    return { usedBrowser: false, url };
  } catch (err) {
    if (!RECOVERABLE.has(err.code) || typeof capture !== 'function') throw err;

    const captured = await capture(pageUrl || url).catch(() => null);
    const media = (captured && captured.media) || [];
    if (!media.length) throw err;

    const cookie = captured.cookie || null;
    let lastError = err;
    for (const item of media.slice(0, 6)) {
      if (!item || !item.url) continue;
      const extraHeaders = {
        ...(item.referer ? { referer: item.referer } : {}),
        ...(item.cookie || cookie ? { cookie: item.cookie || cookie } : {}),
      };
      try {
        await download(item.url, destPath, { ...options, extraHeaders });
        return { usedBrowser: true, url: item.url, via: url };
      } catch (next) {
        lastError = next;
      }
    }
    throw lastError;
  }
}

module.exports = { downloadWithFallback, RECOVERABLE };
