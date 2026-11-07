#!/usr/bin/env node
/**
 * Regression tests for the bugs that came back from real use:
 *   - a bunkr/fileditch ref was rejected with "That file reference is not valid"
 *   - a fileditch share page is HTML, and its real file sits behind a
 *     "Download" anchor on a rotating hostname.
 */
'use strict';

process.env.ALLOW_PRIVATE_HOSTS = '1';
/* The test host stands in for fileditchfiles.me, which the resolver only treats
   as a share page because of its hostname. */
process.env.FILEDITCH_HOSTS = '127.0.0.1';
/* Where a signed link's player page lives; production default is fileditchvids.st. */


const assert = require('node:assert');
const http = require('node:http');

const { resolve, directUrl } = require('../shared/resolve');

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

const PLAYER = `<!doctype html><html><head><title>WlVHBYDPhhHcSTmGUcvy.mp4</title></head>
<body><div>WlVHBYDPhhHcSTmGUcvy.mp4</div><div>1.76 GB</div>
<a class="dl" href="/signed/abc123">⬇ Download</a>
<a href="https://abuse.fileditch.com/b78/x.mp4">🚨 Report</a></body></html>`;

/* Exactly what theditch.st served in real use: the player page advertises the
   video through a <video src>, and the "Download" anchor points at a rotating
   host with a signed, short-lived base64 path. */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
const SIGNED_PATH = b64('1793500016:icbgMMXQZOfZvPeluq9IuZ7ZkGhxKMS4U8cvQu4LqIA:22773/b78/WlVHBYDPhhHcSTmGUcvy.mp4');
const REAL_PAGE = `<!doctype html><html><head><title>WlVHBYDPhhHcSTmGUcvy.mp4</title></head>
<body><div>1.76 GB</div>
<video controls><source src="/b78/WlVHBYDPhhHcSTmGUcvy.mp4" type="video/mp4"></video>
<a class="dl" href="PAGEBASE/${SIGNED_PATH}">⬇ Download</a>
<a href="https://abuse.fileditch.com/b78/x.mp4">🚨 Report</a></body></html>`;

(async () => {
  let pageFetches = 0;
  const server = http.createServer((req, res) => {
    // The rotating download host.
    if (req.url === `/${SIGNED_PATH}`) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '8' });
      res.end(Buffer.alloc(8, 2));
      return;
    }
    if (req.url === '/b78/WlVHBYDPhhHcSTmGUcvy.mp4' || req.url === '/real/b78/WlVHBYDPhhHcSTmGUcvy.mp4') {
      pageFetches += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(REAL_PAGE.replace('PAGEBASE', `http://127.0.0.1:${server.address().port}`));
      return;
    }
    if (req.url === '/b78/file.mp4') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PLAYER);
      return;
    }
    if (req.url === '/signed/abc123') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '8' });
      res.end(Buffer.alloc(8, 1));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Where a signed link's player page lives (production: fileditchvids.st).
  process.env.FILEDITCH_PAGE_BASE = base;

  await check('a fileditch player page resolves to its signed download link', async () => {
    const result = await resolve(`${base}/b78/file.mp4`);
    assert.equal(result.resolver, 'fileditch');
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].ref.url, /\/signed\/abc123$/);
  });

  await check('the file name and size are read from the page', async () => {
    const result = await resolve(`${base}/b78/file.mp4`);
    assert.equal(result.files[0].name, 'WlVHBYDPhhHcSTmGUcvy.mp4');
    assert.equal(result.files[0].size, Math.round(1.76 * 1024 ** 3));
  });

  await check('the ref remembers the page as its referer', async () => {
    const result = await resolve(`${base}/b78/file.mp4`);
    assert.equal(result.files[0].ref.referer, `${base}/b78/file.mp4`);
  });

  await check('directUrl turns that ref back into the signed link', async () => {
    const result = await resolve(`${base}/b78/file.mp4`);
    const url = await directUrl(result.files[0].ref);
    assert.match(url, /\/signed\/abc123$/);
  });

  await check('a player page offers ONE file, not the page and the file', async () => {
    const result = await resolve(`${base}/b78/WlVHBYDPhhHcSTmGUcvy.mp4`);
    assert.equal(result.files.length, 1, `${result.files.length} entries: ${result.files.map((f) => f.ref.url).join(', ')}`);
    assert.match(result.files[0].ref.url, new RegExp(`${SIGNED_PATH}$`), 'it kept the player page instead of the download link');
  });

  await check('the file keeps the host\'s own name', async () => {
    const result = await resolve(`${base}/b78/WlVHBYDPhhHcSTmGUcvy.mp4`);
    assert.equal(result.files[0].name, 'WlVHBYDPhhHcSTmGUcvy.mp4');
  });

  await check('a signed link is re-minted at download time, not reused', async () => {
    const result = await resolve(`${base}/b78/WlVHBYDPhhHcSTmGUcvy.mp4`);
    const before = pageFetches;
    await directUrl(result.files[0].ref);
    assert.ok(pageFetches > before, 'it handed back the stored (soon to expire) link');
  });

  await check('a pasted, expired signed link goes back to its page', async () => {
    const expired = `http://127.0.0.1:${server.address().port}/${SIGNED_PATH}`;
    const result = await resolve(expired);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].name, /\.mp4$/);
  });

  await check('every resolver that can produce a ref has a direct()', () => {
    const { RESOLVERS } = require('../shared/resolve');
    for (const id of ['gofile', 'turbo', 'pixeldrain', 'bunkr', 'filester', 'fileditch', 'direct']) {
      const resolver = RESOLVERS.find((r) => r.id === id);
      assert.ok(resolver, `${id} is not registered`);
      assert.equal(typeof resolver.direct, 'function', `${id} has no direct()`);
    }
  });

  await check('the server accepts refs from every one of them', async () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server', 'server.js'), 'utf8');
    const block = /ALLOWED_REF_RESOLVERS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
    assert.ok(block, 'allow-list not found');
    for (const id of ['gofile', 'turbo', 'pixeldrain', 'bunkr', 'filester', 'fileditch', 'direct']) {
      assert.ok(block[1].includes(`'${id}'`), `${id} is missing from ALLOWED_REF_RESOLVERS`);
    }
  });

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
