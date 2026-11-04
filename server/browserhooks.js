'use strict';
/**
 * The one place the headless browser is wired into the resolver.
 *
 * It used to live at the top of server.js, which meant the *app* had a browser
 * and `npm run doctor` did not: the diagnostic ran the resolver with no browser
 * at all and reported a link as broken while the app would have handled it.
 * A report that is wrong about its own machine is worse than no report.
 *
 * Everything that resolves links — the server, the doctor, any script — calls
 * `install()` first.
 */

let installed = null;

/**
 * @returns {{available: boolean, why?: string, engine?: string}}
 */
function install() {
  if (installed) return installed;
  let browser;
  try {
    // eslint-disable-next-line global-require
    browser = require('./browser');
  } catch (err) {
    installed = { available: false, why: `browser helper missing: ${err.message}` };
    return installed;
  }
  if (!browser.available()) {
    installed = { available: false, why: 'playwright is not installed (npm run browser:install)' };
    return installed;
  }

  const { setGofileBrowser, setPageBrowser, setPageHtmlBrowser, setStreamBrowser } = require('../shared/resolve'); // eslint-disable-line global-require

  /* gofile mints its API token in an obfuscated browser script. */
  setGofileBrowser((code) => browser.gofileFolder(code));
  /* Observe the media a page really plays (for players that only hand out
     signed URLs), and read the DOM (for pages whose download button is built by
     JavaScript, behind a bot check). */
  setPageBrowser((url) => browser.captureMedia(url));
  setPageHtmlBrowser((url) => browser.capturePage(url, { waitFor: 'a[href], video, source' }));
  /* Read a playlist that refuses every request we can make. Not a nicety: the
     CDN in the field answers Chromium and refuses Node with the same headers,
     so without this a pasted .m3u8 link is a dead end. */
  setStreamBrowser((pageUrl, url) => browser.fetchInBrowser(pageUrl, url, { want: 'text' }));

  installed = { available: true, engine: 'playwright' };
  return installed;
}

/** Forget the memoised answer (tests, and after installing playwright at runtime). */
function reset() {
  installed = null;
}

module.exports = { install, reset };
