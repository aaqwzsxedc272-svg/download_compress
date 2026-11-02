#!/usr/bin/env node
/**
 * Proves the browser-fallback plumbing without needing Chromium: a fake host
 * that refuses plain requests stand-in for fileditch / filester.
 */
'use strict';

process.env.ALLOW_PRIVATE_HOSTS = '1';

const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const sources = require('../server/sources');
const { downloadWithFallback } = require('../server/fallback');

const VIDEO = Buffer.alloc(4096, 7);
let host;
let base;

function start() {
  return new Promise((resolve) => {
    host = http.createServer((req, res) => {
      if (req.url === '/guarded.mp4') {
        // Exactly what a hotlink-protected CDN does: 200 with an HTML page.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body>challenge</body></html>');
        return;
      }
      if (req.url === '/forbidden.mp4') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      if (req.url === '/real.mp4') {
        const wantsReferer = req.headers.referer === `${base}/watch`;
        if (!wantsReferer) {
          res.writeHead(403).end('no referer');
          return;
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': VIDEO.length });
        res.end(VIDEO);
        return;
      }
      if (req.url === '/expired.mp4') {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('link expired');
        return;
      }
      if (req.url === '/open.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': VIDEO.length });
        res.end(VIDEO);
        return;
      }
      if (req.url === '/watch') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><video src="/real.mp4"></video></body></html>');
        return;
      }
      res.writeHead(404).end();
    });
    host.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${host.address().port}`;
      resolve();
    });
  });
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.log(`  FAIL ${name}\n       ${err.message}`);
    });
}

(async () => {
  await start();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-'));

  await check('a plain request to the guarded file yields an HTML page', async () => {
    await assert.rejects(
      () => sources.downloadHttp(`${base}/guarded.mp4`, path.join(dir, 'a.bin')),
      (err) => err.code === 'HTML_PAGE',
    );
  });

  await check('the browser retry wins with the captured URL and referer', async () => {
    const dest = path.join(dir, 'b.mp4');
    const result = await downloadWithFallback({
      url: `${base}/guarded.mp4`,
      pageUrl: `${base}/watch`,
      destPath: dest,
      download: (u, d, o) => sources.downloadHttp(u, d, o),
      capture: async () => ({ media: [{ url: `${base}/real.mp4`, referer: `${base}/watch` }], cookie: 'a=b' }),
    });
    assert.equal(result.usedBrowser, true);
    const bytes = await fsp.readFile(dest);
    assert.equal(bytes.length, VIDEO.length);
  });

  await check('a 403 is retried the same way', async () => {
    const dest = path.join(dir, 'c.mp4');
    const result = await downloadWithFallback({
      url: `${base}/forbidden.mp4`,
      pageUrl: `${base}/watch`,
      destPath: dest,
      download: (u, d, o) => sources.downloadHttp(u, d, o),
      capture: async () => ({ media: [{ url: `${base}/real.mp4`, referer: `${base}/watch` }] }),
    });
    assert.equal(result.usedBrowser, true);
    assert.equal((await fsp.readFile(dest)).length, VIDEO.length);
  });

  await check('an expired signed link is refreshed before the browser is used', async () => {
    const dest = path.join(dir, 'f.mp4');
    let captureCalls = 0;
    const result = await downloadWithFallback({
      url: `${base}/expired.mp4`,
      pageUrl: `${base}/watch`,
      destPath: dest,
      download: (u, d, o) => sources.downloadHttp(u, d, o),
      capture: async () => {
        captureCalls += 1;
        return { media: [{ url: `${base}/real.mp4`, referer: `${base}/watch` }] };
      },
      refresh: async () => `${base}/open.mp4`,
    });
    assert.equal(result.refreshed, true);
    assert.equal(captureCalls, 0, 'it spent a browser on a link it could simply re-mint');
    assert.equal((await fsp.readFile(dest)).length, VIDEO.length);
  });

  await check('a refresh that returns a dead link still falls back to the browser', async () => {
    const dest = path.join(dir, 'g.mp4');
    const result = await downloadWithFallback({
      url: `${base}/expired.mp4`,
      pageUrl: `${base}/watch`,
      destPath: dest,
      download: (u, d, o) => sources.downloadHttp(u, d, o),
      capture: async () => ({ media: [{ url: `${base}/real.mp4`, referer: `${base}/watch` }] }),
      refresh: async () => `${base}/expired.mp4`,
    });
    assert.equal(result.usedBrowser, true);
    assert.equal((await fsp.readFile(dest)).length, VIDEO.length);
  });

  await check('without a capture the original error is reported', async () => {
    await assert.rejects(
      () =>
        downloadWithFallback({
          url: `${base}/guarded.mp4`,
          pageUrl: `${base}/watch`,
          destPath: path.join(dir, 'd.mp4'),
          download: (u, d, o) => sources.downloadHttp(u, d, o),
          capture: null,
        }),
      (err) => err.code === 'HTML_PAGE',
    );
  });

  await check('a capture that finds nothing keeps the original error', async () => {
    await assert.rejects(
      () =>
        downloadWithFallback({
          url: `${base}/guarded.mp4`,
          pageUrl: `${base}/watch`,
          destPath: path.join(dir, 'e.mp4'),
          download: (u, d, o) => sources.downloadHttp(u, d, o),
          capture: async () => ({ media: [] }),
        }),
      (err) => err.code === 'HTML_PAGE',
    );
  });

  await fsp.rm(dir, { recursive: true, force: true });
  host.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
