'use strict';

/**
 * Hoster adapter tests. No network: fetch is stubbed with the response shapes
 * these APIs actually return, and the local file is a real temp file so the
 * streaming multipart/raw bodies are genuinely exercised.
 *
 *   node scripts/hosters.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const hosters = require('../server/hosters');

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

/** Stub fetch, capturing every request (method, url, headers, body length). */
function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
      contentLength: Number((init.headers || {})['content-length'] || 0),
    };
    calls.push(record);
    const spec = await handler(record);
    const text = typeof spec === 'string' ? spec : JSON.stringify(spec.body ?? {});
    return new Response(text, {
      status: spec.status || 200,
      headers: { 'content-type': spec.type || 'application/json' },
    });
  };
  return calls;
}

async function readStreamLength(body) {
  if (!body || typeof body.getReader !== 'function') return 0;
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
  }
  return total;
}

(async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-host-'));
  const filePath = path.join(tmpDir, 'video.mp4');
  const payload = Buffer.alloc(64 * 1024, 7); // 64 KB of deterministic bytes
  await fsp.writeFile(filePath, payload);

  console.log('gofile');

  await test('mints a guest token, picks a server, streams multipart', async () => {
    const calls = stubFetch((call) => {
      if (call.url.endsWith('/accounts')) return { body: { status: 'ok', data: { token: 'guest-1' } } };
      if (call.url.endsWith('/servers')) {
        return { body: { status: 'ok', data: { servers: [{ name: 'store-eu-par-5' }] } } };
      }
      return {
        body: { status: 'ok', data: { downloadPage: 'https://gofile.io/d/AbCd1234', id: 'file-1' } },
      };
    });

    const result = await hosters.uploadToHoster(filePath, { name: 'clip.mp4' }, {
      order: ['gofile'],
      onProgress: () => {},
    });

    assert.equal(result.provider, 'gofile');
    assert.equal(result.url, 'https://gofile.io/d/AbCd1234');

    const upload = calls.find((c) => c.url.includes('/contents/uploadfile'));
    assert.ok(upload, 'upload endpoint called');
    assert.equal(upload.method, 'POST');
    assert.equal(upload.url, 'https://store-eu-par-5.gofile.io/contents/uploadfile');
    assert.match(String(upload.headers['content-type']), /multipart\/form-data; boundary=/);
    assert.equal(upload.headers.authorization, 'Bearer guest-1');
    // multipart overhead + the file itself
    assert.ok(upload.contentLength > payload.length, 'content-length covers the file');
    const streamed = await readStreamLength(upload.body);
    assert.equal(streamed, upload.contentLength, 'streamed length matches the declared content-length');
  });

  await test('a refusal is surfaced with its status', async () => {
    stubFetch((call) => {
      if (call.url.endsWith('/accounts')) return { body: { status: 'ok', data: { token: 't' } } };
      if (call.url.endsWith('/servers')) return { body: { status: 'ok', data: { servers: [{ name: 's1' }] } } };
      return { body: { status: 'error-notPremium', data: {} } };
    });
    await assert.rejects(
      hosters.uploadToHoster(filePath, { name: 'x.mp4' }, { order: ['gofile'] }),
      (err) => err.code === 'ALL_HOSTS_FAILED' && /gofile/.test(err.message),
    );
  });

  console.log('pixeldrain');

  await test('posts the raw file and builds /u/ link', async () => {
    const calls = stubFetch(() => ({ body: { id: 'p1xelDr4in' } }));
    const result = await hosters.uploadToHoster(filePath, { name: 'my clip.mp4' }, { order: ['pixeldrain'] });
    assert.equal(result.url, 'https://pixeldrain.com/u/p1xelDr4in');

    const upload = calls[0];
    assert.equal(upload.method, 'POST');
    assert.match(upload.url, /\/api\/file\/my%20clip\.mp4$/);
    assert.equal(upload.contentLength, payload.length);
    assert.equal(await readStreamLength(upload.body), payload.length);
  });

  await test('an API base override is honoured (self-hosted/testing)', async () => {
    process.env.PIXELDRAIN_API_BASE = 'http://127.0.0.1:9999';
    const calls = stubFetch(() => ({ body: { id: 'abc' } }));
    const result = await hosters.uploadToHoster(filePath, { name: 'a.mp4' }, { order: ['pixeldrain'] });
    assert.equal(result.url, 'http://127.0.0.1:9999/u/abc');
    assert.ok(calls[0].url.startsWith('http://127.0.0.1:9999'));
    delete process.env.PIXELDRAIN_API_BASE;
  });

  console.log('catbox');

  await test('posts multipart and reads the plain-text URL back', async () => {
    const calls = stubFetch(() => 'https://files.catbox.moe/abc123.mp4');
    const result = await hosters.uploadToHoster(filePath, { name: 'c.mp4' }, { order: ['catbox'] });
    assert.equal(result.url, 'https://files.catbox.moe/abc123.mp4');
    assert.match(String(calls[0].headers['content-type']), /multipart\/form-data/);
    assert.equal(await readStreamLength(calls[0].body), calls[0].contentLength);
  });

  console.log('fallback chain');

  await test('falls through to the next host when one fails', async () => {
    const calls = stubFetch((call) => {
      if (call.url.includes('/accounts')) return { status: 500, body: { status: 'error' } };
      if (call.url.includes('pixeldrain')) return { body: { id: 'second' } };
      return { body: {} };
    });
    const result = await hosters.uploadToHoster(filePath, { name: 'f.mp4' }, { order: ['gofile', 'pixeldrain'] });
    assert.equal(result.provider, 'pixeldrain');
    assert.equal(result.url, 'https://pixeldrain.com/u/second');
    assert.equal(result.attempts[0].ok, false);
    assert.ok(calls.some((c) => c.url.includes('pixeldrain')));
  });

  await test('skips a host whose size limit the file exceeds', async () => {
    const big = path.join(tmpDir, 'big.bin');
    // Sparse file: claims 300 MB without writing it all to disk.
    const handle = await fsp.open(big, 'w');
    await handle.truncate(300 * 1024 * 1024);
    await handle.close();

    const calls = stubFetch(() => ({ body: { id: 'only-pixeldrain' } }));
    const result = await hosters.uploadToHoster(big, { name: 'big.mp4' }, { order: ['catbox', 'pixeldrain'] });
    assert.equal(result.provider, 'pixeldrain', 'catbox (200 MB limit) was skipped');
    assert.ok(!calls.some((c) => c.url.includes('catbox')));
    await fsp.rm(big, { force: true });
  });

  await test('reports every failure when nothing accepts the file', async () => {
    stubFetch(() => ({ status: 503, body: { message: 'down' } }));
    await assert.rejects(
      hosters.uploadToHoster(filePath, { name: 'x.mp4' }, { order: ['pixeldrain'] }),
      (err) => err.code === 'ALL_HOSTS_FAILED' && /pixeldrain/.test(err.message),
    );
  });

  await test('describes enabled providers for the UI', async () => {
    process.env.HOSTERS = 'pixeldrain,catbox';
    const list = hosters.describeProviders();
    assert.deepEqual(list.map((p) => p.id), ['pixeldrain', 'catbox']);
    assert.ok(list[1].maxBytes <= 200 * 1024 * 1024);
    delete process.env.HOSTERS;
  });

  await fsp.rm(tmpDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
