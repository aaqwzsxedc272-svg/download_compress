#!/usr/bin/env node
/**
 * A page whose video is an HLS stream, end to end.
 *
 * This is the missav.ws shape: the page is on one site, the video is a playlist
 * on a CDN, and the only .mp4 sitting in the page belongs to an advert. Pasting
 * that page used to resolve to the advert, because a playlist is not a file and
 * was filtered out before anything looked at it.
 *
 * Here a real server serves a real page, a real master playlist and real
 * segments cut by ffmpeg from a real clip. The test then does what a person
 * does — paste the page and walk away — and checks the whole chain:
 *
 *   - the advert is never downloaded (not even once),
 *   - the best quality on offer is the one that is fetched,
 *   - the video ends up as one finished MP4 with a share of its own,
 *   - a pasted playlist URL works by itself too.
 *
 *   npm run test:stream
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
const PORT = 3244;
const MEDIA_PORT = 3245;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-stream-${Date.now()}`);
const MEDIA_DIR = path.join(os.tmpdir(), `squeeze-stream-media-${Date.now()}`);

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
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(PORT),
      DATA_DIR,
      MAX_CONCURRENT: '1',
      /* Nothing to upload to: the point here is the video, not a share host. */
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
      console.error(`server exited with ${code}: ${stderr.slice(-1500)}`);
      process.exit(1);
    }
  });
  return proc;
}

const ready = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });
const getJob = async (id) => (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  /* ---------------------------------------------------------------- the media
     A 6-second clip at two qualities, cut into HLS the way a real host does it:
     MPEG-TS segments plus a media playlist, behind a master that names both. */
  console.log('building a real stream');
  const clip720 = path.join(MEDIA_DIR, 'src-720.mp4');
  const clip360 = path.join(MEDIA_DIR, 'src-360.mp4');
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-c:a', 'aac', '-b:a', '96k',
    clip720,
  ]);
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-c:a', 'aac', '-b:a', '64k',
    clip360,
  ]);

  for (const [label, source] of [['720p', clip720], ['360p', clip360]]) {
    const dir = path.join(MEDIA_DIR, 'stream', label);
    await fsp.mkdir(dir, { recursive: true });
    await run([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', source,
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '0',
      '-hls_segment_filename', path.join(dir, 'seg%d.ts'),
      path.join(dir, 'video.m3u8'),
    ]);
  }

  const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=600000,RESOLUTION=640x360,NAME="360p"
