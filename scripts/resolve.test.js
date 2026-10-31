'use strict';

/**
 * Resolver unit tests. No network: fetch is stubbed with the real response
 * shapes captured from api.gofile.io / turbo.cr / pixeldrain.
 *
 *   node scripts/resolve.test.js
 */

const assert = require('node:assert');
const { resolve, directUrl, extractVideoUrls } = require('../shared/resolve');

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
      headers: { 'content-type': (result && result.type) || 'application/json' },
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
