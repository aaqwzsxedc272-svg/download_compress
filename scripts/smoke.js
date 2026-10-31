'use strict';

/**
 * End-to-end check of every way a video can reach the encoder.
 * Starts its own server on a spare port with a throwaway data directory.
 *
 *   npm run smoke
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PORT = 3199;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), `squeeze-smoke-${Date.now()}`);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;

function check(label, ok, detail = '') {
  const mark = ok ? '  ok  ' : ' FAIL ';
  if (!ok) failures += 1;
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('server did not start');
}

async function waitForJob(id, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/jobs/${id}`);
    const { job } = await res.json();
    last = job;
    if (job.status === 'done' || job.status === 'error') return job;
    await sleep(500);
  }
  throw new Error(`job ${id} timed out in state ${last?.status}`);
}

async function createJob(body) {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.job;
}

async function fetchBytes(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, headers: res.headers, status: res.status };
}

function isMp4(buf) {
  return buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp';
}

async function main() {
  await fs.rm(DATA_DIR, { recursive: true, force: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, MAX_CONCURRENT: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  const cleanup = async () => {
    server.kill('SIGKILL');
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const health = await waitForHealth();
    check('server health endpoint', health.ok === true);
    check('presets exposed', Array.isArray(health.presets) && health.presets.length >= 5);

    // ---------------------------------------------------------------- sample
    const sampleJob = await createJob({ source: 'sample', presetId: 'tiny' });
    const sampleDone = await waitForJob(sampleJob.id);
    check('sample job completes', sampleDone.status === 'done', sampleDone.error || '');
    check('sample output is smaller', sampleDone.outputBytes > 0 && sampleDone.outputBytes < sampleDone.sourceBytes,
      `${sampleDone.sourceBytes} → ${sampleDone.outputBytes}`);
    check('sample thumbnail generated', sampleDone.hasThumb);

    const download = await fetchBytes(`${BASE}/api/jobs/${sampleJob.id}/download`);
    check('download returns an MP4', download.status === 200 && isMp4(download.buf), `${download.buf.length} bytes`);
    check('download sets attachment filename',
      (download.headers.get('content-disposition') || '').includes('attachment;'));

    const ranged = await fetch(`${BASE}/api/jobs/${sampleJob.id}/preview`, { headers: { range: 'bytes=0-99' } });
    check('preview supports range requests', ranged.status === 206);

    // ---------------------------------------------------------------- upload
    const samplePath = path.join(DATA_DIR, 'sample.mp4');
    const fileBytes = await fs.readFile(samplePath);
    const uploadRes = await fetch(`${BASE}/api/upload?name=smoke-upload.mp4&presetId=small`, {
      method: 'POST',
      headers: { 'content-type': 'video/mp4' },
      body: fileBytes,
    });
    const uploadData = await uploadRes.json();
    check('direct upload accepted', uploadRes.status === 201);
    const uploadDone = await waitForJob(uploadData.job.id);
    check('upload job completes', uploadDone.status === 'done', uploadDone.error || '');
    check('upload output named from source', /smoke-upload.*\.mp4$/.test(uploadDone.outputName || ''), uploadDone.outputName);

    // ----------------------------------------------------------------- relay
    const { token } = await (await fetch(`${BASE}/api/relay-token`, { method: 'POST' })).json();
    const relayRes = await fetch(
      `${BASE}/api/relay/${token}?url=https%3A%2F%2Fexample.com%2Fclip.mp4&filename=smoke-relay.mp4&presetId=tiny&targetMb=3`,
      { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: fileBytes },
    );
    const relayData = await relayRes.json();
    check('relay upload accepted', relayRes.status === 201);
    const relayDone = await waitForJob(relayData.job.id);
    check('relay job completes', relayDone.status === 'done', relayDone.error || '');
    check('target size respected (±20%)',
      relayDone.outputBytes > 0 && Math.abs(relayDone.outputBytes - 3 * 1024 * 1024) < 0.6 * 1024 * 1024,
      `${(relayDone.outputBytes / 1048576).toFixed(2)} MB`);

    const replay = await fetch(`${BASE}/api/relay/${token}`, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4' },
      body: fileBytes,
    });
    check('relay token is single use', replay.status === 410);

    // ------------------------------------------------------------------- url
    // The smoke server can reach itself, which exercises the server-download path.
    const selfUrl = `${BASE}/api/jobs/${sampleJob.id}/preview`;
    const probe = await (
      await fetch(`${BASE}/api/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: selfUrl }),
      })
    ).json();
    check('probe detects a fetchable direct link', probe.serverCanFetch === true);

    const urlJob = await createJob({ source: 'url', url: selfUrl, presetId: 'tiny' });
    const urlDone = await waitForJob(urlJob.id);
    check('url job completes', urlDone.status === 'done', urlDone.error || '');
    check('url job recorded its source', urlDone.source === 'url');

    // --------------------------------------------------------------- failure
    const badUpload = await fetch(`${BASE}/api/upload?name=notes.txt`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'definitely not a video',
    });
    const badData = await badUpload.json();
    check('non-video upload rejected', badUpload.status === 415, badData.error);

    const badUrl = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'url', url: 'nonsense' }),
      })
    ).json();
    check('invalid link rejected', Boolean(badUrl.code));

    const ghost = await fetch(`${BASE}/api/jobs/does-not-exist`);
    check('unknown job returns 404', ghost.status === 404);
  } catch (err) {
    failures += 1;
    console.error('\nSmoke run crashed:', err.message);
    console.error(serverLog.slice(-2000));
  } finally {
    await cleanup();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main();