360p/video.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2400000,RESOLUTION=1280x720,NAME="720p"
720p/video.m3u8
`;
  await fsp.writeFile(path.join(MEDIA_DIR, 'stream', 'playlist.m3u8'), master);

  /* The advert: a file that exists, is offered to the page, and must never be
     fetched. Counting hits is the only honest way to prove that. */
  const adHits = [];
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MEDIA_PORT}`);
    hits.push(url.pathname);

    if (url.pathname === '/en/dandya-045') {
      const html = `<!doctype html><html><head>
        <title>DANDYA-045 some long title - MissAV</title>
        <meta property="og:video" content="http://127.0.0.1:${MEDIA_PORT}/vast/preroll.mp4" />
      </head><body>
        <video src="http://127.0.0.1:${MEDIA_PORT}/vast/banner.mp4" autoplay muted></video>
        <script>
          jwplayer("player").setup({
            file: "http:\\/\\/127.0.0.1:${MEDIA_PORT}\\/stream\\/playlist.m3u8"
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

    /* A CDN that only serves its segments to the site that embeds them — the
       shape of the refusal the report was about ("the video server refused the
       request (it wants the page it belongs to as the referer)"). Everything
       under /locked/ answers 403 unless the Referer names this host. */
    if (url.pathname.startsWith('/locked/')) {
      const referer = req.headers.referer || '';
      if (!referer.startsWith(`http://127.0.0.1:${MEDIA_PORT}`)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('referer required');
      }
      const file = path.join(MEDIA_DIR, url.pathname.replace('/locked/', 'stream/'));
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      res.writeHead(200, { 'content-type': type, 'content-length': String(fs.statSync(file).size) });
      return fs.createReadStream(file).pipe(res);
    }

    if (url.pathname.startsWith('/stream/')) {
      const file = path.join(MEDIA_DIR, url.pathname.replace('/stream/', 'stream/'));
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      res.writeHead(200, { 'content-type': type, 'content-length': String(fs.statSync(file).size) });
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(MEDIA_PORT, '127.0.0.1', resolve));

  const pageUrl = `http://127.0.0.1:${MEDIA_PORT}/en/dandya-045`;
  const streamUrl = `http://127.0.0.1:${MEDIA_PORT}/stream/playlist.m3u8`;

  let proc = startServer();
  try {
    await ready();

    /* ------------------------------------------------------------ 1. the page */
    const listed = await (await fetch(`${BASE}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: pageUrl }),
    })).json();

    check('the page lists exactly one video', listed.files?.length === 1, JSON.stringify(listed.files?.map((f) => f.name)));
    check(
      'and it is the stream, not the advert',
      listed.resolver === 'stream' && /playlist\.m3u8$/.test(listed.files?.[0]?.ref?.url || ''),
      `${listed.resolver} ${listed.files?.[0]?.ref?.url || listed.error}`,
    );
    check(
      'the stream is weighed and labelled before anything is downloaded',
      Boolean(listed.files?.[0]?.size) && listed.files?.[0]?.quality === '720p',
      `${listed.files?.[0]?.size} bytes, ${listed.files?.[0]?.quality}`,
    );
    check(
      'the page title becomes the file name',
      /^DANDYA-045/.test(listed.files?.[0]?.name || ''),
      listed.files?.[0]?.name,
    );

    /* ------------------------------------------------------- 2. a real job */
    const started = await (await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: pageUrl, presetId: 'small' }),
    })).json();
    const jobId = started.job?.id;
    check('the job starts', Boolean(jobId), started.error || '');

    const downloading = await waitFor(async () => {
      const job = await getJob(jobId);
      return job && job.status === 'fetching' ? job : null;
    }, { timeoutMs: 60000 });
    check('it reaches the download stage', Boolean(downloading), downloading?.stage || started.error || 'never started');

    const finished = await waitFor(async () => {
      const job = await getJob(jobId);
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    }, { timeoutMs: 300000 });
    check('it finishes', ['done', 'hosted'].includes(finished?.status), finished?.error || finished?.status);

    check(
      'the advert was never downloaded',
      adHits.length === 0,
      adHits.length ? `fetched ${adHits.join(', ')}` : '0 requests',
    );
    check(
      'the 720p variant was fetched and the 360p one was not',
      hits.some((hit) => hit.startsWith('/stream/720p/')) && !hits.some((hit) => hit.startsWith('/stream/360p/')),
      hits.filter((hit) => hit.startsWith('/stream/')).slice(0, 3).join(', '),
    );
    check(
      'the segments came down as a file rather than a playlist',
      Boolean(finished?.sourceBytes) && finished.sourceBytes > 100_000,
      `${finished?.sourceBytes} bytes`,
    );
    check(
      'and the encoder made a smaller video out of it',
      Boolean(finished?.outputBytes) && finished.outputBytes < finished.sourceBytes,
      `${finished?.outputBytes} vs ${finished?.sourceBytes}`,
    );
    check(
      'the finished file is named after the page, not "playlist.m3u8"',
      /^DANDYA-045/.test(finished?.outputName || finished?.name || ''),
      finished?.outputName || finished?.name,
    );

    const outputPath = path.join(DATA_DIR, 'jobs', jobId, 'output.mp4');
    const info = fs.existsSync(outputPath) ? await probe(outputPath).catch(() => null) : null;
    check('the result is a real video', Boolean(info && info.duration), info ? `${info.duration}s` : 'unreadable');
    check(
      'as long as the stream it came from',
      Boolean(info && Math.abs(info.duration - 6) < 1),
      info ? `${info.duration.toFixed(1)}s of 6s` : 'no duration',
    );
    check('with its audio', Boolean(info && info.hasAudio), info ? info.audioCodec : '');
    check(
      'and at 720p, the best quality the host offered',
      Boolean(info && info.height >= 700),
      info ? `${info.width}x${info.height}` : 'unknown',
    );

    /* ------------------------------------- 3. picked from the page's file list
       This is the path the page itself uses: /api/resolve lists the stream, the
       picker posts its ref back as source: 'ref'. A resolver that is missing
       from the server's allow-list answers "That file reference is not valid." */
    const picked = await (await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'ref',
        ref: listed.files[0].ref,
        name: listed.files[0].name,
        presetId: 'small',
      }),
    })).json();
    check('the stream can be queued from the picker, by its reference', Boolean(picked.job?.id), picked.error || '');
    const pickedDone = await waitFor(async () => {
      const job = picked.job?.id ? await getJob(picked.job.id) : null;
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    }, { timeoutMs: 300000 });
    check('and it finishes like any other job', ['done', 'hosted'].includes(pickedDone?.status), pickedDone?.error || pickedDone?.status);

    /* -------------------------------------------- 4. the playlist on its own */
    const direct = await (await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: streamUrl, presetId: 'small' }),
    })).json();
    check('a pasted .m3u8 link is accepted instead of refused', Boolean(direct.job?.id), direct.error || '');
    check(
      'and it is named after its host and quality',
      /^127-720p\.mp4$/.test(direct.job?.name || ''),
      direct.job?.name,
    );

    const second = await waitFor(async () => {
      const job = await getJob(direct.job.id);
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    }, { timeoutMs: 300000 });
    check('it finishes too', ['done', 'hosted'].includes(second?.status), second?.error || second?.status);
    check(
      'with a video of its own',
      Boolean(second?.outputBytes) && second.outputBytes > 0,
      `${second?.outputBytes} bytes`,
    );

    /* ------------------------------------ 5. a CDN that demands a referer
       The report: pasting the stream link alone answered "the video server
       refused the request (it wants the page it belongs to as the referer)".
       A bare stream has no page, so the plausible referer is tried instead of
       giving up on the first 403 — and whatever is accepted is sent to the
       segments as well, because they are guarded the same way. */
    const lockedUrl = `http://127.0.0.1:${MEDIA_PORT}/locked/playlist.m3u8`;
    const lockedList = await (await fetch(`${BASE}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: lockedUrl }),
    })).json();
    check(
      'a stream that refuses a plain request is still read',
      Boolean(lockedList.files?.length),
      lockedList.error || `${lockedList.files?.length} files`,
    );
    const lockedJob = await (await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: lockedUrl, presetId: 'small' }),
    })).json();
    check('and can be queued on its own', Boolean(lockedJob.job?.id), lockedJob.error || '');
    const lockedDone = await waitFor(async () => {
      const job = lockedJob.job?.id ? await getJob(lockedJob.job.id) : null;
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    }, { timeoutMs: 300000 });
    check(
      'the segments come down too, with the header that was accepted',
      ['done', 'hosted'].includes(lockedDone?.status),
      lockedDone?.error || lockedDone?.status,
    );
    check(
      'and it is a video, not an empty file',
      Boolean(lockedDone?.outputBytes) && lockedDone.outputBytes > 0,
      `${lockedDone?.outputBytes} bytes`,
    );
  } finally {
    if (proc) proc.kill('SIGKILL');
    server.close();
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('stream run crashed:', err);
  process.exit(1);
});
