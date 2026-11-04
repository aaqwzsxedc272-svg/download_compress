#!/usr/bin/env node
/**
 * A link that takes longer to read than a request is allowed to live.
 *
 * The report was `Request failed (504)`. It was not a refusal and not a bug in
 * the resolver: `POST /api/jobs` read the whole page — a browser launch, a bot
 * check, a player that has to be allowed to run — *before* it created anything.
 * The host's proxy gave up at sixty seconds and answered the browser with a
 * gateway timeout, so the page showed an error, and the job appeared a minute
 * later from underneath a request that had already failed. The person saw a
 * failed request and a card, and neither told the truth.
 *
 * Now the job exists after a few seconds either way. This test runs a real
 * server against a fixture page that answers slowly, and checks:
 *
 *   - the fast path is untouched (a quick page still resolves before the answer),
 *   - a slow page answers 202 "still reading" instead of hanging,
 *   - the job endpoint answers in seconds, with a card whose stage says what is
 *     happening, and finishes the whole job on its own,
 *   - the page is not read twice: the picker's read is the one the job uses.
 *
 *   npm run test:slowlink
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
const PORT = 3266;
const MEDIA_PORT = 3267;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-slow-data-${process.pid}`);
const MEDIA_DIR = path.join(os.tmpdir(), `squeeze-slow-media-${process.pid}`);

/* Long enough to be a browser's worth of work, short enough for a test. The
   server is told to wait 400 ms for an answer; this page takes 1.5 s. */
const SLOW_MS = 1500;
const WAIT_MS = 400;

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : '  FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 180000, intervalMs = 200 } = {}) {
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

