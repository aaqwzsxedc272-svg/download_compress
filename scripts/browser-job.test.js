#!/usr/bin/env node
/**
 * The whole app, against a CDN that refuses it and serves the browser.
 *
 * `browser-stream.test.js` proves the parts; this proves they are wired into the
 * job a person actually starts. The page plays a real encrypted HLS stream on
 * `/cdn/`, which answers 403 to every request Node or ffmpeg makes — with the
 * page's cookie, referer and user agent — and 200 to the browser, because the
 * gate is a header only a browser sends. That is a fair model of the field
 * report (`missav.ws` → `surrit.com`, behind DDoS-Guard, refusing by TLS
 * fingerprint), and the app must still produce a video.
 *
 *   npm run test:browser:job
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { probe } = require('../server/ffmpeg');

const ROOT = path.join(__dirname, '..');
const PORT = 3256;
const MEDIA_PORT = 3257;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-bjob-data-${process.pid}`);
const MEDIA_DIR = path.join(os.tmpdir(), `squeeze-bjob-media-${process.pid}`);
const FAKE_BROWSER = path.join(ROOT, 'scripts', 'fixtures', 'fake-browser.js');
const COOKIE = 'sid=ok';

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : '  FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 180000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
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

function startServer(extraEnv = {}) {
  const proc = spawn(process.execPath, ['--require', FAKE_BROWSER, path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(PORT),
      DATA_DIR,
      MAX_CONCURRENT: '1',
      AUTO_HOST: '0',
      HOSTERS: '',
      ALLOW_PRIVATE_HOSTS: '1',
      SQUEEZE_PROBE_SECONDS: '2',
      KEEP_LOCAL_AFTER_UPLOAD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  proc.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`server exited with ${code}: ${stderr.slice(-2000)}`);
      process.exit(1);
    }
  });
  return proc;
}

const ready = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });
const getJob = async (id) => (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;

/* ------------------------------------------------------------------- the CDN */

const hits = [];
const adHits = [];

