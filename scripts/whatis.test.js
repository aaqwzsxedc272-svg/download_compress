#!/usr/bin/env node
/**
 * A file that will not probe must be answered, not shrugged at.
 *
 * The report this comes from: a 1.88 GB Drive download called `.mp4` that
 * produced "That file is not a video this server can read." three times in a
 * row, because "Try again" read the same bytes and failed at the same offset.
 * There are a dozen things that file could have been, and only one of them
 * wanted a retry.
 *
 * Everything here is built from real bytes: a RAR header, a web page, a
 * truncated MP4, and — the interesting one — an MPEG-TS recording whose first
 * packet was lost, which the bundled (2018) ffprobe *crashes* on while a stream
 * copy reads it perfectly.
 *
 *   npm run test:whatis
 */
'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { identify, shapeOf, adviceFor, shouldRedownload } = require('../server/whatis');
const { probe, probeOrExplain, repair } = require('../server/ffmpeg');

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-400)))));
  });
}

const rar = () => Buffer.concat([Buffer.from('Rar!\x1a\x07\x00\xcf\x907\x00', 'latin1'), Buffer.alloc(4096, 3)]);
const zip = () => Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(1024, 1)]);
const html = () => Buffer.from('<!doctype html><html><body>You need access</body></html>');

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-whatis-'));
  const write = async (name, buffer) => {
    const file = path.join(dir, name);
    await fsp.writeFile(file, buffer);
    return file;
  };

  /* ------------------------------------------------------- what the bytes are */
  await check('a RAR with .mp4 on the end is a RAR', async () => {
    const file = await write('release.mp4', rar());
    const shape = await identify(file);
    assert.strictEqual(shape.kind, 'rar');
    assert.strictEqual(shape.family, 'archive');
    assert.match(adviceFor(shape, { bytes: shape.bytes }), /Extract it on your own machine/);
  });

  await check('a ZIP is named as a ZIP', async () => {
    const shape = await identify(await write('a.mp4', zip()));
    assert.strictEqual(shape.kind, 'zip');
  });

  await check('a share page saved as .mp4 says the link, not the file, was wrong', async () => {
    const shape = await identify(await write('page.mp4', html()));
    assert.strictEqual(shape.kind, 'html');
    assert.match(adviceFor(shape), /web page instead of the file/);
  });

  await check('an empty file is its own answer', async () => {
    const shape = await identify(await write('empty.mp4', Buffer.alloc(0)));
    assert.strictEqual(shape.kind, 'empty');
    assert.match(adviceFor(shape), /download produced nothing/);
  });

  await check('a missing file does not throw', async () => {
    const shape = await identify(path.join(dir, 'not-there.mp4'));
    assert.strictEqual(shape.kind, 'missing');
  });

  /* --------------------------------------------------------------- real video */
  const clip = path.join(dir, 'clip.mp4');
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    clip,
  ]);

  await check('a real MP4 is recognised from its bytes', async () => {
    const shape = await identify(clip);
    assert.strictEqual(shape.kind, 'mp4');
    assert.strictEqual(shape.family, 'video');
  });

  /* ------------------------------------------------------------- truncation */
  await check('an MP4 cut in half is reported as damaged, not as "not a video"', async () => {
    const whole = await fsp.readFile(clip);
    const cut = await write('cut.mp4', whole.subarray(0, Math.floor(whole.length * 0.6)));
    let message = null;
    try {
      await probeOrExplain(cut, { workDir: dir, expected: whole.length });
    } catch (err) {
      message = err.advice;
    }
    assert.ok(message, 'it did not explain itself');
    assert.match(message, /cannot parse it|cannot parse|damaged/i);
  });

  /* ------------------------------------- the crash that produced "not a video" */
  const ts = path.join(dir, 'recording.ts');
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', clip, '-c', 'copy', '-f', 'mpegts', ts]);
  await check('an MPEG-TS with a lost first packet: ffprobe crashes, and the app repairs it', async () => {
    const buffer = await fsp.readFile(ts);
    buffer.fill(0, 0, 188);
    const broken = await write('recording.mp4', buffer);

    const shape = await identify(broken);
    assert.strictEqual(shape.kind, 'mpegts', 'the sync pattern was not found');

    /* This is the failure the app must survive: not an error message, a crash. */
    let crashed = false;
    try {
      await probe(broken);
    } catch (err) {
      crashed = Boolean(err.crashed);
      assert.strictEqual(err.code, 'INVALID_MEDIA');
    }
    assert.ok(crashed, 'ffprobe did not crash on this file — the fixture is not exercising the case');

    const read = await probeOrExplain(broken, { workDir: dir });
    assert.ok(read.info, 'nothing was returned');
    assert.strictEqual(read.repaired, true, 'it did not report the repair');
    assert.ok(read.info.width >= 320, `repaired to ${read.info.width}×${read.info.height}`);
    assert.ok(read.info.duration > 3, `repaired to ${read.info.duration}s`);
    assert.match(read.note, /remuxed without re-encoding/);

    /* The repaired file is the one on disk, and it probes on its own now. */
    const again = await probe(broken);
    assert.ok(again.width > 0);
  });

  await check('a file that is not a video is never remuxed', async () => {
    const file = await write('angry.mp4', rar());
    const fixed = await repair(file, { workDir: dir });
    assert.strictEqual(fixed.info, null);
    assert.match(fixed.advice, /RAR/);
  });

  /* --------------------------------------------------------------- retrying */
  await check('a retry after a web page re-downloads, after a RAR it does not', () => {
    assert.strictEqual(shouldRedownload(shapeOf(html())), true);
    assert.strictEqual(shouldRedownload(shapeOf(rar())), false);
    assert.strictEqual(shouldRedownload(shapeOf(Buffer.alloc(0))), true);
    assert.strictEqual(shouldRedownload(shapeOf(Buffer.from('7853429abcdef', 'utf8'))), false);
    /* A file that stopped downloading short of what the host promised: that is
       the download's fault, and it is the one broken-container case that a
       retry fixes. */
    const mp4Shape = shapeOf(Buffer.concat([Buffer.from('\x00\x00\x00\x20ftypisom', 'latin1'), Buffer.alloc(64)]));
    assert.strictEqual(mp4Shape.kind, 'mp4');
    assert.strictEqual(shouldRedownload(mp4Shape, { bytes: 900, expected: 1800 }), true);
    assert.strictEqual(shouldRedownload(mp4Shape, { bytes: 1800, expected: 1800 }), false);
  });

  /* ------------------------------------------- the loop, through the real app */
  /* The report: three identical "not a video" failures and a Try again button
     that did the same thing each time. This drives the actual endpoints. */
  const APP_PORT = 3278;
  const FIXTURE_PORT = 3279;
  const dataDir = path.join(os.tmpdir(), `squeeze-whatis-app-${process.pid}`);
  const requests = [];

  const fixture = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith('/release.mp4')) {
      /* A RAR served as a download with a neutral type: the only way to reach
         the "cannot read it" path is for the bytes to arrive. */
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="release.mp4"' });
      return res.end(rar());
    }
    if (req.url.startsWith('/page.mp4')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(html());
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => fixture.listen(FIXTURE_PORT, '127.0.0.1', resolve));

  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DATA_DIR: dataDir,
      AUTO_HOST: '0',
      HOSTERS: '',
      ALLOW_PRIVATE_HOSTS: '1',
      SQUEEZE_PROBE_SECONDS: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let appLog = '';
  app.stderr.on('data', (chunk) => {
    appLog += chunk;
  });

  const api = async (route, init) => {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}${route}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const waitFor = async (check, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await check().catch(() => null);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  };

  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok, 20000);

    const started = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: `http://127.0.0.1:${FIXTURE_PORT}/release.mp4`, presetId: 'auto' }),
    });
    const jobId = started.body.job && started.body.job.id;
    assert.ok(jobId, `the job was not created: ${JSON.stringify(started.body)}`);

    const failed = await waitFor(async () => {
      const { body } = await api(`/api/jobs/${jobId}`);
      return body.job && body.job.status === 'error' ? body.job : null;
    });
    await check('a RAR named .mp4 fails with the reason, not a shrug', () => {
      assert.ok(failed, 'the job never failed');
      assert.match(failed.error, /RAR archive/, `it said: ${failed.error}`);
      assert.match(failed.error, /Extract it on your own machine/);
    });

    const retried = await api(`/api/jobs/${jobId}/retry`, { method: 'POST' });
    await check('and Try again refuses to loop over the same bytes', () => {
      assert.strictEqual(retried.status, 409, `it started a job again (HTTP ${retried.status})`);
      assert.match(retried.body.error, /same bytes/);
    });

    const before = requests.filter((route) => route.startsWith('/page.mp4')).length;
    const second = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: `http://127.0.0.1:${FIXTURE_PORT}/page.mp4`, presetId: 'auto' }),
    });
    const pageId = second.body.job && second.body.job.id;
    const pageFailed = await waitFor(async () => {
      const { body } = await api(`/api/jobs/${pageId}`);
      return body.job && body.job.status === 'error' ? body.job : null;
    });
    await check('a web page saved as .mp4 is reported as the link being wrong', () => {
      assert.ok(pageFailed, 'the job never failed');
      assert.match(pageFailed.error, /web page instead of the file/, `it said: ${pageFailed.error}`);
    });

    const pageRetried = await api(`/api/jobs/${pageId}/retry`, { method: 'POST' });
    await check('and there, Try again fetches the file again — the bytes were the problem', async () => {
      assert.strictEqual(pageRetried.status, 200, `it refused a retry that could work (HTTP ${pageRetried.status})`);
    });
    const fetchedAgain = await waitFor(
      async () => (requests.filter((route) => route.startsWith('/page.mp4')).length > before ? true : null),
      20000,
    );
    assert.ok(fetchedAgain, 'it never asked the host again');
  } finally {
    app.kill('SIGTERM');
    fixture.close();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

  if (failures.length && appLog) console.error(appLog.slice(-1500));
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
