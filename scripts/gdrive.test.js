#!/usr/bin/env node
/**
 * A Google Drive link, all the way through the app.
 *
 * Drive is not a file host with a download button. `drive.google.com/file/d/…`
 * is a viewer page; the bytes are behind `uc?export=download&id=…`; and past
 * ~100 MB that endpoint answers with a **web page** carrying a `confirm` token
 * instead of the file. A downloader that saves what it is given saves a 12 KB
 * HTML "video", and one that does not read the form never gets the film at all.
 *
 * The fixture here answers exactly like Google: a viewer page with a title, a
 * `uc` form for the file, and a usercontent endpoint that only serves bytes when
 * the form's `confirm` comes back. The app is run for real, with a preloaded
 * `fetch` that points Drive's two hosts at this server — no production code is
 * changed to make the test possible.
 *
 *   npm run test:gdrive
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
const PORT = 3276;
const DRIVE_PORT = 3277;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-gdrive-data-${process.pid}`);
const MEDIA_DIR = path.join(os.tmpdir(), `squeeze-gdrive-media-${process.pid}`);
const PRELOAD = path.join(ROOT, 'scripts', 'fixtures', 'fake-gdrive.js');

const SHARED_ID = '1SharedFilmAbCdEfGhIjKl';
const PRIVATE_ID = '1PrivateFilmAbCdEfGhIjK';

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : '  FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 180000, intervalMs = 250 } = {}) {
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

function startServer() {
  const proc = spawn(process.execPath, ['--require', PRELOAD, path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      MAX_CONCURRENT: '1',
      AUTO_HOST: '0',
      HOSTERS: '',
      ALLOW_PRIVATE_HOSTS: '1',
      SQUEEZE_PROBE_SECONDS: '2',
      KEEP_LOCAL_AFTER_UPLOAD: '1',
      FAKE_DRIVE_PORT: String(DRIVE_PORT),
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

/* --------------------------------------------------------------- the fixture */

const hits = [];

function driveForm(id) {
  /* The real page: no file, a form whose hidden inputs are the download. */
  return `<!doctype html><html><head><title>Google Drive - Virus scan warning</title></head><body>
    <p>Google Drive can't scan this file for viruses.</p>
    <p>${id}.mp4 (2.4G) exceeds the maximum size that Google can scan.</p>
    <form id="download-form" action="http://127.0.0.1:${DRIVE_PORT}/usercontent/download" method="get">
      <input type="hidden" name="id" value="${id}">
      <input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t">
      <input type="hidden" name="uuid" value="7d1f0c22-1a44-4f0e-9a51-2c8f1d3b6e90">
    </form></body></html>`;
}

function startDrive() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${DRIVE_PORT}`);
    hits.push(`${req.method} ${url.pathname}${url.search}`);

    /* The viewer page: the file's real name lives in its <title>. */
    if (/^\/file\/d\/[^/]+\/view$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        `<html><head><title>${id === PRIVATE_ID ? 'Private Film' : 'Holiday Clip'}.mp4 - Google Drive</title></head>` +
          '<body><div>viewer</div></body></html>',
      );
    }

    /* The endpoint a downloader reaches first. For a big file: a page. */
    if (url.pathname === '/uc') {
      const id = url.searchParams.get('id') || '';
      if (id === PRIVATE_ID) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          '<html><body><p>You need access</p><a href="https://accounts.google.com/ServiceLogin">Sign in</a></body></html>',
        );
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(driveForm(id));
    }

    /* What the form submits to: bytes only when `confirm` came back. */
    if (url.pathname === '/usercontent/download') {
      if (url.searchParams.get('confirm') !== 't') {
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<html><body>confirm required</body></html>');
      }
      const file = path.join(MEDIA_DIR, 'clip.mp4');
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(stat.size),
        'content-disposition': 'attachment; filename="Holiday Clip.mp4"',
        'accept-ranges': 'bytes',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  });
  return new Promise((resolve) => server.listen(DRIVE_PORT, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- drive */

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  console.log('building the file Google is pretending to hold');
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-c:a', 'aac', '-b:a', '96k',
    path.join(MEDIA_DIR, 'clip.mp4'),
  ]);

  const drive = await startDrive();
  const proc = startServer();
  const link = `https://drive.google.com/file/d/${SHARED_ID}/view?usp=sharing`;

  try {
    await ready();

    /* ------------------------------------------------------------ 1. the link */
    const listed = await (
      await fetch(`${BASE}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: link }),
      })
    ).json();
    check('a Drive link resolves to one video', listed.files?.length === 1, JSON.stringify(listed.files?.map((f) => f.name)));
    check('named after the file, not the viewer page', listed.files?.[0]?.name === 'Holiday Clip.mp4', listed.files?.[0]?.name);
    check('with its size read from the confirmed download', Number(listed.files?.[0]?.size) > 100_000, `${listed.files?.[0]?.size} bytes`);

    /* ---------------------------------------------------------- 2. real job */
    const started = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'url', url: link, presetId: 'small' }),
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
    check('it finishes', ['done', 'hosted'].includes(finished?.status), finished?.error || finished?.status);
    check(
      "the source is the video, not the \"can't scan this file\" page",
      Number(finished?.sourceBytes) > 500_000,
      `${finished?.sourceBytes} bytes`,
    );
    check(
      'and the encoder made a smaller file out of it',
      Number(finished?.outputBytes) > 0 && Number(finished.outputBytes) < Number(finished.sourceBytes),
      `${finished?.outputBytes} vs ${finished?.sourceBytes}`,
    );

    const output = path.join(DATA_DIR, 'jobs', jobId, 'output.mp4');
    const info = fs.existsSync(output) ? await probe(output).catch(() => null) : null;
    check('the result is a real video', Boolean(info && info.duration), info ? `${info.duration.toFixed(1)}s` : 'unreadable');
    check('as long as the one in Drive', Boolean(info && Math.abs(info.duration - 5) < 1.5), info ? `${info.duration.toFixed(1)}s of 5s` : 'no duration');

    /* The proof that the form was read: the download only answers `confirm=t`. */
    check(
      'the form was read and submitted, not saved',
      hits.some((hit) => hit.includes('/usercontent/download') && hit.includes('confirm=t')),
      hits.filter((hit) => hit.includes('/usercontent')).slice(0, 2).join(' · ') || 'never requested',
    );
    check('and the viewer page was read for the name', hits.some((hit) => hit.includes(`/file/d/${SHARED_ID}/view`)));

    /* -------------------------------------------------------- 3. not shared */
    const privateListing = await fetch(`${BASE}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `https://drive.google.com/file/d/${PRIVATE_ID}/view` }),
    });
    const privateBody = await privateListing.json();
    check('a file nobody shared is refused before any job exists', privateListing.status === 422, `HTTP ${privateListing.status}`);
    check('with the one sentence that fixes it', /Anyone with the link/.test(privateBody.error || ''), privateBody.error);

    /* ------------------------------------------------------- 4. a folder link */
    const folder = await fetch(`${BASE}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://drive.google.com/drive/folders/1FolderAbCdEfGhIjKlMn' }),
    });
    const folderBody = await folder.json();
    check('a folder says what to do instead of guessing', folder.status === 422 && /paste each video/.test(folderBody.error || ''), folderBody.error);
  } finally {
    proc.kill('SIGTERM');
    drive.close();
    await sleep(400);
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
