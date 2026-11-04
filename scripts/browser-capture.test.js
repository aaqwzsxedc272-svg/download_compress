'use strict';

/**
 * The browser helper, run against a fake Playwright.
 *
 *   node scripts/browser-capture.test.js
 *
 * Why this exists: the browser path had only ever been exercised by hand, on a
 * machine with Playwright installed, on a live site. Then a `const` that lived
 * inside one function was used by another, the reference blew up inside a
 * Playwright event listener, and Node exited — the server died while a user was
 * watching it, and the trace pointed at a line that looks fine on its own.
 *
 * A fake `playwright` module needs no 100 MB download and no network: it emits
 * the request/response events a page would, so the listeners actually run. Any
 * error inside them is a failed test here instead of a dead server there.
 */

const assert = require('node:assert');
const Module = require('node:module');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(` FAIL  ${name}\n         ${err.message}`);
  }
}

/* ------------------------------------------------------------ fake Playwright */

/**
 * One page with every hook the helper uses, driven by the test.
 *
 * `onGoto` runs while `goto()` is still on the stack, which is when a real page
 * starts making requests — that is the moment a listener bug is reachable.
 */
function makePage({ html = '', title = '', url = 'https://example.test/watch', cookies = [], onGoto = null, playing = [] } = {}) {
  const handlers = new Map();
  const frame = { content: async () => html };
  const page = {
    url: () => url,
    title: async () => title,
    content: async () => html,
    frames: () => [],
    mainFrame: () => ({ content: async () => html }),
    goto: async () => {
      if (onGoto) onGoto(page);
      return null;
    },
    waitForSelector: async () => null,
    waitForTimeout: async () => null,
    locator: () => ({ first: () => ({ count: async () => 0, click: async () => null }) }),
    evaluate: async (fn) => {
      if (String(fn).includes('querySelectorAll') && String(fn).includes('readyState')) return playing;
      return { media: [], anchors: [] };
    },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    /* The test plays the part of Chromium. */
    emit: (event, payload) => {
      for (const handler of handlers.get(event) || []) handler(payload);
    },
    handlersFor: (event) => handlers.get(event) || [],
  };
  return { page, cookies };
}

function fakePlaywright({ page, cookies }) {
  return {
    chromium: {
      launch: async () => ({
        newContext: async () => ({
          addInitScript: async () => null,
          cookies: async () => cookies,
          newPage: async () => page,
        }),
        close: async () => null,
      }),
    },
  };
}

/** Load server/browser.js with 'playwright' resolved to our fake. */
function withFakePlaywright(fake) {
  const original = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'playwright') return fake;
    return original.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../server/browser')];
  const helper = require('../server/browser');
  return {
    helper,
    restore() {
      Module._load = original;
      delete require.cache[require.resolve('../server/browser')];
    },
  };
}

/* ---------------------------------------------------------------------- tests */

(async () => {
  console.log('browser capture (fake Playwright, no network)');

  /* A page that reports its video while the capture is loading it — plus one
     request event so malformed that reading it throws, which is the shape that
     killed the server. */
  const { page, cookies } = makePage({
    title: 'DANDYA-045 a title - MissAV',
    url: 'https://missav.ws/en/dandya-045',
    cookies: [{ name: 'cf_clearance', value: 'abc' }],
    html: '<html><body><script>file: "https://surrit.com/91f6/playlist.m3u8"</script></body></html>',
    onGoto: (self) => {
      self.emit('request', {
        url: () => 'https://cdn.example/video.mp4',
        resourceType: () => 'media',
        headers: () => ({ referer: 'https://missav.ws/' }),
      });
      self.emit('response', {
        url: () => 'https://cdn.example/playlist.m3u8',
        headers: () => ({ 'content-type': 'application/vnd.apple.mpegurl', 'content-length': '512' }),
      });
      self.emit('request', null);
      self.emit('response', { url: () => null, headers: () => ({}) });
    },
  });
  const { helper, restore } = withFakePlaywright(fakePlaywright({ page, cookies }));

  await test('a page event listener cannot throw out of the capture', async () => {
    let result = null;
    await assert.doesNotReject(async () => {
      result = await helper.capturePage('https://missav.ws/en/dandya-045');
    });
    assert.ok(result, 'the capture still produced a result');
    /* The broken payload is reported, not rethrown — and the capture is whole. */
    assert.ok(helper.listenerErrors(), 'the bad event was recorded');
    assert.match(String(helper.listenerErrors().message), /.+/);
  });

  await test('capturePage returns what the page played, in one visit', async () => {
    const result = await helper.capturePage('https://missav.ws/en/dandya-045');
    assert.equal(result.title, 'DANDYA-045 a title - MissAV');
    assert.match(result.cookie, /cf_clearance=abc/);
    assert.ok(result.html.includes('surrit.com'), 'the HTML is part of the answer');
    const urls = (result.media || []).map((item) => item.url);
    assert.ok(urls.includes('https://cdn.example/video.mp4'), urls.join(', '));
    assert.ok(urls.includes('https://cdn.example/playlist.m3u8'), urls.join(', '));
    assert.equal(result.media.length, 2, JSON.stringify(urls));
  });

  await test('capturePage reports the video the page was actually playing', async () => {
    const made = makePage({
      title: 'x',
      html: '<html></html>',
      playing: [{ url: 'https://surrit.com/91f6/720p/video.m3u8', duration: 7200, paused: false, readyState: 4 }],
    });
    const loaded = withFakePlaywright(fakePlaywright(made));
    try {
      const result = await loaded.helper.capturePage('https://missav.ws/en/dandya-045');
      assert.equal((result.playing || []).length, 1, JSON.stringify(result.playing));
      assert.equal(result.playing[0].duration, 7200);
      assert.match(result.playing[0].url, /surrit\.com/);
    } finally {
      loaded.restore();
    }
  });

  await test('a playlist requested as XHR is recorded too', async () => {
    const made = makePage({
      title: 'x',
      html: '<html></html>',
      onGoto: (self) => {
        /* A player fetches its manifest with XHR: resourceType is 'xhr', and the
           URL is a playlist, not a media file. */
        self.emit('request', {
          url: () => 'https://surrit.com/91f6/playlist.m3u8',
          resourceType: () => 'xhr',
          headers: () => ({ referer: 'https://missav.ws/' }),
        });
      },
    });
    const loaded = withFakePlaywright(fakePlaywright(made));
    try {
      const result = await loaded.helper.capturePage('https://missav.ws/en/dandya-045');
      assert.ok(
        (result.media || []).some((item) => item.url.endsWith('playlist.m3u8')),
        JSON.stringify(result.media),
      );
    } finally {
      loaded.restore();
    }
  });

  await test('captureMedia survives the same bad events', async () => {
    const made = makePage({
      title: 'x',
      html: '<html></html>',
      onGoto: (self) => {
        self.emit('response', null);
        self.emit('request', undefined);
        self.emit('response', { url: () => 'https://cdn.example/v.mp4', headers: () => ({ 'content-type': 'video/mp4' }) });
      },
    });
    const loaded = withFakePlaywright(fakePlaywright(made));
    try {
      const result = await loaded.helper.captureMedia('https://example.test/watch');
      assert.ok((result.media || []).some((item) => item.url === 'https://cdn.example/v.mp4'), JSON.stringify(result.media));
    } finally {
      loaded.restore();
    }
  });

  restore();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