function startServer({ keep = false } = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
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
      RESOLVE_WAIT_MS: String(WAIT_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  proc.on('exit', (code) => {
    if (code && code !== 0 && !proc.expected) {
      console.error(`server exited with ${code}: ${stderr.slice(-2000)}`);
      process.exit(1);
    }
  });
  if (keep) proc.keep = true;
  proc.log = () => stderr;
  return proc;
}

const ready = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });
const getJob = async (id) => (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;

const hits = [];
let slowReads = 0;

function startFixture() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MEDIA_PORT}`);
    hits.push(url.pathname);

    if (url.pathname === '/fast' || url.pathname === '/slow') {
      /* Only a real read of the page is slow. A HEAD is a ping, and the server
         sends one to see whether the link is a page at all. */
      if (url.pathname === '/slow' && req.method === 'GET') {
        slowReads += 1;
        await sleep(SLOW_MS);
      }
      const html = `<!doctype html><html><head><title>${url.pathname === '/slow' ? 'SLOW-001 a film' : 'FAST-001 a film'}</title>
        </head><body><video src="http://127.0.0.1:${MEDIA_PORT}/media/clip.mp4"></video></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/media/clip.mp4') {
      const file = path.join(MEDIA_DIR, 'clip.mp4');
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      const stat = fs.statSync(file);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(stat.size) });
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(MEDIA_PORT, '127.0.0.1', () => resolve(server)));
}

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  console.log('building a small video for the fixture page');
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '96k',
    path.join(MEDIA_DIR, 'clip.mp4'),
  ]);

  const fixture = await startFixture();
  const proc = startServer();
  try {
    await ready();

    /* --------------------------------------------------------- 1. the fast path
       A page that answers quickly must still be resolved before the response:
       the picker's behaviour (one file, its real size, its name) depends on it. */
    const fastStarted = Date.now();
    const fast = await (
      await fetch(`${BASE}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${MEDIA_PORT}/fast` }),
      })
    ).json();
    const fastMs = Date.now() - fastStarted;
    check('a quick page still resolves inside the request', Boolean(fast.files && fast.files.length), `${fastMs} ms`);
    check('and is not marked pending', !fast.pending, String(fast.pending));
    /* A page that points at a whole file names it by the file, not the page:
       the page title belongs on the card as the source's tab, not as the name. */
    check('with its real name', /\.mp4$/.test(fast.files?.[0]?.name || ''), fast.files?.[0]?.name);
    check('and the page title kept for the card', /FAST-001/.test(fast.pageTitle || ''), fast.pageTitle);

    /* The same on the job endpoint: a quick link is resolved before the answer,
       so the card is complete the moment it appears. */
    const fastJob = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'url', url: `http://127.0.0.1:${MEDIA_PORT}/fast`, presetId: 'small' }),
      })
    ).json();
    check(
      'a quick link starts a job that already knows its file',
      /\.mp4$/.test(fastJob.job?.name || '') && fastJob.job?.resolver,
      `${fastJob.job?.name} · ${fastJob.job?.resolver}`,
    );
    check('and is not marked as still reading', fastJob.job?.resolving === false, String(fastJob.job?.resolving));
    check('with the page title on the card', /FAST-001/.test(fastJob.job?.sourceTitle || ''), fastJob.job?.sourceTitle);

    /* --------------------------------------------------------- 2. the slow page
       The answer must arrive inside the deadline, saying what is happening. */
    const slowStarted = Date.now();
    const slow = await fetch(`${BASE}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${MEDIA_PORT}/slow` }),
    });
    const slowMs = Date.now() - slowStarted;
    const slowBody = await slow.json();
    check('a slow page answers instead of hanging', slow.status === 202, `HTTP ${slow.status}`);
    check('quickly — inside the deadline, not after the work', slowMs < SLOW_MS, `${slowMs} ms of ${SLOW_MS} ms`);
    check('and says it is still being read', slowBody.pending === true && /still being read/.test(slowBody.message || ''), slowBody.message);
    check('with a next step in the sentence', /Start it anyway/.test(slowBody.message || ''));

    /* The read that was already running is remembered: asking again (or
       pressing "start it anyway") must not pay for the page a second time. */
    await sleep(SLOW_MS + 400);
    const readsAfterFirst = slowReads;
    const againStarted = Date.now();
    const again = await fetch(`${BASE}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${MEDIA_PORT}/slow` }),
    });
    const againMs = Date.now() - againStarted;
    const againBody = await again.json();
    check('asking again answers from what was already read', again.status === 200, `HTTP ${again.status} in ${againMs} ms`);
    check('instantly, with the file list it now has', againMs < WAIT_MS && againBody.files?.length > 0, `${againMs} ms · ${againBody.files?.length} file(s)`);
    check('and does not read the page again', slowReads === readsAfterFirst, `${slowReads - readsAfterFirst} extra reads`);

    /* ------------------------------------------------------ 3. the job endpoint
       The one the report was about. It must answer in seconds and finish the
       job by itself, with a card that says it is reading the link. */
    const readsBefore = slowReads;
    const jobStarted = Date.now();
    const posted = await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: `http://127.0.0.1:${MEDIA_PORT}/slow`, presetId: 'small' }),
    });
    const jobMs = Date.now() - jobStarted;
    const started = await posted.json().catch(() => ({}));
    check('the job endpoint answers while the page is still being read', posted.status === 201, `HTTP ${posted.status} in ${jobMs} ms`);
    check('in seconds, not in minutes', jobMs < SLOW_MS, `${jobMs} ms`);
    check('with a card that says what it is doing', /Reading the link/.test(started.job?.stage || ''), started.job?.stage);
    check('and no name invented for a file it has not found yet', !started.job?.name || /SLOW/.test(started.job.name), started.job?.name);

    const jobId = started.job?.id;
    const reading = await waitFor(async () => {
      const job = await getJob(jobId);
      return job && /Reading the link/.test(job.stage || '') ? job : null;
    }, { timeoutMs: 3000 });
    check('the card is genuinely in that state', Boolean(reading), reading?.stage || 'gone already');

    const finished = await waitFor(async () => {
      const job = await getJob(jobId);
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    }, { timeoutMs: 300000 });
    check('and the job finishes on its own', ['done', 'hosted'].includes(finished?.status), finished?.error || finished?.status);
    check(
      'carrying the page it came from and that page\'s tab title',
      /SLOW-001/.test(finished?.sourceTitle || '') && Boolean(finished?.name),
      `${finished?.name} from “${finished?.sourceTitle}”`,
    );
    check('marked as no longer resolving', finished?.resolving === false, String(finished?.resolving));

    const output = path.join(DATA_DIR, 'jobs', jobId, 'output.mp4');
    const info = fs.existsSync(output) ? await probe(output).catch(() => null) : null;
    check('with a real video at the end of it', Boolean(info && info.duration), info ? `${info.duration.toFixed(1)}s` : 'unreadable');

    /* The picker's read is the one the job uses. Two reads in total is the
       picker's own two passes (the resolver, then the file-behind-the-page
       check); a third would mean the job paid for the page again. */
    check(
      'the job reused the read the picker had already started',
      slowReads - readsBefore <= 1,
      `${slowReads - readsBefore} read(s) of the page for the job itself`,
    );

    /* ------------------------------------------------------- 3b. a bad link still fails fast */
    const badStarted = Date.now();
    const bad = await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: 'not-a-link' }),
    });
    check('a link that is not a link is still refused immediately', bad.status === 400, `HTTP ${bad.status} in ${Date.now() - badStarted} ms`);

    /* ------------------------------------------- 4. a restart mid-read is not a dead card
       Nothing has been fetched yet, so the cost of a restart here is one page
       read. What must not happen is a card left on "Reading the link" forever. */
    const killTarget = await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: `http://127.0.0.1:${MEDIA_PORT}/slow`, presetId: 'hq' }),
    }).then((res) => res.json());
    const killId = killTarget.job?.id;
    check('a second slow job gets its own card', Boolean(killId) && killId !== jobId, killId);
    /* Long enough for the card to be written to disk, well inside the read. */
    await sleep(700);
    proc.kill('SIGKILL');
    /* The port has to be free before the replacement can bind it. */
    const gone = await waitFor(
      async () => {
        try {
          await fetch(`${BASE}/api/health`);
          return null;
        } catch {
          return true;
        }
      },
      { timeoutMs: 15000, intervalMs: 100 },
    );
    check('the machine really went away', Boolean(gone));

    const second = startServer({ keep: true });
    const up = await ready();
    check('and the replacement comes up on the same data', Boolean(up));
    const revived = await waitFor(async () => {
      const job = await getJob(killId);
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    }, { timeoutMs: 60000 });
    check('the job left mid-read is picked up after the restart', ['done', 'hosted'].includes(revived?.status), revived?.error || revived?.status);
    check('and finishes with its video', Number(revived?.outputBytes) > 0, `${revived?.outputBytes} bytes`);
    if (!['done', 'hosted'].includes(revived?.status)) {
      console.log(`        [server log] ${second.log().slice(-800).replace(/\n/g, '\n        ')}`);
    }
    second.kill('SIGTERM');
    second.expected = true;
    await sleep(600);

  } finally {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    fixture.close();
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
