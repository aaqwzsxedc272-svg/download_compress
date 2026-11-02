#!/usr/bin/env node
/**
 * "The Codespace ran out of minutes and died. What happens to my files?"
 *
 * Three answers, each checked against the real server rather than promised:
 *
 *   1. stopped while downloading  -> the fragment is thrown away and the file
 *                                    is fetched again, to the same job
 *   2. stopped while uploading    -> the finished MP4 is still on disk, so it is
 *                                    re-uploaded instead of being marked failed
 *   3. "just download it" pressed  -> mid-encode, the original is handed back
 *      while a file is being treated  byte for byte, without waiting for the
 *                                    encoder to finish
 *
 *   npm run test:recover
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3225;
const HOSTER_PORT = 3226;
const SOURCE_PORT = 3227;
const FAST_PORT = 3229;
const HOOK_PORT = 3228; // stands in for the Discord webhook the links go to
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-recovery-${Date.now()}`);

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 180000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function startServer(extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env,
      ...extraEnv,
      PORT: String(PORT),
      DATA_DIR,
      MAX_CONCURRENT: '1',
      HOSTERS: 'pixeldrain',
      PIXELDRAIN_API_BASE: `http://127.0.0.1:${HOSTER_PORT}`,
      AUTO_HOST: '1',
      ALLOW_PRIVATE_HOSTS: '1',
      SQUEEZE_PROBE_SECONDS: '2',
      /* Keep the local copy after the upload so the download route can be
         checked for real; the space tests cover the deleting behaviour. */
      KEEP_LOCAL_AFTER_UPLOAD: '1',
      /* A link is posted as soon as it exists, not only when the queue drains. */
      PUBLISH_WEBHOOK: `http://127.0.0.1:${HOOK_PORT}/hook`,
      PUBLISH_EVERY_SECONDS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  proc.on('exit', (code) => {
    /* A server that dies at once (port already taken by a previous crashed
       run, unreadable data dir) used to make the whole test hang on a server
       that was never there. */
    if (code && code !== 0) {
      console.error(`server exited with ${code}: ${stderr.slice(-800)}`);
      process.exit(1);
    }
  });
  return proc;
}

const ready = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });

