'use strict';

/**
 * Resolver unit tests. No network: fetch is stubbed with the real response
 * shapes captured from api.gofile.io / turbo.cr / pixeldrain.
 *
 *   node scripts/resolve.test.js
 */

const assert = require('node:assert');
const {
  resolve,
  directUrl,
  directCandidates,
  extractVideoUrls,
  pageDisplayName,
  preferPageName,
  setPageHtmlBrowser,
  pageTitleOf,
} = require('../shared/resolve');

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

/** Install a fake fetch; records calls so tests can assert on them. */
function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const result = await handler(String(url), init);
    const body = result && result.raw !== undefined
      ? result.raw
      : typeof result === 'string'
        ? result
        : JSON.stringify(result.body);
    const status = (result && result.status) || 200;
    return new Response(body, {
      status,
      headers: { 'content-type': (result && result.type) || 'application/json', ...((result && result.headers) || {}) },
    });
  };
  return calls;
}

const GOFILE_FOLDER = {
  status: 'ok',
  data: {
    id: 'fa0e5a5c-1111-2222-3333-444455556666',
    type: 'folder',
    name: 'yl6viZms',
    code: 'yl6viZms',
    children: {
      'a1': {
        id: 'a1',
        type: 'file',
        name: 'Big Clip.mp4',
        size: 3_700_000_000,
        mimetype: 'video/mp4',
        server: 'store8',
        link: 'https://store8.gofile.io/download/a1/Big%20Clip.mp4',
      },
      'b2': {
        id: 'b2',
        type: 'file',
        name: 'Smaller Clip.mp4',
        size: 2_600_000_000,
        mimetype: 'video/mp4',
        server: 'store4',
        link: 'https://store4.gofile.io/download/b2/Smaller%20Clip.mp4',
      },
      'c3': { id: 'c3', type: 'file', name: 'notes.txt', size: 200, mimetype: 'text/plain', server: 'store4' },
    },
  },
};

