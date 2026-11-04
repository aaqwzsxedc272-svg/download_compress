'use strict';
/**
 * A stand-in `playwright`, for tests that need the browser path without a
 * browser.
 *
 *   node --require scripts/fixtures/fake-browser.js server/server.js
 *
 * Playwright is a 100 MB download and a live site is not a test fixture, but
 * the code under test must still be the code that ships: the in-page `fetch`
 * this fake runs is *really run* — Node has `fetch`, `btoa` and `Uint8Array`,
 * so the function is executed as written. What is simulated is only what a
 * browser adds: the cookie jar, and the client-level signal the fixture CDN
 * checks (`x-browser`).
 *
 * Driven by the environment:
 *   FAKE_PW_PLAYLIST  the playlist the page's player asks for
 *   FAKE_PW_COOKIE    the cookie jar, as a Cookie header
 *   FAKE_PW_TITLE     the page title
 */

const Module = require('node:module');

const PLAYLIST = process.env.FAKE_PW_PLAYLIST || '';
const COOKIE = process.env.FAKE_PW_COOKIE || '';
const TITLE = process.env.FAKE_PW_TITLE || 'DANDYA-045 a film - MissAV';
const DURATION = Number(process.env.FAKE_PW_DURATION || 6);

function makePage() {
  const handlers = new Map();
  const emit = (event, payload) => {
    for (const handler of handlers.get(event) || []) {
      try {
        handler(payload);
      } catch {
        /* A listener that throws must not take the process down, exactly like
           the server: that is one of the things this fake exists to catch. */
      }
    }
  };

  let queue = Promise.resolve();
  /* The response the next navigation produces, and whoever waits for it: the
     download falls back to navigation when the page may not read a response
     (no CORS headers), and a fake that cannot navigate would hide that. */
  let waiter = null;
  const load = async (target) => {
    const res = await fetch(String(target), {
      headers: { ...(COOKIE ? { cookie: COOKIE } : {}), 'x-browser': '1' },
    }).catch(() => null);
    const buffer = res && res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    return {
      url: () => String(target),
      status: () => (res ? res.status : 0),
      headers: () => ({
        'content-type': (res && res.headers.get('content-type')) || '',
        'content-length': String(buffer ? buffer.length : 0),
      }),
      body: async () => buffer,
      text: async () => (buffer ? buffer.toString('utf8') : ''),
    };
  };

  const page = {
    url: () => process.env.FAKE_PW_PAGE || 'https://site.test/watch',
    title: async () => TITLE,
    content: async () => `<html><body><video></video><script>file: "${PLAYLIST}"</script></body></html>`,
    frames: () => [],
    mainFrame: () => ({ content: async () => '' }),
    waitForResponse: () =>
      new Promise((resolve) => {
        waiter = resolve;
      }),
    goto: async (target) => {
      if (PLAYLIST) {
        emit('request', {
          url: () => PLAYLIST,
          resourceType: () => 'media',
          headers: () => ({ referer: String(target), cookie: COOKIE }),
        });
        emit('response', {
          url: () => PLAYLIST,
          headers: () => ({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '512' }),
        });
      }
      const response = await load(target);
      if (waiter) {
        const give = waiter;
        waiter = null;
        give(response);
      }
      return response;
    },
    waitForTimeout: async () => null,
    waitForSelector: async () => null,
    waitForLoadState: async () => null,
    locator: () => ({ first: () => ({ count: async () => 0, click: async () => null }) }),
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    /* Anything that reads the DOM gets an answer shaped like a DOM; anything
       else is a `fetch` and is really executed. */
    evaluate: (fn, arg) => {
      const source = String(fn);
      if (source.includes('querySelectorAll')) {
        if (source.includes('paused')) {
          return Promise.resolve([
            { src: '', currentSrc: '', duration: DURATION, paused: false, readyState: 4, videoWidth: 1280, videoHeight: 720 },
          ]);
        }
        /* A DOM sweep: `{media, anchors}` is what captureMedia asks for, an
           array is what the play-button probe ignores. */
        return Promise.resolve({ media: [], anchors: [] });
      }
      const answer = queue.then(async () => {
        const real = globalThis.fetch;
        globalThis.fetch = (target, options = {}) =>
          real(String(target), {
            ...options,
            headers: { ...(options.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}), 'x-browser': '1' },
          });
        try {
          return await fn(arg);
        } finally {
          globalThis.fetch = real;
        }
      });
      queue = answer.catch(() => {});
      return answer;
    },
  };
  return page;
}

const fake = {
  chromium: {
    /* The doctor checks that the binary exists before it trusts the answer. */
    executablePath: () => process.execPath,
    launch: async () => ({
      newContext: async () => ({
        addInitScript: async () => null,
        cookies: async () => (COOKIE ? [{ name: 'sid', value: 'ok' }] : []),
        newPage: async () => makePage(),
      }),
      close: async () => null,
    }),
  },
};

const original = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'playwright') return fake;
  return original.call(this, request, parent, isMain);
};