function startCdn() {
  const browserish = (req) => req.headers.cookie === COOKIE && req.headers['x-browser'] === '1';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MEDIA_PORT}`);
    hits.push(`${url.pathname}${browserish(req) ? ' [browser]' : ''}`);

    if (url.pathname === '/en/dandya-045') {
      const html = `<!doctype html><html><head>
        <title>DANDYA-045 some long title - MissAV</title>
        <meta property="og:video" content="http://127.0.0.1:${MEDIA_PORT}/vast/preroll.mp4" />
      </head><body>
        <video src="http://127.0.0.1:${MEDIA_PORT}/vast/banner.mp4" autoplay muted></video>
        <script>
          jwplayer("player").setup({
            file: "http:\\/\\/127.0.0.1:${MEDIA_PORT}\\/cdn\\/master.m3u8"
          });
        </script>
      </body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname.startsWith('/vast/')) {
      adHits.push(url.pathname);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4' });
      return res.end('nope');
    }

    if (url.pathname === '/cdn/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(
        '#EXTM3U\n#EXT-X-VERSION:3\n' +
          '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=600000,RESOLUTION=640x360,NAME="360p"\n/cdn/lo/index.m3u8\n' +
          '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2400000,RESOLUTION=1280x720,NAME="720p"\n/cdn/hi/index.m3u8\n',
      );
    }

    /* Everything that is really the video. The refusal is the point: a cookie
       and a referer are not enough, because the check is on the client. */
    if (url.pathname.startsWith('/cdn/hi/') || url.pathname.startsWith('/cdn/lo/')) {
      if (!browserish(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('forbidden');
      }
      const file = path.join(MEDIA_DIR, url.pathname.replace(/^\/cdn\/(hi|lo)\//, ''));
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      res.writeHead(200, { 'content-type': type, 'content-length': String(fs.statSync(file).size) });
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(MEDIA_PORT, '127.0.0.1', () => resolve(server));
  });
}

/* ---------------------------------------------------------------------- drive */

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  console.log('building a real, encrypted, gated stream');
  const keyPath = path.join(MEDIA_DIR, 'key.bin');
  await fsp.writeFile(keyPath, Buffer.from('0123456789abcdef'));
  const keyInfo = path.join(MEDIA_DIR, 'key.info');
  await fsp.writeFile(keyInfo, `${keyPath}\n${keyPath}\n0123456789abcdef0123456789abcdef\n`);
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_key_info_file', keyInfo,
    '-hls_segment_filename', path.join(MEDIA_DIR, 's%d.ts'),
    path.join(MEDIA_DIR, 'index.m3u8'),
  ]);
  const playlistPath = path.join(MEDIA_DIR, 'index.m3u8');
  await fsp.writeFile(
    playlistPath,
    (await fsp.readFile(playlistPath, 'utf8')).replace(/URI="[^"]*key\.bin"/, 'URI="key.bin"'),
  );

  const server = await startCdn();
  const pageUrl = `http://127.0.0.1:${MEDIA_PORT}/en/dandya-045`;
  const proc = startServer({
    FAKE_PW_PLAYLIST: `http://127.0.0.1:${MEDIA_PORT}/cdn/master.m3u8`,
    FAKE_PW_COOKIE: COOKIE,
    FAKE_PW_PAGE: pageUrl,
  });

  try {
    await ready();

    const started = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'url', url: pageUrl, presetId: 'small' }),
      })
    ).json();
    const jobId = started.job?.id;
    check('the job starts', Boolean(jobId), started.error || '');

    const finished = await waitFor(
      async () => {
        const job = await getJob(jobId);
        return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
      },
      { timeoutMs: 300000 },
    );

    check('it finishes instead of dying on a 403', ['done', 'hosted'].includes(finished?.status), finished?.error || finished?.status);
    check('it says the browser did the fetching', finished?.streamViaBrowser === true, String(finished?.streamViaBrowser));
    check(
      'the CDN really did refuse every non-browser request',
      hits.filter((hit) => hit.startsWith('/cdn/') && !hit.includes('[browser]')).length > 0,
      hits.filter((hit) => hit.startsWith('/cdn/')).slice(0, 4).join(', '),
    );
    check(
      'and the segments arrived through the browser',
      hits.filter((hit) => hit.startsWith('/cdn/hi/') && hit.includes('[browser]')).length >= 3,
      hits.filter((hit) => hit.startsWith('/cdn/hi/')).slice(0, 6).join(', '),
    );
    check('the advert was never fetched', adHits.length === 0, adHits.join(', ') || '0 requests');
    check(
      'the 720p rendition was taken and the 360p one was not',
      hits.some((hit) => hit.startsWith('/cdn/hi/')) && !hits.some((hit) => hit.startsWith('/cdn/lo/')),
      hits.filter((hit) => hit.startsWith('/cdn/')).slice(0, 4).join(', '),
    );
    check(
      'the source was assembled from the pieces, not saved as a playlist',
      Number(finished?.sourceBytes) > 100_000,
      `${finished?.sourceBytes} bytes`,
    );
    check(
      'and the encoder made a smaller video out of it',
      Number(finished?.outputBytes) > 0 && Number(finished.outputBytes) < Number(finished.sourceBytes),
      `${finished?.outputBytes} vs ${finished?.sourceBytes}`,
    );

    const outputPath = path.join(DATA_DIR, 'jobs', jobId, 'output.mp4');
    const info = fs.existsSync(outputPath) ? await probe(outputPath).catch(() => null) : null;
    check('the result is a real video', Boolean(info && info.duration), info ? `${info.duration.toFixed(1)}s` : 'unreadable');
    check('as long as the stream it came from', Boolean(info && Math.abs(info.duration - 6) < 1.5), info ? `${info.duration.toFixed(1)}s of 6s` : 'no duration');
    check('at the quality the card promised', info?.height === 720, String(info?.height));

    /* Nothing in `data/` may still hold the parts: gigabytes of pieces left
       behind is how the disk fills up without anybody noticing. */
    const leftovers = [];
    const walk = async (dir) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/piece-\d+|local\.m3u8/.test(entry.name)) leftovers.push(full);
      }
    };
    await walk(DATA_DIR);
    check('the pieces are cleaned up afterwards', leftovers.length === 0, leftovers.join(', '));
  } finally {
    proc.kill('SIGTERM');
    server.close();
    await sleep(500);
    await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