(async () => {
  console.log('gofile');

  await test('creates a guest account and lists a folder biggest-video-first', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/accounts')) return { body: { status: 'ok', data: { token: 'guest-token' } } };
      return { body: GOFILE_FOLDER };
    });

    const result = await resolve('https://gofile.io/d/yl6viZms');
    assert.equal(result.resolver, 'gofile');
    assert.equal(result.files.length, 3, 'all files listed');
    assert.equal(result.files[0].name, 'Big Clip.mp4', 'largest video first');
    assert.equal(result.files[0].kind, 'video');
    assert.equal(result.files[0].size, 3_700_000_000);
    assert.equal(result.files[2].kind, 'other', 'non-video sorted last');

    const contentsCall = calls.find((c) => c.url.includes('/contents/yl6viZms'));
    assert.ok(contentsCall, 'contents endpoint called');
    assert.equal(contentsCall.init.headers.authorization, 'Bearer guest-token');
    assert.ok(contentsCall.url.includes('wt=4fd6sg89d7s6'), 'web token present');
  });

  await test('retries once with a fresh token when the first is rejected', async () => {
    let contentsCalls = 0;
    let accountCalls = 0;
    stubFetch((url) => {
      if (url.endsWith('/accounts')) {
        accountCalls += 1;
        return { body: { status: 'ok', data: { token: `token-${accountCalls}` } } };
      }
      contentsCalls += 1;
      if (contentsCalls === 1) return { body: { status: 'error-token', data: {} } };
      return { body: GOFILE_FOLDER };
    });
    const result = await resolve('https://gofile.io/d/yl6viZms');
    assert.equal(contentsCalls, 2, 'retried the contents call');
    assert.ok(accountCalls >= 1, 'minted a new guest account for the retry');
    assert.equal(result.files.length, 3);
  });

  await test('reports a premium-only folder clearly', async () => {
    stubFetch((url) => {
      if (url.endsWith('/accounts')) return { body: { status: 'ok', data: { token: 't' } } };
      return { body: { status: 'error-notPremium', data: {} } };
    });
    await assert.rejects(resolve('https://gofile.io/d/abc'), (err) => {
      assert.equal(err.code, 'GOFILE_PREMIUM');
      assert.match(err.message, /premium/i);
      return true;
    });
  });

  await test('re-signs a direct link from a file reference', async () => {
    stubFetch((url) => {
      if (url.endsWith('/accounts')) return { body: { status: 'ok', data: { token: 't' } } };
      return {
        body: {
          status: 'ok',
          data: { children: { a1: { id: 'a1', link: 'https://store8.gofile.io/download/a1/fresh.mp4' } } },
        },
      };
    });
    const url = await directUrl({ resolver: 'gofile', id: 'a1', name: 'x.mp4', link: null });
    assert.equal(url, 'https://store8.gofile.io/download/a1/fresh.mp4');
  });

  console.log('turbo.cr');

  const TURBO_SIGN = {
    filename: 'b98ru7NqCI3AV.mp4',
    original_filename: 'clip-p1080.mp4',
    success: true,
    url: 'https://dl100.turbocdn.st/turbo/data/b98ru7NqCI3AV.mp4?exp=1793426301&token=abc&fn=clip-p1080.mp4',
  };

  await test('signs a /d/ link into a CDN url and prefers the original filename', async () => {
    const calls = stubFetch(() => ({ body: TURBO_SIGN }));
    const result = await resolve('https://turbo.cr/d/b98ru7NqCI3AV');
    assert.equal(result.resolver, 'turbo');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'clip-p1080.mp4');
    assert.ok(result.files[0].ref.url.includes('turbocdn.st'));
    assert.ok(calls[0].url.includes('/api/sign?v=b98ru7NqCI3AV'));
  });

  await test('handles /v/ and /embed/ forms', async () => {
    stubFetch(() => ({ body: TURBO_SIGN }));
    for (const link of ['https://turbo.cr/v/b98ru7NqCI3AV', 'https://turbo.cr/embed/b98ru7NqCI3AV']) {
      const result = await resolve(link);
      assert.equal(result.files.length, 1, link);
    }
  });

  await test('refuses when turbo.cr returns no url', async () => {
    stubFetch(() => ({ body: { success: false } }));
    await assert.rejects(resolve('https://turbo.cr/d/xyz'), (err) => err.code === 'TURBO_FAILED');
  });

  console.log('bunkr');

  await test('extracts the signed CDN flow from an item page', async () => {
    const html = `<html><body>
      <h1>My Clip.mp4</h1>
      <script>
        var jsCDN = "https:\/\/cdn.cr\/data\/abc123.mp4";
        var signUrl = "https:\/\/cdn.cr\/sign";
      </script></body></html>`;
    stubFetch((url) => {
      if (url.includes('/sign')) return { body: { token: 'tok123', ex: 1793426301 } };
      return { raw: html, type: 'text/html' };
    });
    const result = await resolve('https://bunkr.cr/f/abc123');
    assert.equal(result.resolver, 'bunkr');
    assert.equal(result.files[0].name, 'My Clip.mp4');
    const url = await directUrl(result.files[0].ref);
    assert.ok(url.includes('token=tok123'), url);
    assert.ok(url.includes('ex=1793426301'), url);
  });

  await test('a bot-check page is reported, not silently empty', async () => {
    stubFetch(() => ({ raw: '<html><body>Checking your browser…</body></html>', type: 'text/html' }));
    await assert.rejects(resolve('https://bunkr.su/f/abc123'), (err) => err.code === 'BUNKR_BLOCKED');
  });

  await test('albums expand into their files', async () => {
    const album = '<a href="/f/one111">1</a><a href="/f/two222">2</a>';
    const item = (name) => `<h1>${name}</h1><script>var jsCDN="https://cdn.cr/${name}.mp4";var signUrl="https://cdn.cr/sign";</script>`;
    stubFetch((url) => {
      if (url.includes('/a/')) return { raw: album, type: 'text/html' };
      if (url.includes('/sign')) return { body: { token: 't', ex: 1 } };
      return { raw: item(url.includes('one111') ? 'first' : 'second'), type: 'text/html' };
    });
    const result = await resolve('https://bunkr.ph/a/album99');
    assert.equal(result.files.length, 2, JSON.stringify(result.files.map((f) => f.name)));
  });

  console.log('filester');

  await test('uses public file metadata when available', async () => {
    stubFetch(() => ({ body: { success: true, data: { name: 'holiday.mp4', size: 900, type: 'video/mp4' } } }));
    const result = await resolve('https://filester.me/d/aBcDeFg');
    assert.equal(result.resolver, 'filester');
    assert.equal(result.files[0].name, 'holiday.mp4');
    assert.equal(result.files[0].size, 900);
  });

  await test('falls back to the share page for the direct link', async () => {
    stubFetch((url) => {
      if (url.includes('u1.filester.me')) return { status: 401, body: { success: false } };
      return { raw: '<video src="https://dl.filester.me/x/clip.mp4"></video>', type: 'text/html' };
    });
    const result = await resolve('https://filester.me/d/aBcDeFg');
    assert.equal(result.files[0].ref.url, 'https://dl.filester.me/x/clip.mp4');
  });

  await test('the page name beats the uuid the cdn calls the file', async () => {
    stubFetch((url) => {
      if (url.includes('u1.filester.me')) return { status: 401, body: { success: false } };
      return {
        raw:
          '<title>Kate Dalia - Lazy Day Off.mp4 | Filester</title>' +
          '<video src="https://dl.filester.me/x/e78f1c92-7cbd-4065-84a0-36d240d61814.mkv"></video>',
        type: 'text/html',
      };
    });
    const result = await resolve('https://filester.me/d/aBcDeFg');
    assert.equal(result.files[0].name, 'Kate Dalia - Lazy Day Off.mp4', JSON.stringify(result.files[0].name));
    /* The url is still the uuid; only the name changed. */
    assert.match(result.files[0].ref.url, /e78f1c92/);
  });

  await test('a readable cdn name is left alone', async () => {
    stubFetch((url) => {
      if (url.includes('u1.filester.me')) return { status: 401, body: { success: false } };
      return {
        raw: '<title>holiday.mp4</title><video src="https://dl.filester.me/x/Sunset-Drive-1080p.mp4"></video>',
        type: 'text/html',
      };
    });
    const result = await resolve('https://filester.me/d/aBcDeFg');
    assert.equal(result.files[0].name, 'Sunset-Drive-1080p.mp4');
  });

  console.log('fileditch');

  await test('a download anchor is followed and deduped against the player', async () => {
    /* The shape fileditch really serves: one minted anchor plus the player. */
    const signed = Buffer.from('1793509933:pZQFcRjiXh9:36884/b78/WlVHBYDPhhHcSTmGUcvy.mp4')
      .toString('base64url');
    const player = 'https://fileditchvids.st/b78/WlVHBYDPhhHcSTmGUcvy.mp4';
    stubFetch(() => ({
      raw:
        '<title>WlVHBYDPhhHcSTmGUcvy.mp4</title>' +
        `<video src="${player}"></video>` +
        `<a href="https://lumistretcheseverymorning.xyz/${signed}">⬇ Download</a>`,
      type: 'text/html',
    }));
    const result = await resolve('https://fileditch.st/qhygxukd');
    assert.equal(result.resolver, 'fileditch');
    assert.equal(result.files.length, 1, JSON.stringify(result.files.map((f) => f.name)));
    assert.match(result.files[0].ref.url, /lumistretcheseverymorning/, result.files[0].ref.url);
    assert.equal(result.files[0].name, 'WlVHBYDPhhHcSTmGUcvy.mp4');
  });

  await test('the player page itself is offered when the signed link fails', async () => {
    const signed = Buffer.from('1793509933:pZQFcRjiXh9:36884/b78/abc.mp4').toString('base64url');
    const player = 'https://fileditchvids.st/b78/abc.mp4';
    stubFetch(() => ({
      raw:
        `<video src="${player}"></video>` +
        `<a href="https://lumistretcheseverymorning.xyz/${signed}">Download</a>`,
      type: 'text/html',
    }));
    const result = await resolve('https://fileditch.st/qhygxukd');
    const routes = await directCandidates(result.files[0].ref);
    assert.ok(routes.length >= 2, `expected several routes, got ${JSON.stringify(routes)}`);
    assert.match(routes[0], /lumistretcheseverymorning/);
    assert.ok(routes.some((route) => route.includes('fileditchvids.st')), JSON.stringify(routes));
  });

  await test('a bare cdn path is resolved through the page, never fetched as a file', async () => {
    const signed = Buffer.from('1793509933:pZQFcRjiXh9:36884/b78/abc.mp4').toString('base64url');
    stubFetch(() => ({
      raw:
        '<video src="https://fileditchvids.st/b78/abc.mp4"></video>' +
        `<a href="https://lumistretcheseverymorning.xyz/${signed}">Download</a>`,
      type: 'text/html',
    }));
    const result = await resolve('https://fileditchfiles.me/b78/abc.mp4');
    assert.equal(result.resolver, 'fileditch');
    assert.equal(result.files.length, 1);
    assert.ok(!/fileditchfiles\.me$/.test(result.files[0].ref.url), result.files[0].ref.url);
  });

  await test('a file host that answers 500 is replaced by the player page', async () => {
    /* What the host really does: fileditchfiles.me returns 500 to a plain GET,
       and the bytes only come from a link minted by fileditchvids.st. */
    const signed = Buffer.from('1793509933:pZQFcRjiXh9:36884/b78/abc.mp4').toString('base64url');
    const calls = stubFetch((url) => {
      if (url.includes('fileditchfiles.me')) return { status: 500, statusText: 'Internal Server Error', raw: 'error' };
      return {
        raw:
          '<title>abc.mp4</title><video src="https://fileditchvids.st/b78/abc.mp4"></video>' +
          `<a href="https://lumistretcheseverymorning.xyz/${signed}">⬇ Download</a>`,
        type: 'text/html',
      };
    });
    const result = await resolve('https://fileditchfiles.me/b78/abc.mp4');
    assert.equal(result.resolver, 'fileditch');
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].ref.url, /lumistretcheseverymorning/, result.files[0].ref.url);
    assert.equal(result.files[0].name, 'abc.mp4');
    assert.ok(!calls.some((call) => call.url.includes('fileditchfiles.me')), 'the dead file host was fetched anyway');
  });

  await test('the exact links from a real fileditch page all end at the same file', async () => {
    /* theditch.st/qhygxukd, the signed link it hands out, and the file-host URL
       are three views of one video and used to fail in three different ways. */
    const signed = Buffer.from('1793555458:8v0oCffZzS6jNrkzoIi1r-hCD1bi0i2_9FdSVo r7eu49pk:36884/b78/WlVHBYDPhhHcSTmGUcvy.mp4'.replace(/ /g, ''))
      .toString('base64url');
    assert.match(signed, /^[A-Za-z0-9_-]+$/);
    const player = 'https://fileditchvids.st/b78/WlVHBYDPhhHcSTmGUcvy.mp4';
    const html =
      '<title>WlVHBYDPhhHcSTmGUcvy.mp4</title>' +
      `<video src="${player}"></video>` +
      `<a href="https://lumistretcheseverymorning.xyz/${signed}">⬇ Download</a>`;
    stubFetch((url) =>
      url.includes('fileditchfiles.me')
        ? { status: 500, statusText: 'Internal Server Error', raw: 'error' }
        : { raw: html, type: 'text/html' },
    );

    for (const pasted of [
      'https://theditch.st/qhygxukd',
      `https://lumistretcheseverymorning.xyz/${signed}`,
      'https://fileditchfiles.me/b78/WlVHBYDPhhHcSTmGUcvy.mp4',
    ]) {
      const result = await resolve(pasted);
      assert.equal(result.resolver, 'fileditch', pasted);
      assert.equal(result.files.length, 1, `${pasted} -> ${result.files.length} files`);
      assert.match(result.files[0].ref.url, /lumistretcheseverymorning/, `${pasted} -> ${result.files[0].ref.url}`);
    }
  });

  console.log('cloudflare');

  const CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>
    <div id="challenge-platform"><noscript>Enable JavaScript and cookies to continue</noscript></div>
    </body></html>`;
  const clearance = { html: '<title>abc.mp4</title><a href="/signed/after-cf">⬇ Download</a>', cookie: 'cf_clearance=abc123', title: 'Just a moment...' };

  await test('a bot check is recognised, not reported as "the page is gone"', async () => {
    stubFetch(() => ({ status: 403, raw: CHALLENGE, type: 'text/html', headers: { 'cf-mitigated': 'challenge' } }));
    setPageHtmlBrowser(null);
    await assert.rejects(
      () => resolve('https://theditch.st/qhygxukd'),
      (err) => err.code === 'CLOUDFLARE' && /browser:install/.test(err.message),
      'a Cloudflare block has to be named as one',
    );
  });

  await test('the headless browser clears it and the page is read', async () => {
    let ask = 0;
    stubFetch(() => ({ status: 403, raw: CHALLENGE, type: 'text/html', headers: { 'cf-mitigated': 'challenge' } }));
    setPageHtmlBrowser(async (url) => {
      ask += 1;
      assert.match(url, /fileditchvids\.st|theditch\.st/);
      return clearance;
    });
    const result = await resolve('https://fileditchfiles.me/b78/abc.mp4');
    setPageHtmlBrowser(null);
    assert.equal(ask, 1, `the browser was asked ${ask} times`);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].ref.url, /\/signed\/after-cf$/, result.files[0].ref.url);
  });

  await test('the clearance cookie rides along, or the file request is blocked again', async () => {
    stubFetch(() => ({ status: 403, raw: CHALLENGE, type: 'text/html', headers: { 'cf-mitigated': 'challenge' } }));
    setPageHtmlBrowser(async () => clearance);
    const result = await resolve('https://fileditchfiles.me/b78/abc.mp4');
    setPageHtmlBrowser(null);
    assert.equal(result.files[0].ref.cookie, 'cf_clearance=abc123');
  });

  await test('a page that is not a challenge is read without the browser', async () => {
    let asked = false;
    stubFetch(() => ({
      raw: '<title>Real Page</title><a href="/signed/plain">⬇ Download</a>',
      type: 'text/html',
    }));
    setPageHtmlBrowser(async () => {
      asked = true;
      return clearance;
    });
    const result = await resolve('https://theditch.st/qhygxukd');
    setPageHtmlBrowser(null);
    assert.equal(asked, false, 'a normal page should not cost a headless browser');
    assert.match(result.files[0].ref.url, /\/signed\/plain$/);
  });

  await test('the tab title of the linked page is kept, separately from the file name', async () => {
    stubFetch(() => ({
      raw: '<title>Holiday clip — fileditch</title>' +
        '<video src="https://fileditchvids.st/b78/abc.mp4"></video>' +
        '<a href="/signed/abc">⬇ Download</a>',
      type: 'text/html',
    }));
    const result = await resolve('https://theditch.st/qhygxukd');
    assert.equal(result.pageTitle, 'Holiday clip — fileditch', JSON.stringify(result.pageTitle));
    assert.notEqual(result.files[0].name, result.pageTitle, 'the file name and the tab title are different things');
  });

  await test('a <title> is read the way a browser tab shows it', async () => {
    assert.equal(pageTitleOf('<title>A &amp; B</title>'), 'A & B');
    assert.equal(pageTitleOf('<title>  spaced   out </title>'), 'spaced out');
    assert.equal(pageTitleOf('<html>no title</html>'), null);
  });

  console.log('page titles');

  await test('reads og:title, title and h1, and strips the site suffix', async () => {
    assert.equal(pageDisplayName('<meta property="og:title" content="Clip One.mp4">'), 'Clip One.mp4');
    assert.equal(pageDisplayName('<title>Clip Two.mkv | Filester</title>'), 'Clip Two.mkv');
    assert.equal(pageDisplayName('<h1>Clip Three.mp4</h1>'), 'Clip Three.mp4');
    assert.equal(pageDisplayName('<title>Filester — free file host</title>'), null);
  });

  await test('a uuid is generated, a real name is not', () => {
    assert.equal(preferPageName('e78f1c92-7cbd-4065-84a0-36d240d61814.mkv', 'Real Name.mkv'), 'Real Name.mkv');
    assert.equal(preferPageName('holiday.mp4', 'Other.mp4'), 'holiday.mp4');
    assert.equal(preferPageName('abc.mp4', null), 'abc.mp4');
  });

  console.log('pixeldrain');

  await test('single file info includes name and size', async () => {
    stubFetch(() => ({ body: { name: 'clip.mkv', size: 1234, mime_type: 'video/x-matroska' } }));
    const result = await resolve('https://pixeldrain.com/u/abcd1234');
    assert.equal(result.files[0].name, 'clip.mkv');
    assert.equal(result.files[0].size, 1234);
  });

  console.log('direct + generic pages');

  await test('a .mp4 link is treated as a direct file', async () => {
    const result = await resolve('https://cdn.example.com/path/My%20Clip.mp4?token=1');
    assert.equal(result.resolver, 'direct');
    assert.equal(result.files[0].name, 'My Clip.mp4');
  });

  await test('extracts og:video, <video src> and <source src> from a page', async () => {
    const html = `
      <html><head>
        <meta property="og:video:secure_url" content="https://cdn.example.com/og.mp4" />
      </head><body>
        <video src="/media/player.webm"></video>
        <video><source src="https://cdn.example.com/source.mp4"></video>
        <script>var x = {"contentUrl":"https://cdn.example.com/jsonld.mp4"};</script>
      </body></html>`;
    stubFetch(() => ({ raw: html, type: 'text/html' }));
    const result = await resolve('https://example.com/watch/123');
    const names = result.files.map((f) => f.name);
    assert.equal(result.resolver, 'page');
    assert.ok(names.includes('og.mp4'), names.join(','));
    assert.ok(names.includes('player.webm'), names.join(','));
    assert.ok(names.includes('source.mp4'), names.join(','));
    assert.ok(names.includes('jsonld.mp4'), names.join(','));
  });

  await test('absolute mp4 urls are deduplicated and relativised correctly', () => {
    const urls = extractVideoUrls(
      `<video src="https://a.example/x.mp4"></video><a href="https://a.example/x.mp4">again</a>`,
      'https://a.example/',
    );
    assert.deepEqual(urls, ['https://a.example/x.mp4']);
  });

  await test('a page with only an HLS stream says so', async () => {
    stubFetch(() => ({ raw: '<script src="hls.js"></script><video></video>', type: 'text/html' }));
    await assert.rejects(resolve('https://example.com/stream'), (err) => err.code === 'NO_VIDEO_ON_PAGE');
  });

  await test('rejects a non-url', async () => {
    await assert.rejects(resolve('not a url'), (err) => err.code === 'BAD_URL');
  });

  console.log('network failures');

  await test('a blocked fetch surfaces as BLOCKED, not a crash', async () => {
    global.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(resolve('https://turbo.cr/d/abc'), (err) => err.code === 'BLOCKED');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
