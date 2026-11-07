#!/usr/bin/env node
/**
 * "The doctor says the link is broken, but the app handles it."
 *
 * That was a real report, and the reason was wiring: the headless browser was
 * hooked into the resolver at the top of server.js, so the app had one and
 * `npm run doctor` did not. A diagnostic that is wrong about its own machine is
 * worse than none, so this test pins the wiring down:
 *
 *   1. `browserhooks.install()` is what puts the browser behind the resolver,
 *   2. it is called by the server *and* by the doctor's diagnose(),
 *   3. with a browser available, a fileditch page whose download button only
 *      exists after JavaScript resolves to the minted link, with the clearance
 *      cookie and the user agent that earned it,
 *   4. without one, the same page is reported as needing it, never as "removed".
 *
 *   npm run test:hooks
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const ROOT = path.join(__dirname, '..');
const BROWSER_PATH = require.resolve(path.join(ROOT, 'server', 'browser.js'));

/* A stand-in for playwright's side of things: a browser that "renders" a page
   whose download button is built by JavaScript, the way fileditch's is. */
const SIGNED = Buffer.from('1793557720:pZQFcRjiXh9:36884/b78/WlVHBYDPhhHcSTmGUcvy.mp4').toString('base64url');
const RENDERED = `<!doctype html><html><head><title>WlVHBYDPhhHcSTmGUcvy.mp4</title></head><body>
  <video src="/b78/WlVHBYDPhhHcSTmGUcvy.mp4"></video>
  <a class="button" href="https://lumistretcheseverymorning.xyz/${SIGNED}">⬇ Download</a>
  <a href="https://abuse.fileditch.com/b78/x.mp4">Report</a>
</body></html>`;

let capturePageCalls = 0;
const fakeBrowser = {
  UA: 'Mozilla/5.0 (fake) Chrome/124.0.0.0',
  available: () => true,
  gofileFolder: async () => null,
  capturePage: async (url) => {
    capturePageCalls += 1;
    assert.match(String(url), /fileditchvids\.st|theditch\.st/, `captured ${url}`);
    return {
      url: String(url),
      title: 'WlVHBYDPhhHcSTmGUcvy.mp4',
      html: RENDERED,
      cookie: 'cf_clearance=abc; fdg=1',
      userAgent: 'Mozilla/5.0 (fake) Chrome/124.0.0.0',
    };
  },
  captureMedia: async () => ({ media: [], cookie: 'cf_clearance=abc', userAgent: 'Mozilla/5.0 (fake) Chrome/124.0.0.0' }),
};

function withFakeBrowser(fn) {
  const previous = require.cache[BROWSER_PATH];
  require.cache[BROWSER_PATH] = {
    id: BROWSER_PATH,
    filename: BROWSER_PATH,
    loaded: true,
    exports: fakeBrowser,
  };
  const hooks = require('../server/browserhooks');
  hooks.reset();
  return Promise.resolve(fn(hooks)).finally(() => {
    hooks.reset();
    if (previous) require.cache[BROWSER_PATH] = previous;
    else delete require.cache[BROWSER_PATH];
  });
}

/** The page the server sends when no browser is involved: JS builds the button. */
function stubFetch(handler) {
  const previous = global.fetch;
  global.fetch = async (url, init = {}) => {
    const result = await handler(String(url), init);
    const body = result && result.raw !== undefined ? result.raw : JSON.stringify(result && result.body);
    return new Response(body, {
      status: (result && result.status) || 200,
      headers: { 'content-type': (result && result.type) || 'text/html' },
    });
  };
  return () => {
    global.fetch = previous;
  };
}