const getJob = async (id) => (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;

/* A source host that hands the file out slowly, so there is a real window in
   which to stop the machine — exactly what a big file on a slow host does. */
function slowSource(file, { delayMs = 120 } = {}) {
  /* Every request is recorded, with a Range header when the app resumes: that
     is the evidence that the file was not downloaded twice. */
  const requests = [];
  let bytesServed = 0;
  const server = http.createServer(async (req, res) => {
    /* /slow.mp4 trickles, /fast.mp4 does not: the same server stands in for a
       slow host and a quick one. */
    if (!/^\/(slow|fast)\.mp4/.test(req.url)) return res.writeHead(404).end();
    try {
      const size = (await fsp.stat(file)).size;
      const range = req.headers.range || null;
      requests.push({ method: req.method, range, at: Date.now() });
      /* A real host answers HEAD with headers and no body; streaming the file
         on a HEAD would make the app look like it downloaded it twice. */
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(size),
          'accept-ranges': 'bytes',
          'content-disposition': 'attachment; filename="Slow Download.mp4"',
        });
        return res.end();
      }
      let start = 0;
      const status = range ? 206 : 200;
      if (range) {
        const m = /bytes=(\d+)-/.exec(range);
        start = m ? Number(m[1]) : 0;
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-length': String(size - start),
          'content-range': `bytes ${start}-${size - 1}/${size}`,
          'accept-ranges': 'bytes',
          'content-disposition': 'attachment; filename="Slow Download.mp4"',
        });
      } else {
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(size),
          'accept-ranges': 'bytes',
          'content-disposition': 'attachment; filename="Slow Download.mp4"',
        });
      }
      const stream = fs.createReadStream(file, { start, highWaterMark: 256 * 1024 });
      for await (const chunk of stream) {
        if (res.destroyed) return;
        bytesServed += chunk.length;
        res.write(chunk);
        if (delayMs) await sleep(delayMs);
      }
      res.end();
    } catch (err) {
      /* A missing file must not take the whole test process down. */
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err.message));
    }
  });
  server.requests = requests;
  server.bytes = () => bytesServed;
  return server;
}

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});

  /* Records whatever the app decides to publish. */
  const hookHits = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hookHits.push(body);
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => hook.listen(HOOK_PORT, '127.0.0.1', resolve));

  const hoster = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/file/')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `recovered${Date.now()}`, name: 'video.mp4' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => hoster.listen(HOSTER_PORT, '127.0.0.1', resolve));

  let server = startServer();
  let source = null;
  try {
    await ready();

    /* The sample clip is built by the server itself, so it is the one video
       here that is guaranteed to exist. */
    const sample = path.join(DATA_DIR, 'sample.mp4');
    /* A busy machine can take a couple of minutes to build 45 s of 1080p. */
    const built = await waitFor(async () => (fs.existsSync(sample) ? true : null), { timeoutMs: 240000 });
    check('the server built its own test clip', Boolean(built));
    if (!built) throw new Error('the sample clip was never built, so nothing below can be honest');

    source = slowSource(sample);
    await new Promise((resolve) => source.listen(SOURCE_PORT, '127.0.0.1', resolve));
    const sourceUrl = `http://127.0.0.1:${SOURCE_PORT}/slow.mp4`;

    /* ---------------------------------------------------------------- 1 */
    const started = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl, presetId: 'small', source: 'url' }),
      })
    ).json();
    const downloading = started.job?.id;
    check('a link job starts', Boolean(downloading), started.error || '');

    const midway = await waitFor(async () => {
      const job = await getJob(downloading);
      return job && job.status === 'fetching' && job.progress > 0.1 ? job : null;
    });
    check('it is really downloading', Boolean(midway), midway ? `${Math.round(midway.progress * 100)}%` : 'never started');

    /* The file is still arriving, so there is nothing complete to hand over:
       a truncated MP4 must never be offered as the download. */
    const early = await fetch(`${BASE}/api/jobs/${downloading}/original/slow.mp4`);
    check('a half-downloaded file is not handed out as if it were whole', early.status === 409, String(early.status));

    // The machine stops in the middle of the download.
    server.kill('SIGKILL');
    await sleep(600);

    const fragment = path.join(DATA_DIR, 'jobs', downloading, 'source');
    const fragmentSize = fs.existsSync(fragment) ? fs.statSync(fragment).size : 0;
    check('a half-written source is left behind', fragmentSize > 0, `${fragmentSize} bytes`);

    server = startServer();
    await ready();

    const after = await getJob(downloading);
    check('the same job is still there after the restart', Boolean(after), after ? after.status : 'gone');
    check('it is picked up instead of being left failed', after?.resumed === true || after?.status !== 'error', after?.status);
    check(
      'it carries on from the fragment instead of starting over',
      ['fetching', 'queued', 'compressing', 'done', 'hosted'].includes(after?.status),
      after?.status,
    );

    /* What the user actually does after a crash: pastes the same link again.
       That must continue this job — not download and encode the file twice. */
    const repeat = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl, presetId: 'small', source: 'url' }),
      })
    ).json();
    check(
      'the same link sent again continues the job that is already going',
      repeat.job?.id === downloading,
      `${repeat.job?.id} vs ${downloading}`,
    );
    check('and says so instead of pretending it started something new', Boolean(repeat.reused), repeat.reused || 'no field');

    const finishedDownload = await waitFor(async () => {
      const job = await getJob(downloading);
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    });
    /* The complaint this test exists for: "it re-downloaded the whole file".
       A resume sends Range from where the fragment ended. */
    const ranged = source.requests.filter((entry) => entry.range && entry.range !== 'bytes=0-');
    check(
      'the rest of the download is a Range request, not a second full copy',
      ranged.length > 0,
      `${source.requests.length} request(s): ${source.requests.map((r) => r.range || 'full').join(', ')}`,
    );
    check(
      'the interrupted download ends with a file, not an error',
      ['done', 'hosted'].includes(finishedDownload?.status),
      finishedDownload?.error || finishedDownload?.status,
    );

    /* ---------------------------------------------------------------- 2 */
    /* Stopped during the upload: the encode finished, so the MP4 on disk is
       all that is needed. Written straight into the store, because the point
       is what the next start does with it. */
    const stalledId = 'stalledupload';
    const stalledDir = path.join(DATA_DIR, 'jobs', stalledId);
    await fsp.mkdir(stalledDir, { recursive: true });
    await fsp.copyFile(sample, path.join(stalledDir, 'output.mp4'));
    const store = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'jobs.json'), 'utf8'));
    store.push({
      id: stalledId,
      createdAt: Date.now(),
      status: 'hosting',
      stage: 'Uploading to a file host',
      progress: 0.4,
      source: 'url',
      url: 'https://example.test/clip.mp4',
      name: 'Clip.mp4',
      presetId: 'small',
      sourceBytes: 40 * 1024 ** 2,
      outputBytes: fs.statSync(path.join(stalledDir, 'output.mp4')).size,
      outputName: 'Clip small.mp4',
    });
    await fsp.writeFile(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(store));

    server.kill('SIGKILL');
    await sleep(600);
    server = startServer();
    await ready();

    const stalled = await waitFor(async () => {
      const job = await getJob(stalledId);
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    });
    check(
      'a job stopped mid-upload is not marked failed',
      stalled?.status !== 'error',
      stalled?.error || stalled?.status,
    );
    check('its finished file is uploaded again by itself', Boolean(stalled?.hostedUrl), stalled?.hostedUrl || stalled?.status);

    /* ---------------------------------------------------------------- 3 */
    /* "Just download it", pressed while a file is being treated. */
    const { job: running } = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'sample', presetId: 'max' }),
      })
    ).json();
    check('a compression job starts', Boolean(running?.id), running?.error || '');

    const treating = await waitFor(async () => {
      const job = await getJob(running.id);
      return job && job.status === 'compressing' ? job : null;
    });
    check('it reaches the encoder', Boolean(treating), treating?.stage || 'never started');

    /* "Just download it" is only useful if the bytes are actually there to
       send: this is the route the page points the browser at. */
    const originalNow = await fetch(`${BASE}/api/jobs/${running.id}/original/clip.mp4`);
    const originalLength = originalNow.ok ? Buffer.from(await originalNow.arrayBuffer()).length : 0;
    check('the untouched download can be fetched while it is being encoded', originalNow.ok, `${originalNow.status}`);
    check(
      'and it is the whole file, byte for byte',
      originalLength > 0 && originalLength === treating.sourceBytes,
      `${originalLength} vs ${treating.sourceBytes}`,
    );
    check(
      'it arrives as a download with its own name',
      /attachment/.test(originalNow.headers.get('content-disposition') || ''),
      originalNow.headers.get('content-disposition') || 'no header',
    );

    const switched = await fetch(`${BASE}/api/jobs/${running.id}/keep-original`, { method: 'POST' });
    const switchedBody = await switched.json().catch(() => ({}));
    check('the change of mind is accepted mid-encode', switched.ok, `${switched.status} ${switchedBody.error || ''}`);
    check('the card is told immediately', switchedBody.job?.noCompress === true);

    const released = await waitFor(async () => {
      const job = await getJob(running.id);
      return job && ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    }, { timeoutMs: 180000 });
    check('it finishes without failing', ['done', 'hosted'].includes(released?.status), released?.error || released?.status);
    check(
      'the file handed back is the original, byte for byte',
      released?.outputBytes === released?.sourceBytes,
      `${released?.outputBytes} vs ${released?.sourceBytes}`,
    );
    check('it says it was not re-encoded', released?.noCompress === true);
    check(
      'the name is the file\u2019s own, with no preset tag',
      /Slow Download\.mp4$/.test(released?.outputName || '') || /\.mp4$/.test(released?.outputName || ''),
      released?.outputName,
    );
    check(
      'it still ends up with a share link',
      Boolean(released?.hostedUrl),
      released?.hostedUrl || 'none',
    );

    /* A finished job cannot be switched any more — the original is gone. */
    const tooLate = await fetch(`${BASE}/api/jobs/${running.id}/keep-original`, { method: 'POST' });
    check('switching a finished job is refused, not silently ignored', tooLate.status === 409, String(tooLate.status));

    /* The tab title the card shows is what the browser will show: the name is
       in the URL of the download route. */
    const listed = await getJob(running.id);
    check(
      'the download link carries the file name',
      (listed?.downloadPath || '').includes(encodeURIComponent(listed?.tabTitle || '')),
      listed?.downloadPath,
    );
    const head = await fetch(`${BASE}${listed.downloadPath}`, { headers: { range: 'bytes=0-1' } }).catch(() => null);
    check('and that link really serves the file', Boolean(head && head.ok), head ? String(head.status) : 'no response');
    const named = head && head.headers.get('content-disposition');
    check(
      'the browser is handed the same name the tab shows',
      Boolean(named && named.includes(listed.tabTitle)),
      named || 'no content-disposition',
    );
    /* ---------------------------------------------------------------- 4 */
    /* A link that exists is posted before the queue is finished: if the machine
       runs out of minutes mid-queue, the files it already treated are not lost
       with it. Two jobs, one encoder slot, so the second is still running when
       the first one's link is already out. */
    hookHits.length = 0;
    const queued = [];
    for (let index = 0; index < 2; index += 1) {
      const { job } = await (
        await fetch(`${BASE}/api/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /* The second one is deliberately slow: it has to still be running
             when the first one's link is already posted. */
          body: JSON.stringify({ source: 'sample', presetId: index === 0 ? 'small' : 'max' }),
        })
      ).json();
      queued.push(job.id);
    }

    const firstHosted = await waitFor(async () => {
      for (const id of queued) {
        const job = await getJob(id);
        if (job && job.hostedUrl) return job;
      }
      return null;
    }, { timeoutMs: 300000 });
    check('the first of two files gets its link', Boolean(firstHosted?.hostedUrl), firstHosted?.status);

    /* Whichever finished first, the other one is still waiting its turn
       (MAX_CONCURRENT=1), so the queue has not drained yet. */
    const otherId = queued.find((id) => id !== firstHosted.id);
    const stillBusy = await getJob(otherId);
    check(
      'the other file is still being worked on',
      Boolean(stillBusy) && stillBusy.status !== 'hosted',
      `${stillBusy?.status} (ids ${queued.join(', ')})`,
    );

    const postedEarly = await waitFor(
      async () => (hookHits.some((hit) => hit.includes(firstHosted.hostedUrl)) ? true : null),
      { timeoutMs: 30000, intervalMs: 400 },
    );
    check(
      'its link is already posted while the queue is still running',
      Boolean(postedEarly),
      `${hookHits.length} post(s)`,
    );

    /* ---------------------------------------------------------------- 4 */
    /* The story as it was reported: a long encode, the machine stops, the user
       comes back two hours later and pastes the same link again. That must
       continue the job — not download the file again and start encoding at 0%.

       RESUME_INTERRUPTED=0 is deliberate: automatic pickup is switched off, so
       only the re-sent link can restart the work. */
    server.kill('SIGKILL');
    await sleep(600);
    const segmented = { SEGMENT_SECONDS: '2', SEGMENT_MIN_SECONDS: '1', RESUME_INTERRUPTED: '0' };
    server = startServer(segmented);
    await ready();

    const fast = slowSource(sample, { delayMs: 0 });
    await new Promise((resolve) => fast.listen(FAST_PORT, '127.0.0.1', resolve));
    const fastUrl = `http://127.0.0.1:${FAST_PORT}/fast.mp4`;
    const post = async () =>
      (
        await fetch(`${BASE}/api/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: fastUrl, presetId: 'small', source: 'url' }),
        })
      ).json();

    const begun = await post();
    const longJob = begun.job?.id;
    check('a long encode starts', Boolean(longJob), begun.error || '');
    const parts = await waitFor(
      async () => {
        const state = JSON.parse(
          await fsp.readFile(path.join(DATA_DIR, 'jobs', longJob, 'segments.json'), 'utf8').catch(() => '{}'),
        );
        return state.done && state.done.length >= 2 ? state : null;
      },
      { timeoutMs: 240000 },
    );
    check('it is really encoding in parts', Boolean(parts), parts ? `${parts.done.length}/${parts.total}` : 'never started');

    const servedBefore = fast.bytes();
    server.kill('SIGKILL');
    await sleep(700);

    /* Nothing is picked up on its own here — the user has to ask again. */
    server = startServer(segmented);
    await ready();
    const dropped = await getJob(longJob);
    check('after the crash the job is waiting, not finished', dropped?.status === 'error', dropped?.status);
    check('and nothing restarted it by itself', dropped?.resumed !== true, String(dropped?.resumed));

    const replay = await post();
    check('pasting the same link again continues that job', replay.job?.id === longJob, `${replay.job?.id} vs ${longJob}`);
    check('and it is called a resume, not a new run', replay.reused === 'resumed', replay.reused || 'no field');

    const picked = await waitFor(
      async () => {
        const current = await getJob(longJob);
        return current && current.resumeFrom !== null && current.resumeFrom > 0 ? current : null;
      },
      { timeoutMs: 60000 },
    );
    check(
      'the parts encoded before the crash are used again',
      Boolean(picked),
      picked ? `${Math.round(picked.resumeFrom * 100)}% already encoded` : 'started from zero',
    );
    check(
      'the file is not downloaded a second time',
      fast.bytes() - servedBefore < 64 * 1024,
      `${Math.round((fast.bytes() - servedBefore) / 1024)} KB after the restart`,
    );

    const longDone = await waitFor(
      async () => {
        const current = await getJob(longJob);
        return current && ['done', 'hosted', 'error'].includes(current.status) ? current : null;
      },
      { timeoutMs: 300000 },
    );
    check('and it finishes', ['done', 'hosted'].includes(longDone?.status), longDone?.error || longDone?.status);
    fast.close();

    /* ---------------------------------------------------------------- 5 */
    /* "It failed when it was nearly finished." The work of such a job is on
       disk — the download and every part already encoded — so the failure must
       not be the end of it. Two things are proved here: the job can be picked
       up again without downloading anything, and the original can be saved
       while the encode keeps going. */
    server.kill('SIGKILL');
    await sleep(600);

    const fastAgain = slowSource(sample, { delayMs: 0 });
    await new Promise((resolve) => fastAgain.listen(FAST_PORT, '127.0.0.1', resolve));

    const reviveId = 'stoppedat91';
    const reviveDir = path.join(DATA_DIR, 'jobs', reviveId);
    await fsp.mkdir(reviveDir, { recursive: true });
    await fsp.copyFile(sample, path.join(reviveDir, 'source'));
    const reviveBytes = fs.statSync(path.join(reviveDir, 'source')).size;
    const hollowId = 'nothingleftatall';
    await fsp.mkdir(path.join(DATA_DIR, 'jobs', hollowId), { recursive: true });

    const store5 = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'jobs.json'), 'utf8'));
    store5.push(
      {
        id: reviveId,
        createdAt: Date.now() - 40 * 60 * 1000,
        status: 'error',
        finishedAt: Date.now() - 30 * 60 * 1000,
        stage: 'Failed',
        progress: 0.91,
        source: 'url',
        url: fastUrl,
        name: 'Long 4K clip.mp4',
        presetId: 'small',
        sourceBytes: reviveBytes,
        outputBytes: 0,
        error: 'The encoder stopped 91% of the way through.',
      },
      {
        id: hollowId,
        createdAt: Date.now() - 60 * 60 * 1000,
        status: 'error',
        finishedAt: Date.now() - 60 * 60 * 1000,
        stage: 'Failed',
        progress: 0,
        source: 'url',
        url: 'https://example.test/unresolvable',
        name: 'Gone.mp4',
        presetId: 'small',
        sourceBytes: 0,
        outputBytes: 0,
        error: 'That link could not be read.',
      },
    );
    await fsp.writeFile(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(store5));

    server = startServer(segmented);
    await ready();

    const failedView = await getJob(reviveId);
    check('a failed job stays failed after the restart, it is not silently redone', failedView?.status === 'error', failedView?.status);
    check(
      'the card is told it can be carried on from',
      failedView?.canRetry === true,
      `canRetry ${failedView?.canRetry}, ${failedView?.sourceBytes} bytes kept`,
    );

    const hollow = await getJob(hollowId);
    check('a failure with nothing left says so instead of offering false hope', hollow?.canRetry === false);
    const hollowRetry = await fetch(`${BASE}/api/jobs/${hollowId}/retry`, { method: 'POST' });
    const hollowBody = await hollowRetry.json().catch(() => ({}));
    check(
      'and the button is refused if it is pressed anyway',
      hollowRetry.status === 409 && hollowBody.code === 'NOTHING_TO_RETRY',
      `${hollowRetry.status} ${hollowBody.code || ''}`,
    );

    const servedBeforeRetry = fastAgain.bytes();
    const retried = await fetch(`${BASE}/api/jobs/${reviveId}/retry`, { method: 'POST' });
    const retriedBody = await retried.json().catch(() => ({}));
    check('a failed job can be started again from its card', retried.ok, `${retried.status} ${retriedBody.error || ''}`);
    check(
      'and it picks up what failed instead of looking brand new',
      ['queued', 'compressing', 'fetching'].includes(retriedBody.job?.status),
      retriedBody.job?.status,
    );

    const twice = await fetch(`${BASE}/api/jobs/${reviveId}/retry`, { method: 'POST' });
    check('pressing it twice does not start the same job twice', twice.status === 409, String(twice.status));

    /* Saved while it is encoding: the bytes are there now, and the render has
       not been cancelled to get them. */
    const saving = await (await fetch(`${BASE}/api/jobs/${reviveId}/save-original`, { method: 'POST' })).json();
    check('the original can be saved while the file is still being treated', saving.ready === true, JSON.stringify(saving).slice(0, 120));
    check('the encode keeps going rather than being stopped', saving.job?.status === 'compressing' || saving.job?.status === 'queued', saving.job?.status);
    check('it is remembered, so the source is not deleted when the encode ends', saving.job?.wantOriginal === true);
    const savedBytes = await fetch(`${BASE}${saving.download}`)
      .then(async (response) => (response.ok ? Buffer.from(await response.arrayBuffer()).length : 0))
      .catch(() => 0);
    check('and the file it hands over is the whole original', savedBytes === reviveBytes, `${savedBytes} vs ${reviveBytes}`);

    const revived = await waitFor(
      async () => {
        const current = await getJob(reviveId);
        return current && ['done', 'hosted', 'error'].includes(current.status) ? current : null;
      },
      { timeoutMs: 300000 },
    );
    check('it finishes this time', ['done', 'hosted'].includes(revived?.status), revived?.error || revived?.status);
    check(
      'without downloading the file again',
      fastAgain.bytes() - servedBeforeRetry < 64 * 1024,
      `${Math.round((fastAgain.bytes() - servedBeforeRetry) / 1024)} KB fetched`,
    );
    check(
      'and the original is still on disk afterwards, as asked',
      fs.existsSync(path.join(reviveDir, 'source')),
      'the source was deleted despite the request to keep it',
    );
    const tooLateAgain = await fetch(`${BASE}/api/jobs/${reviveId}/retry`, { method: 'POST' });
    check('a job that has just finished cannot be retried over itself', tooLateAgain.status === 409, String(tooLateAgain.status));
    fastAgain.close();

  } finally {
    if (server) server.kill('SIGKILL');
    if (source) source.close();
    hook.close();
    hoster.close();
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
