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
  extractPlaylistUrls,
  isAdUrl,
  isAdCreativeUrl,
  looksLikeMediaSegment,
  parsePlaylistText,
  pickBestVariant,
  variantHeight,
  inspectPlaylist,
  nameForStream,
  clearStreamCache,
  pageDisplayName,
  preferPageName,
  setPageHtmlBrowser,
  setPageBrowser,
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

  await test('a page that only reveals its download button in a browser uses the browser', async () => {
    /* Exactly what the log showed: the fetched HTML has a player and nothing
       else, so the only "file" URL in it is the player page itself — which
       serves HTML. The browser DOM has the real anchor. */
    const signed = Buffer.from('1793555458:abc:36884/b78/abc.mp4').toString('base64url');
    stubFetch(() => ({
      raw: '<title>abc.mp4</title><video src="https://fileditchvids.st/b78/abc.mp4"></video>',
      type: 'text/html',
    }));
    let asked = false;
    setPageHtmlBrowser(async () => {
      asked = true;
      return {
        html:
          '<title>abc.mp4</title><video src="https://fileditchvids.st/b78/abc.mp4"></video>' +
          `<a class="button" href="https://lumistretcheseverymorning.xyz/${signed}">⬇ Download</a>`,
        cookie: 'cf_clearance=xyz',
        title: 'abc.mp4',
        url: 'https://fileditchvids.st/b78/abc.mp4',
      };
    });
    const result = await resolve('https://fileditchfiles.me/b78/abc.mp4');
    setPageHtmlBrowser(null);
    assert.equal(asked, true, 'the page had no file link, so the browser should have been asked');
    assert.match(result.files[0].ref.url, /lumistretcheseverymorning/, result.files[0].ref.url);
    assert.equal(result.files[0].ref.cookie, 'cf_clearance=xyz');
  });

  await test('a download anchor with no label is still a download anchor', async () => {
    const signed = Buffer.from('1793555458:abcDEFghiJKL:36884/b78/abc.mp4').toString('base64url');
    stubFetch(() => ({
      raw:
        '<title>abc.mp4</title><video src="https://fileditchvids.st/b78/abc.mp4"></video>' +
        `<a class="btn" href="https://lumistretcheseverymorning.xyz/${signed}"><svg></svg></a>`,
      type: 'text/html',
    }));
    const result = await resolve('https://theditch.st/qhygxukd');
    assert.match(result.files[0].ref.url, /lumistretcheseverymorning/, result.files[0].ref.url);
    assert.equal(result.files.length, 1);
  });

  await test('the player page is never offered before a minted link', async () => {
    const signed = Buffer.from('1793555458:abc:36884/b78/abc.mp4').toString('base64url');
    stubFetch(() => ({
      raw:
        '<title>abc.mp4</title><video src="https://fileditchvids.st/b78/abc.mp4"></video>' +
        `<a href="https://lumistretcheseverymorning.xyz/${signed}">⬇ Download</a>`,
      type: 'text/html',
    }));
    const result = await resolve('https://theditch.st/qhygxukd');
    const routes = await directCandidates(result.files[0].ref);
    assert.match(routes[0], /lumistretcheseverymorning/, routes[0]);
    const playerAt = routes.findIndex((route) => route.includes('fileditchvids.st'));
    assert.ok(playerAt === -1 || playerAt > 0, `player page at ${playerAt}: ${routes.join(', ')}`);
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

  /* ------------------------------------------------------------------ streams
   * missav.ws/en/dandya-045 plays its video from an HLS master on surrit.com.
   * Pasting that page used to resolve to an advertisement: the page carries an
   * ad .mp4, the real video is a playlist, and playlists were filtered out
   * before anything looked at them. */

  console.log('streams (HLS)');

  const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=845000,RESOLUTION=640x360,NAME="360p"
360p/video.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2100000,RESOLUTION=1280x720,NAME="720p"
720p/video.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=4800000,RESOLUTION=1920x1080,NAME="1080p"
1080p/video.m3u8
`;

  const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.006,
https://surrit.com/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/1080p/video0.ts
#EXTINF:6.006,
https://surrit.com/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/1080p/video1.ts
#EXTINF:2.500,
https://surrit.com/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/1080p/video2.ts
#EXT-X-ENDLIST
`;

  /* The page exactly as it behaves in the wild: an advert with a .mp4 (and a
     .mp4 ad network), and the real video in a player config, with escaped
     slashes because it is inside an inline script. */
  const MISSвAV_PAGE = `<html><head>
      <title>DANDYA-045 A long title here - MissAV</title>
      <meta property="og:video" content="https://ads.exoclick.com/vast/preroll.mp4" />
    </head><body>
      <video src="https://cdn.juicyads.com/creative/banner.mp4" autoplay muted></video>
      <script>
        jwplayer("player").setup({
          file: "https:\/\/surrit.com\/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0\/playlist.m3u8",
          image: "https://missav.ws/thumbs/1.jpg"
        });
      </script>
    </body></html>`;
  const MISSвAV_PAGE_FIXED = MISSвAV_PAGE.replace('MISSвAV', 'MISSAV');

  await test('a page that streams its video resolves to the stream, not to its advert', async () => {
    clearStreamCache();
    const pageUrl = 'https://missav.ws/en/dandya-045';
    stubFetch((url) => {
      if (url.includes('playlist.m3u8')) return { raw: MASTER, type: 'application/vnd.apple.mpegurl' };
      if (url.includes('/1080p/video.m3u8')) return { raw: MEDIA, type: 'application/vnd.apple.mpegurl' };
      return { raw: MISSвAV_PAGE_FIXED, type: 'text/html' };
    });

    const result = await resolve(pageUrl);
    assert.equal(result.resolver, 'stream', `resolved to ${result.resolver}`);
    assert.equal(result.files.length, 1, `${result.files.length} files`);
    assert.match(result.files[0].ref.url, /^https:\/\/surrit\.com\/91f6b5f7.*\/playlist\.m3u8$/);
    assert.equal(result.files[0].ref.resolver, 'stream');
    /* The CDN wants the page it belongs to as the referer. */
    assert.equal(result.files[0].ref.referer, pageUrl);
    assert.match(result.files[0].name, /^DANDYA-045/);
  });

  await test('and the advert is not offered as a second file', async () => {
    const result = await resolve('https://missav.ws/en/dandya-045');
    const urls = result.files.map((file) => file.ref.url);
    assert.ok(!urls.some((url) => /exoclick|juicyads/.test(url)), urls.join(', '));
  });

  await test('an ad network host is recognised, a CDN is not', () => {
    assert.equal(isAdUrl('https://ads.exoclick.com/vast/preroll.mp4'), true);
    assert.equal(isAdUrl('https://cdn.juicyads.com/x/banner.mp4'), true);
    assert.equal(isAdUrl('https://surrit.com/91f6/playlist.m3u8'), false);
    assert.equal(isAdUrl('https://cdn.example.com/movie.mp4'), false);
  });

  await test('escaped slashes in a player config are understood', () => {
    const urls = extractPlaylistUrls(
      '<script>player.setup({file: "https:\/\/surrit.com\/abc\/playlist.m3u8"});</script>',
      'https://missav.ws/en/dandya-045',
    );
    assert.deepEqual(urls, ['https://surrit.com/abc/playlist.m3u8']);
  });

  await test('a relative playlist in a <source> is made absolute', () => {
    const urls = extractPlaylistUrls(
      '<video><source src="media/stream.m3u8" type="application/x-mpegURL"></video>',
      'https://example.com/watch/1',
    );
    assert.deepEqual(urls, ['https://example.com/watch/media/stream.m3u8']);
  });

  await test('a playlist announced in og:video counts too', () => {
    const urls = extractPlaylistUrls(
      '<meta property="og:video" content="https://cdn.example.com/live/master.m3u8" />',
      'https://example.com/',
    );
    assert.deepEqual(urls, ['https://cdn.example.com/live/master.m3u8']);
  });

  await test('the best quality is chosen, not the first one listed', () => {
    const parsed = parsePlaylistText(MASTER, 'https://surrit.com/91f6/playlist.m3u8');
    assert.equal(parsed.master, true);
    assert.equal(parsed.variants.length, 3);
    const best = pickBestVariant(parsed.variants);
    assert.equal(best.height, 1080);
    assert.equal(best.uri, 'https://surrit.com/91f6/1080p/video.m3u8');
  });

  await test('without resolutions, the highest bandwidth wins', () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000
high/index.m3u8
`;
    const parsed = parsePlaylistText(text, 'https://cdn.example.com/v/');
    assert.equal(pickBestVariant(parsed.variants).uri, 'https://cdn.example.com/v/high/index.m3u8');
  });

  await test('a quality in the variant name counts when RESOLUTION is missing', () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,NAME="480p"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,NAME="1080p"
1080/index.m3u8
`;
    const parsed = parsePlaylistText(text, 'https://cdn.example.com/x/');
    const best = pickBestVariant(parsed.variants);
    assert.equal(variantHeight(best), 1080);
  });

  await test('the length of a stream is the sum of its segments', () => {
    const parsed = parsePlaylistText(MEDIA, 'https://surrit.com/x/1080p/video.m3u8');
    assert.equal(parsed.duration, 14.512);
    assert.equal(parsed.segmentCount, 3);
    assert.equal(parsed.live, false);
    assert.equal(parsed.segments[0], 'https://surrit.com/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/1080p/video0.ts');
  });

  await test('a live stream is refused in words a person can act on', async () => {
    clearStreamCache();
    const live = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:42
#EXTINF:6.0,
https://cdn.example.com/live/seg42.ts
`;
    stubFetch(() => ({ raw: live, type: 'application/vnd.apple.mpegurl' }));
    await assert.rejects(resolve('https://cdn.example.com/live/chunklist.m3u8'), (err) => err.code === 'STREAM_LIVE');
  });

  await test('a pasted .m3u8 is a job of its own, named after its host and quality', async () => {
    clearStreamCache();
    stubFetch((url) =>
      url.endsWith('playlist.m3u8')
        ? { raw: MASTER, type: 'application/vnd.apple.mpegurl' }
        : { raw: MEDIA, type: 'application/vnd.apple.mpegurl' },
    );
    const result = await resolve('https://surrit.com/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/playlist.m3u8');
    assert.equal(result.resolver, 'stream');
    const file = result.files[0];
    assert.equal(file.quality, '1080p');
    assert.match(file.name, /^surrit-1080p\.mp4$/, file.name);
    assert.ok(file.size > 0, 'an estimated size is better than none');
    assert.equal(file.sizeIsEstimate, undefined);
  });

  await test('the file ref resolves to the chosen variant playlist', async () => {
    clearStreamCache();
    stubFetch((url) =>
      url.endsWith('/playlist.m3u8')
        ? { raw: MASTER, type: 'application/vnd.apple.mpegurl' }
        : { raw: MEDIA, type: 'application/vnd.apple.mpegurl' },
    );
    const resolved = await resolve('https://surrit.com/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/playlist.m3u8');
    const ref = resolved.files[0].ref;
    const url = await directUrl(ref);
    assert.equal(url, 'https://surrit.com/91f6/1080p/video.m3u8'.replace('91f6/', '91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/'));
    /* The findings are handed back on the ref: the disk check and the card use
       the length and the estimate. */
    assert.equal(ref.quality, 1080);
    assert.equal(ref.duration, 14.512);
    assert.ok(ref.estimatedBytes > 1000);
  });

  await test('a page that offers several qualities gives the best one, not the first', async () => {
    clearStreamCache();
    const page = `<html><head><title>Quality selector page</title></head><body>
      <script>
        const qualities = {
          low:  "https://cdn.example.com/low/playlist.m3u8",
          high: "https://cdn.example.com/high/playlist.m3u8"
        };
      </script></body></html>`;
    const master = (height) => `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x${height},NAME="${height}p"
video.m3u8
`;
    const media = `#EXTM3U
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
`;
    stubFetch((url) => {
      if (url.includes('/low/playlist.m3u8')) return { raw: master(360), type: 'application/vnd.apple.mpegurl' };
      if (url.includes('/high/playlist.m3u8')) return { raw: master(1080), type: 'application/vnd.apple.mpegurl' };
      if (url.endsWith('video.m3u8')) return { raw: media, type: 'application/vnd.apple.mpegurl' };
      return { raw: page, type: 'text/html' };
    });

    const result = await resolve('https://example.com/watch/quality');
    assert.equal(result.files.length, 1, `${result.files.length} files offered`);
    assert.match(result.files[0].ref.url, /\/high\/playlist\.m3u8$/, result.files[0].ref.url);
  });

  /* The report, in full: twelve "files", 1.4 MB altogether, one a 300x250
     banner and the rest numbered 240p pieces — and no video. The page is behind
     a bot check, so the server got 403 and went straight to the browser's
     network log; the playlist was in the page's own HTML all along. */
  const AD_SEGMENTS = [
    'https://cdn7.trafficjunky.net/9558-0-300x250.medium.mp4',
    'https://cdn7.trafficjunky.net/117761513_240p_h264_init_2Ysckw54fQhbxoSl.mp4',
    'https://cdn7.trafficjunky.net/117761513_240p_h264_1324_kztiJgf5nAdkJ7y9_1793730536.mp4',
    'https://cdn7.trafficjunky.net/117761513_240p_h264_1325_LibgG90slDw5LFmt_1793730538.mp4',
    'https://cdn7.trafficjunky.net/251503909_240p_h264_init_wfSzWIChY87UeYKh.mp4',
    'https://cdn7.trafficjunky.net/251503909_240p_h264_488_RrP3lrNAEhZ4asgM_1793730538.mp4',
    'https://cdn7.trafficjunky.net/223164248_240p_h264_4157_yPD3lVPI803J5dOJ_1793730537.mp4',
  ];

  await test('a bot-checked page is read through the browser HTML, not its ad requests', async () => {
    clearStreamCache();
    /* The plain request is refused, as Cloudflare does for missav. */
    stubFetch(() => ({ raw: '<html><title>Just a moment...</title></html>', type: 'text/html', status: 403 }));
    setPageHtmlBrowser(async () => ({
      title: 'DANDYA-027 A title - MissAV',
      url: 'https://missav.ws/dm72/en/dandya-027',
      cookie: 'cf_clearance=abc',
      userAgent: 'Chrome-test',
      html: `<html><head><title>DANDYA-027 A title - MissAV</title></head><body>
        <video src="https://cdn7.trafficjunky.net/9558-0-300x250.medium.mp4"></video>
        <script>
          var m3u8 = "https://surrit.com/91f6b5f7-5ca7-4c3f-b4b0-2d42d98222f0/playlist.m3u8";
          player.setup({ file: m3u8 });
        </script></body></html>`,
    }));
    /* ...and the network log is nothing but ad segments. */
    setPageBrowser(async () => ({
      media: AD_SEGMENTS.map((url) => ({ url, contentType: 'video/mp4' })),
      cookie: 'cf_clearance=abc',
      userAgent: 'Chrome-test',
    }));
    try {
      const result = await resolve('https://missav.ws/dm72/en/dandya-027#1b83c59d-f570-4957-b6be-8ad4c24f63de_desktop-watch-next-side');
      assert.equal(result.files.length, 1, `${result.files.length} files offered`);
      assert.equal(result.resolver, 'stream');
      assert.match(result.files[0].ref.url, /surrit\.com\/.*\/playlist\.m3u8$/);
      assert.equal(result.files[0].ref.referer, 'https://missav.ws/dm72/en/dandya-027');
      assert.equal(result.files[0].ref.cookie, 'cf_clearance=abc');
      assert.match(result.files[0].name, /^DANDYA-027/);
      assert.equal(result.pageTitle, 'DANDYA-027 A title - MissAV');
    } finally {
      setPageHtmlBrowser(null);
      setPageBrowser(null);
    }
  });

  await test('and when the page really offers nothing but ads, it says so instead', async () => {
    clearStreamCache();
    stubFetch(() => ({ raw: '<html><title>Just a moment...</title></html>', type: 'text/html', status: 403 }));
    setPageHtmlBrowser(async () => ({
      title: 'Blocked',
      url: 'https://missav.ws/en/x',
      html: '<html><body><video></video></body></html>',
    }));
    setPageBrowser(async () => ({ media: AD_SEGMENTS.map((url) => ({ url, contentType: 'video/mp4' })) }));
    try {
      await assert.rejects(resolve('https://missav.ws/en/x'), (err) => err.code === 'BAD_STATUS');
    } finally {
      setPageHtmlBrowser(null);
      setPageBrowser(null);
    }
  });

  await test('every one of the twelve files in the report is refused as a video', () => {
    for (const url of AD_SEGMENTS) {
      assert.ok(
        looksLikeMediaSegment(url) || isAdCreativeUrl(url) || isAdUrl(url),
        `offered anyway: ${url}`,
      );
    }
  });

  const segmentsAPageAdvertised = [
    'https://x.example/117761513_240p_h264_1324_kztiJgf5nAdkJ7y9_1793730536.mp4',
  ];

  await test('a segment advertised in the HTML is not offered as a file either', async () => {
    clearStreamCache();
    stubFetch(() => ({
      raw: `<html><head><title>A page</title></head><body><video src="${segmentsAPageAdvertised[0]}"></video></body></html>`,
      type: 'text/html',
    }));
    await assert.rejects(resolve('https://x.example/watch'), (err) => err.code === 'NO_VIDEO_ON_PAGE');
  });

  await test('the segments a browser saw are not listed as hundreds of files', async () => {
    clearStreamCache();
    stubFetch(() => ({ raw: '<html><body>player page</body></html>', type: 'text/html' }));
    setPageBrowser(async () => ({
      media: [
        { url: 'https://surrit.com/91f6/playlist.m3u8', contentType: 'application/vnd.apple.mpegurl' },
        { url: 'https://surrit.com/91f6/1080p/video0.ts', contentType: 'video/mp2t' },
        { url: 'https://surrit.com/91f6/1080p/video1.ts', contentType: 'video/mp2t' },
        { url: 'https://ads.exoclick.com/pre.mp4', contentType: 'video/mp4' },
      ],
    }));
    try {
      const result = await resolve('https://missav.ws/en/dandya-045');
      assert.equal(result.files.length, 1, result.files.map((f) => f.name).join(', '));
      assert.equal(result.files[0].ref.resolver, 'stream');
      assert.match(result.files[0].ref.url, /playlist\.m3u8$/);
    } finally {
      setPageBrowser(null);
    }
  });

  await test('a stream that refuses a bare request is retried with the CDN as its own referer', async () => {
    clearStreamCache();
    const seen = [];
    stubFetch((url, init) => {
      seen.push((init.headers && (init.headers.referer || init.headers.Referer)) || null);
      const referer = (init.headers && (init.headers.referer || init.headers.Referer)) || '';
      if (!referer.startsWith('https://surrit.com')) {
        return { raw: 'referer required', type: 'text/plain', status: 403 };
      }
      return { raw: MEDIA, type: 'application/vnd.apple.mpegurl' };
    });
    const info = await inspectPlaylist('https://surrit.com/91f6/playlist.m3u8');
    assert.ok(info.duration > 0, 'the playlist was read');
    assert.equal(seen[0], null, 'the first attempt carried no referer');
    assert.ok(
      seen.some((value) => value && value.startsWith('https://surrit.com')),
      `no referer attempt: ${JSON.stringify(seen)}`,
    );
    /* The headers that worked are handed back for the download, because the
       segments are guarded exactly the same way. */
    assert.ok(info.headers && /surrit\.com/.test(info.headers.referer || ''), JSON.stringify(info.headers));
  });

  await test('and when every attempt is refused, it says what to do next', async () => {
    clearStreamCache();
    stubFetch(() => ({ raw: 'no', type: 'text/plain', status: 403 }));
    await assert.rejects(
      inspectPlaylist('https://surrit.com/other/playlist.m3u8'),
      (err) =>
        err.code === 'STREAM_FORBIDDEN' &&
        /paste the page/i.test(err.message) &&
        !/^HTTP 403/.test(err.message),
    );
  });

  await test('a stream whose playlist is really a web page says so', async () => {
    clearStreamCache();
    stubFetch(() => ({ raw: '<!doctype html><html><body>nope</body></html>', type: 'text/html' }));
    await assert.rejects(
      inspectPlaylist('https://surrit.com/other/playlist.m3u8'),
      (err) => err.code === 'STREAM_NOT_A_PLAYLIST',
    );
  });

  await test('a DRM-protected stream is refused instead of failing halfway', async () => {
    clearStreamCache();
    const protectedPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
`;
    stubFetch(() => ({ raw: protectedPlaylist, type: 'application/vnd.apple.mpegurl' }));
    await assert.rejects(
      resolve('https://cdn.example.com/protected/playlist.m3u8'),
      (err) => err.code === 'STREAM_DRM' && /DRM/.test(err.message),
    );
  });

  await test('a name comes from the URL when it has a real one', () => {
    assert.equal(nameForStream('https://cdn.example.com/holiday/beach-day.m3u8', { height: 720 }), 'beach-day-720p.mp4');
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
