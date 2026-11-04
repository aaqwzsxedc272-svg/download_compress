#!/usr/bin/env node
/**
 * A CDN that refuses the app and serves the browser — end to end.
 *
 * This is the report, reproduced: `missav.ws/en/dandya-045`, whose video lives
 * on `surrit.com`. The playlist and every segment answer HTTP 403 to Node and to
 * ffmpeg *with the page's cookies, referer and user agent*, and answer 200 to
 * Chromium asking for the same URL. The difference is the client — TLS
 * fingerprint, HTTP/2 settings — so no header can fix it, and the only download
 * that can work is one the browser makes.
 *
 * The fixture here gates on a cookie **and** a header only a browser puts on the
 * request, which is a fair model of that: replaying cookies gets you nothing.
 * Then it checks the three links of the chain:
 *
 *   - `streamDownload` fetches the pieces inside the browser,
 *   - `remuxLocalPlaylist` turns those local pieces into one playable MP4,
 *   - `resolve()` reads a pasted playlist that Node cannot read at all.
 *
 *   npm run test:browser:stream
 */
'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { probe } = require('../server/ffmpeg');

const ROOT = path.join(__dirname, '..');
const MEDIA_DIR = path.join(os.tmpdir(), `squeeze-bstream-media-${process.pid}`);
const OUT_DIR = path.join(os.tmpdir(), `squeeze-bstream-out-${process.pid}`);
const COOKIE = 'sid=ok';

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

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-400)))));
  });
}

/* ---------------------------------------------------------------- fake browser
 *
 * Playwright is not installed in most of the places this runs, and a 100 MB
 * download has no business in a test anyway. The fake runs the in-page function
 * for real — `fetch`, `btoa` and `Uint8Array` all exist in Node — and only the
 * two things a browser adds are simulated: the cookie jar, and the client-level
 * signal the CDN checks. That is enough for the code under test to be the code
 * that ships.
 */