(async () => {
  const { setPageHtmlBrowser, resolve } = require('../shared/resolve');

  console.log('wiring');

  await withFakeBrowser(async (hooks) => {
    const installed = hooks.install();
    check('install() finds the browser', installed.available === true, JSON.stringify(installed));

    /* This is the failure that made the doctor lie: no hook, no browser. */
    const restore = stubFetch(() => ({
      raw: '<title>WlVHBYDPhhHcSTmGUcvy.mp4</title><video src="/b78/WlVHBYDPhhHcSTmGUcvy.mp4"></video>',
    }));
    try {
      const result = await resolve('https://theditch.st/qhygxukd');
      check(
        'the resolver has a browser after install()',
        capturePageCalls > 0,
        `${capturePageCalls} capturePage call(s)`,
      );
      check(
        'so a JavaScript-built download button is found',
        /lumistretcheseverymorning/.test(result.files[0].ref.url),
        result.files[0].ref.url,
      );
      check('with the clearance cookie', /cf_clearance/.test(result.files[0].ref.cookie || ''), result.files[0].ref.cookie);
      check(
        'and the user agent that earned it',
        result.files[0].ref.userAgent === fakeBrowser.UA,
        result.files[0].ref.userAgent,
      );
    } finally {
      restore();
    }

    /* Reading the same page twice must not launch a browser twice. */
    const before = capturePageCalls;
    const restore2 = stubFetch(() => ({
      raw: '<title>WlVHBYDPhhHcSTmGUcvy.mp4</title><video src="/b78/WlVHBYDPhhHcSTmGUcvy.mp4"></video>',
    }));
    try {
      await resolve('https://theditch.st/qhygxukd');
      check(
        'the rendered page is reused for a few minutes, not re-launched',
        capturePageCalls === before,
        `${capturePageCalls - before} extra launch(es)`,
      );
    } finally {
      restore2();
    }
  });

  console.log('the doctor');

  await withFakeBrowser(async (hooks) => {
    const { diagnose } = require('../server/diagnose');
    const { install } = hooks;
    const previous = install();
    check('diagnose() installs the hooks itself', previous.available === true, JSON.stringify(previous));

    const restore = stubFetch(() => ({
      raw: '<title>WlVHBYDPhhHcSTmGUcvy.mp4</title><video src="/b78/WlVHBYDPhhHcSTmGUcvy.mp4"></video>',
    }));
    try {
      const report = await diagnose('https://theditch.st/qhygxukd', { browser: 'skip' });
      check('the diagnostic sees a browser', report.browser.available === true);
      check('and resolves the same link the app would', report.resolve.ok === true, report.resolve.error || '');
      check(
        'the minted link is reported, not the player page',
        /lumistretcheseverymorning/.test(report.resolve.value.files[0].refUrl),
        report.resolve.value.files[0].refUrl,
      );
      check('the report says so in words', /minted/.test(report.text), 'no verdict line');
      check(
        'and it does not tell you to install what it already has',
        !/browser:install/.test(report.text),
        report.text.split('\n').find((line) => /browser:install/.test(line)) || '',
      );
      check(
        'the verdict says the link is usable',
        /VERDICT\s+This link resolves|VERDICT\s+Nothing here/.test(report.text),
        report.text.split('\n').find((line) => line.startsWith('VERDICT')) || 'no verdict',
      );
    } finally {
      restore();
    }
  });

  console.log('without a browser');

  await withFakeBrowser(async (hooks) => {
    hooks.reset();
    delete require.cache[require.resolve('../server/browser.js')];
    const original = require.cache[BROWSER_PATH];
    require.cache[BROWSER_PATH] = {
      id: BROWSER_PATH,
      filename: BROWSER_PATH,
      loaded: true,
      exports: { ...fakeBrowser, available: () => false },
    };
    hooks.reset();
    const installed = hooks.install();
    check('install() reports the truth when there is none', installed.available === false, JSON.stringify(installed));

    setPageHtmlBrowser(null); // what the server does when Chromium is absent
    const restore = stubFetch(() => ({
      raw: '<title>WlVHBYDPhhHcSTmGUcvy.mp4</title><video src="/b78/WlVHBYDPhhHcSTmGUcvy.mp4"></video>',
    }));
    try {
      const result = await resolve('https://theditch.st/qhygxukd');
      const url = result.files[0].ref.url;
      check(
        'a player page is only ever offered with its warning flag, never as a plain file',
        !/fileditchvids\.st\/b78\//.test(url) || result.files[0].playerish === true,
        `${url} · playerish=${result.files[0].playerish}`,
      );
      check(
        'and the reference carries no invented cookie',
        !result.files[0].ref.cookie,
        result.files[0].ref.cookie || 'none',
      );
    } finally {
      restore();
      if (original) require.cache[BROWSER_PATH] = original;
    }
  });

  console.log('what the report says about its own machine');

  {
    const { render } = require('../server/diagnose');
    const steps = (browser) => ({
      version: { version: '1.0.0', commit: 'deadbee', node: 'v22.22.3', features: { resumableEncode: true } },
      browser,
      plainRequest: {
        ok: true,
        ms: 9,
        value: { status: 200, contentType: 'text/html', bytes: 4096, title: 'a video', challenge: false },
      },
      resolve: {
        ok: true,
        value: {
          resolver: 'fileditch',
          pageTitle: 'a video',
          files: [{ name: 'a', refUrl: 'https://host.example/abc.mp4', hasCookie: false, cookieNames: [], viaBrowser: false }],
        },
      },
      verdict: 'nothing to say',
    });

    /* Not installed is not a bug in this repo; only a browser that is present
       and still not wired into the resolver is. */
    const absent = render({
      url: 'https://theditch.st/qhygxukd',
      steps: steps({ available: false, wired: false, module: false, why: 'playwright is not installed' }),
    });
    check('a missing browser is not reported as a bug', !/bug/i.test(absent), absent.match(/browser.*/i)[0]);
    check(
      'the report says it is running without one',
      /running without one/.test(absent) && /may still work in the app/.test(absent),
      absent.split('\n').slice(2, 5).join(' | '),
    );

    const unwired = render({
      url: 'https://theditch.st/qhygxukd',
      steps: steps({ available: false, wired: false, module: true, why: 'present but unused' }),
    });
    check('a browser that exists and is not wired in still says so', /NOT WIRED/.test(unwired), 'no warning');

    const wired = render({
      url: 'https://theditch.st/qhygxukd',
      steps: steps({ available: true, wired: true, module: true, executablePath: '/tmp/chrome' }),
    });
    check('a working browser is reported without any warning', !/bug|NOT WIRED|without one/i.test(wired), 'false alarm');
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