function makeFakePlaywright({ hits, deny = false, cors = false } = {}) {
  let queue = Promise.resolve();
  let html = '<html><body><video></video></body></html>';
  /* The response the next navigation produces, and whoever is waiting for it. */
  let waiter = null;
  const load = async (target) => {
    const res = await fetch(String(target), {
      headers: { cookie: COOKIE, 'x-browser': '1' },
    }).catch(() => null);
    const buffer = res && res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    return {
      url: () => String(target),
      status: () => (res ? res.status : 0),
      headers: () => ({ 'content-type': (res && res.headers.get('content-type')) || '' }),
      body: async () => buffer,
      text: async () => (buffer ? buffer.toString('utf8') : ''),
    };
  };
  const page = {
    url: () => 'https://site.test/en/dandya-045',
    title: async () => 'DANDYA-045 a film - MissAV',
    content: async () => html,
    /* Resolves when the next navigation has its response — Playwright's
       `waitForResponse`, reduced to what a page that navigates once needs. */
    waitForResponse: () =>
      new Promise((resolve) => {
        waiter = resolve;
      }),
    goto: async (target) => {
      hits.push(String(target));
      const response = await load(target);
      if (waiter) {
        const give = waiter;
        waiter = null;
        give(response);
      }
      /* A browser shows what the server sent; the fake has to as well, or the
         resolver is being tested against a page nobody serves. */
      html = (await response.text()) || html;
      return response;
    },
    waitForTimeout: async () => null,
    waitForSelector: async () => null,
    frames: () => [],
    mainFrame: () => ({ content: async () => '' }),
    locator: () => ({ first: () => ({ count: async () => 0, click: async () => null }) }),
    on: () => null,
    evaluate: (fn, arg) => {
      /* Serialised on purpose. `streamDownload` fetches with three workers, and
         a real browser runs them concurrently inside one JS context; a fake that
         swaps the global fetch must not interleave its swaps, or it leaves the
         process holding the browser's cookie and the next test proves nothing. */
      const answer = queue.then(async () => {
      if (cors) {
        /* What Chromium does with a cross-origin response that carries no
           `Access-Control-Allow-Origin`: the request happens, and the page is
           not allowed to see it. */
        const err = new TypeError('Failed to fetch');
        throw err;
      }
      const real = globalThis.fetch;
      globalThis.fetch = (target, options = {}) => {
        hits.push(String(target));
        if (deny && deny.test(String(target))) {
          return Promise.resolve({
            ok: false,
            status: 403,
            url: String(target),
            headers: { get: () => 'text/plain' },
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
          });
        }
        return real(String(target), {
          ...options,
          headers: { ...(options.headers || {}), cookie: COOKIE, 'x-browser': '1' },
        });
      };
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
  const context = {
    addInitScript: async () => null,
    cookies: async () => [{ name: 'sid', value: 'ok' }],
    newPage: async () => page,
  };
  return {
    chromium: {
      executablePath: () => process.execPath,
      launch: async () => ({ newContext: async () => context, close: async () => null }),
    },
  };
}

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

/* ------------------------------------------------------------------- the CDN */

const hits = [];
let mediaPort = 0;

function startCdn() {
  const gated = (req) => req.headers.cookie === COOKIE && req.headers['x-browser'] === '1';
  const sendMedia = (req, res, rest) => {
    const file = path.join(MEDIA_DIR, rest);
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size });
    return res.end(fs.readFileSync(file));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${mediaPort}`);
    hits.push(url.pathname);

    if (url.pathname === '/en/dandya-045') {
      const html = `<!doctype html><html><head>
        <title>DANDYA-045 a film - MissAV</title>
        <meta property="og:video" content="http://127.0.0.1:${mediaPort}/vast/preroll.mp4" />
      </head><body>
        <video src="http://127.0.0.1:${mediaPort}/vast/banner.mp4" autoplay muted></video>
        <script>
          jwplayer("player").setup({
            file: "http:\\/\\/127.0.0.1:${mediaPort}\\/cdn\\/master.m3u8"
          });
        </script>
      </body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    /* The advert: offered to the page, never the film. */
    if (url.pathname.startsWith('/vast/')) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4' });
      return res.end('nope');
    }

    /* A master is a menu; it is public, like the real one. */
    if (url.pathname === '/cdn/master.m3u8') {
      const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=600000,RESOLUTION=640x360,NAME="360p"
/cdn/lo/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2400000,RESOLUTION=1280x720,NAME="720p"
/cdn/hi/index.m3u8
`;
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(master);
    }

    /* Everything that is really the video is gated. */
    if (url.pathname.startsWith('/cdn/hi/') || url.pathname.startsWith('/cdn/lo/')) {
      if (!gated(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('forbidden');
      }
      const rest = url.pathname.replace(/^\/cdn\/(hi|lo)\//, '');
      return sendMedia(req, res, rest);
    }

    /* A stream that cannot be saved, and one that points at another playlist. */
    if (url.pathname === '/cdn/drm.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key"\n#EXTINF:2.0,\n/cdn/denied/s0.ts\n#EXT-X-ENDLIST\n',
      );
    }
    if (url.pathname === '/cdn/nested.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXTINF:2.0,\n/cdn/hi/index.m3u8\n#EXT-X-ENDLIST\n');
    }
    if (url.pathname === '/cdn/denied.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2.0,\n/deny/s0.ts\n#EXT-X-ENDLIST\n');
    }
    if (url.pathname.startsWith('/deny/')) {
      /* Refused even to the browser: a dead piece, the way a truncated upload
         to the CDN looks. */
      res.writeHead(403);
      return res.end();
    }

    res.writeHead(404);
    return res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      mediaPort = server.address().port;
      resolve(server);
    });
  });
}

/* --------------------------------------------------------------------- setup */

(async () => {
  console.log('browser stream (CDN refuses Node, serves the browser)');
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true });
  await fsp.rm(OUT_DIR, { recursive: true, force: true });
  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  /* Real media, encrypted the way a CDN encrypts it: AES-128 with a key file,
     so the fetched key is genuinely needed to make a file. */
  console.log('building a real, encrypted stream');
  const keyPath = path.join(MEDIA_DIR, 'key.bin');
  await fsp.writeFile(keyPath, Buffer.from('0123456789abcdef'));
  const keyInfo = path.join(MEDIA_DIR, 'key.info');
  await fsp.writeFile(keyInfo, `${keyPath}\n${keyPath}\n0123456789abcdef0123456789abcdef\n`);
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    /* A keyframe every 2 s, or hls cuts one 6-second segment and the test has
       nothing to download piece by piece. */
    '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_key_info_file', keyInfo,
    '-hls_segment_filename', path.join(MEDIA_DIR, 's%d.ts'),
    path.join(MEDIA_DIR, 'index.m3u8'),
  ]);
  /* The gated playlist names its key relatively, like the real one. */
  /* ffmpeg writes the key's absolute path; a CDN writes a path relative to the
     playlist, and the code under test resolves it exactly that way. */
  const playlistPath = path.join(MEDIA_DIR, 'index.m3u8');
  const playlist = (await fsp.readFile(playlistPath, 'utf8')).replace(/URI="[^"]*key\.bin"/, 'URI="key.bin"');
  await fsp.writeFile(playlistPath, playlist);
  assert.match(playlist, /#EXT-X-KEY:METHOD=AES-128,URI="key\.bin"/);
  assert.ok((playlist.match(/#EXTINF/g) || []).length >= 2, 'the fixture needs several segments');

  const server = await startCdn();
  const base = `http://127.0.0.1:${mediaPort}`;
  const runDir = path.join(OUT_DIR, 'parts');

  /* ---------------------------------------------------------------- the report
     First, prove the fixture behaves like the field: the same URL is refused to
     Node and served to a browser. Without this the rest of the file tests
     nothing. */
  const plain = await fetch(`${base}/cdn/hi/index.m3u8`).catch((err) => ({ status: 0, err }));
  assert.strictEqual(plain.status, 403, 'the fixture must refuse a plain request');

  const fake = makeFakePlaywright({ hits });
  const { helper, restore } = withFakePlaywright(fake);

  await test('a real browser is served the very URL Node is refused', async () => {
    const answer = await helper.fetchInBrowser(`${base}/en/dandya-045`, `${base}/cdn/hi/index.m3u8`);
    assert.strictEqual(answer.status, 200, `status ${answer.status}`);
    assert.match(answer.text, /#EXTM3U/);
    assert.match(answer.cookie, /sid=ok/);
    const counted = await helper.probeInBrowser(null, `${base}/cdn/hi/index.m3u8`);
    assert.strictEqual(counted.status, 200);
    assert.ok(counted.bytes > 0, 'the byte count must be real');
  });

  /* ------------------------------------------------------- the download itself */
  let downloaded = null;
  const progress = [];

  await test('the stream is fetched by the browser, best quality first', async () => {
    hits.length = 0;
    downloaded = await helper.streamDownload(`${base}/en/dandya-045`, `${base}/cdn/master.m3u8`, {
      destDir: runDir,
      onProgress: (value) => progress.push(value),
    });
    assert.strictEqual(downloaded.segments, 3, `segments ${downloaded.segments}`);
    /* Only the 720p rendition is touched: a master is a menu, not a download. */
    assert.ok(hits.some((hit) => hit.includes('/cdn/hi/')), 'the best variant was not fetched');
    assert.ok(!hits.some((hit) => hit.includes('/cdn/lo/')), 'a lesser variant was fetched too');
    /* The page was opened first — that is what earns the session. */
    assert.ok(hits.some((hit) => hit.includes('/en/dandya-045')), `the page was never opened (${hits.slice(0, 4).join(', ')})`);
  });

  await test('a CDN that sends no CORS headers is read by navigation instead', async () => {
    /* Same fixture, different refusal: the page is not allowed to *see* the
       response, which is a TypeError in JS and no HTTP status at all. The
       download must still happen — a top-level navigation is not CORS-checked. */
    const corsHits = [];
    const cors = withFakePlaywright(makeFakePlaywright({ hits: corsHits, cors: true }));
    try {
      const dir = path.join(OUT_DIR, 'cors');
      const got = await cors.helper.streamDownload(`${base}/en/dandya-045`, `${base}/cdn/master.m3u8`, {
        destDir: dir,
      });
      assert.strictEqual(got.segments, 3, `segments ${got.segments}`);
      assert.ok(corsHits.some((hit) => hit.includes('/cdn/hi/s0.ts')), 'the pieces were never navigated to');
      /* The resolver's read has the same two ways in, because a pasted playlist
         goes through it, not through the download. */
      const peek = await cors.helper.fetchInBrowser(`${base}/en/dandya-045`, `${base}/cdn/hi/index.m3u8`);
      assert.strictEqual(peek.status, 200, `status ${peek.status}`);
      assert.match(peek.text, /#EXTM3U/);
      const out = path.join(OUT_DIR, 'cors.mp4');
      await require('../server/sources').remuxLocalPlaylist(path.join(dir, 'local.m3u8'), out);
      const info = await probe(out);
      assert.strictEqual(info.height, 720, `height ${info.height}`);
      assert.ok(Math.abs((info.duration || 0) - 6) < 1.5, `duration ${info.duration}`);
    } finally {
      cors.restore();
    }
  });

  await test('every piece lands on disk, and the playlist points only at them', async () => {
    assert.ok(downloaded.bytes > 0, 'nothing was written');
    const names = await fsp.readdir(runDir);
    for (const name of ['piece-00000.ts', 'piece-00001.ts', 'piece-00002.ts', 'key.bin', 'local.m3u8']) {
      assert.ok(names.includes(name), `missing ${name} (have ${names.join(', ')})`);
    }
    const local = await fsp.readFile(path.join(runDir, 'local.m3u8'), 'utf8');
    assert.ok(!/https?:/i.test(local), `the local playlist still points at the network:\n${local}`);
    assert.match(local, /#EXT-X-KEY:METHOD=AES-128,URI="key\.bin"/);
    assert.match(local, /piece-00002\.ts/);
    assert.ok(progress.length > 0, 'progress was never reported');
    assert.ok(progress.some((value) => value.seconds > 0), 'progress never moved');
  });

  await test('the local pieces remux into one playable MP4', async () => {
    const out = path.join(OUT_DIR, 'film.mp4');
    const result = await require('../server/sources').remuxLocalPlaylist(path.join(runDir, 'local.m3u8'), out);
    assert.ok(fs.existsSync(out), 'no file was made');
    assert.strictEqual(result.bytes, fs.statSync(out).size);
    const info = await probe(out);
    assert.ok(info.videoCodec, 'the file has no video stream');
    assert.ok(Math.abs((info.duration || 0) - 6) < 1.5, `duration ${info.duration}`);
    assert.strictEqual(info.height, 720, `height ${info.height}`);
  });

  /* -------------------------------------------------------------- dead ends */
  await test('a piece refused even by the browser is named, not glossed over', async () => {
    const deniedHits = [];
    const denied = withFakePlaywright(makeFakePlaywright({ hits: deniedHits, deny: /\/deny\// }));
    try {
      await assert.rejects(
        () => denied.helper.streamDownload(null, `${base}/cdn/denied.m3u8`, { destDir: path.join(OUT_DIR, 'denied') }),
        (err) => err.code === 'STREAM_FORBIDDEN' && /refused a piece/i.test(err.message),
      );
    } finally {
      denied.restore();
    }
  });

  await test('a DRM stream is reported, never saved broken', async () => {
    await assert.rejects(
      () => helper.streamDownload(null, `${base}/cdn/drm.m3u8`, { destDir: path.join(OUT_DIR, 'drm') }),
      (err) => err.code === 'STREAM_DRM',
    );
  });

  await test('a playlist of playlists is refused rather than guessed at', async () => {
    await assert.rejects(
      () => helper.streamDownload(null, `${base}/cdn/nested.m3u8`, { destDir: path.join(OUT_DIR, 'nested') }),
      (err) => err.code === 'STREAM_NESTED',
    );
  });

  /* ---------------------------------------------------------------- the doctor
     The doctor is the first thing anyone runs when a link fails, and it has
     been wrong about its own machine before. Its new step must actually fire:
     the same piece, refused here and served there, is a verdict — not a guess. */
  await test('the doctor names a refused client as the cause', async () => {
    require('../server/browserhooks').install();
    const { diagnose } = require('../server/diagnose');
    const report = await diagnose(`${base}/en/dandya-045`);
    assert.match(report.text, /browserSeg HTTP 200/, report.text);
    assert.match(report.text, /VERDICT\s+Decisive/, report.text);
    assert.match(report.text, /refusing the \*client\*/);
  });

  restore();

  /* ------------------------------------------------------------ the resolver
     The user's other half of the report: pasting the surrit playlist URL was
     refused before any job could start. With the browser wired in, the same
     paste resolves. */
  await test('a pasted playlist Node cannot read still resolves through the browser', async () => {
    const { resolve, setStreamBrowser, clearStreamCache } = require('../shared/resolve');
    setStreamBrowser(null);
    clearStreamCache();
    await assert.rejects(
      () => resolve(`${base}/cdn/master.m3u8`),
      (err) => err.code === 'STREAM_FORBIDDEN',
      'without a browser the gated variant must be a dead end — that is the bug being fixed',
    );
    setStreamBrowser((pageUrl, url) => helper.fetchInBrowser(pageUrl, url, { want: 'text' }));
    try {
      clearStreamCache();
      const result = await resolve(`${base}/cdn/master.m3u8`);
      assert.strictEqual(result.files.length, 1, `files ${result.files.length}`);
      assert.strictEqual(result.files[0].quality, '720p', `quality ${result.files[0].quality}`);
      assert.ok(result.files[0].ref.duration > 5, `duration ${result.files[0].ref.duration}`);
    } finally {
      setStreamBrowser(null);
      clearStreamCache();
    }
  });

  server.close();
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
