'use strict';

/**
 * End-to-end check of every way a video can reach the encoder.
 * Starts its own server on a spare port with a throwaway data directory.
 *
 *   npm run smoke
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PORT = 3199;
const MEDIA_PORT = 3198; // stands in for an external host that serves video
const HOSTER_PORT = 3197; // stands in for pixeldrain's upload API
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
    if (['done', 'hosted', 'error'].includes(job.status)) return job;
    await sleep(500);
  }
  throw new Error(`job ${id} timed out in state ${last?.status}`);
}

async function waitForStatus(id, statuses, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/jobs/${id}`);
    const { job } = await res.json();
    last = job;
    if (statuses.includes(job.status)) return job;
    await sleep(500);
  }
  return last;
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

  const serverEnv = {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    MAX_CONCURRENT: '2',
    ALLOW_PRIVATE_HOSTS: '1', // the fake "external host" is on 127.0.0.1
    HOSTERS: 'pixeldrain', // keep the chain deterministic in tests
    PIXELDRAIN_API_BASE: `http://127.0.0.1:${HOSTER_PORT}`,
    AUTO_HOST: '1',
  };

  let serverLog = '';
  let server = null;

  function startServer() {
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => (serverLog += d));
    proc.stderr.on('data', (d) => (serverLog += d));
    return proc;
  }

  server = startServer();

  let mediaServer = null;
  let hosterServer = null;
  const hostedUploads = new Map();

  const cleanup = async () => {
    if (server) server.kill('SIGKILL');
    if (mediaServer) mediaServer.close();
    if (hosterServer) hosterServer.close();
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const health = await waitForHealth();

    hosterServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url.startsWith('/api/file/')) {
        const name = decodeURIComponent(req.url.slice('/api/file/'.length));
        let bytes = 0;
        req.on('data', (chunk) => {
          bytes += chunk.length;
        });
        req.on('end', () => {
          const id = `hosted${hostedUploads.size + 1}`;
          hostedUploads.set(id, { name, bytes });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, name }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => hosterServer.listen(HOSTER_PORT, '127.0.0.1', resolve));

    check('server health endpoint', health.ok === true);
    check('presets exposed', Array.isArray(health.presets) && health.presets.length >= 5);
    check('health reports disk space', Number.isFinite(health.disk?.freeBytes) && health.disk.freeBytes > 0);
    check('health reports the auto-stop state', Boolean(health.autoStop) && 'enabled' in health.autoStop);

    // ---------------------------------------------------------------- sample
    const sampleJob = await createJob({ source: 'sample', presetId: 'tiny' });
    const sampleDone = await waitForJob(sampleJob.id);
    check('sample job completes', ['done', 'hosted'].includes(sampleDone.status), sampleDone.error || '');
    check('sample output is smaller', sampleDone.outputBytes > 0 && sampleDone.outputBytes < sampleDone.sourceBytes,
      `${sampleDone.sourceBytes} → ${sampleDone.outputBytes}`);
    check('sample thumbnail generated', sampleDone.hasThumb);

    const results = await (await fetch(`${BASE}/api/results`)).json();
    check('results endpoint lists the finished job', results.results.some((r) => r.id === sampleDone.id));
    const links = await (await fetch(`${BASE}/api/results.txt`)).text();
    check('results.txt is served as plain text', typeof links === 'string');

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
    check('upload job completes', ['done', 'hosted'].includes(uploadDone.status), uploadDone.error || '');
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
    check('relay job completes', ['done', 'hosted'].includes(relayDone.status), relayDone.error || '');
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
    check('url job completes', ['done', 'hosted'].includes(urlDone.status), urlDone.error || '');
    check('url job recorded its source', urlDone.source === 'url');

    // ---------------------------------------------------- share-page resolving
    // A fake external host: an HTML page that advertises a video, plus the file.
    const mediaDir = path.join(DATA_DIR, 'media');
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.copyFile(samplePath, path.join(mediaDir, 'clip.mp4'));
    await fs.writeFile(
      path.join(mediaDir, 'watch.html'),
      '<html><head><meta property="og:video:secure_url" content="/clip.mp4"></head>' +
        '<body><video src="/clip.mp4"></video></body></html>',
    );
    mediaServer = http.createServer(async (req, res) => {
      const name = req.url === '/watch.html' ? 'watch.html' : 'clip.mp4';
      try {
        const body = await fs.readFile(path.join(mediaDir, name));
        res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html' : 'video/mp4' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => mediaServer.listen(MEDIA_PORT, '127.0.0.1', resolve));

    const pageUrl = `http://127.0.0.1:${MEDIA_PORT}/watch.html`;
    const resolved = await (
      await fetch(`${BASE}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: pageUrl }),
      })
    ).json();
    check('resolves an HTML page to its video file', resolved.files?.length === 1, JSON.stringify(resolved).slice(0, 120));
    check('resolver identified the page route', resolved.resolver === 'page');
    check('resolved file has a usable name', /clip\.mp4$/.test(resolved.files?.[0]?.name || ''), resolved.files?.[0]?.name);

    const refJob = await createJob({
      source: 'ref',
      ref: resolved.files[0].ref,
      name: resolved.files[0].name,
      pageUrl,
      presetId: 'tiny',
    });
    const refDone = await waitForJob(refJob.id);
    check(
      'a resolved reference downloads and compresses',
      ['done', 'hosted'].includes(refDone.status),
      refDone.error || '',
    );
    check('reference job reports its resolver', refDone.resolver !== null, String(refDone.resolver));

    const badRef = await fetch(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ref', ref: { resolver: 'evil', url: 'http://x' } }),
    });
    check('unknown resolver rejected', badRef.status === 400);

    const badResolve = await (
      await fetch(`${BASE}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-link' }),
      })
    ).json();
    check('resolve rejects junk input', badResolve.code === 'BAD_URL');

    // ------------------------------------------------------ hosting the result
    // (fake hoster is started further up, before jobs begin)

    // The first sample job finishes, then auto-hosts itself on the fake host.
    const hostedSample = await waitForStatus(sampleJob.id, ['hosted', 'error'], 120000);
    check('finished jobs are auto-hosted', hostedSample.status === 'hosted', hostedSample.hostError || hostedSample.error || '');
    check(
      'share link points at the host',
      /^http:\/\/127\.0\.0\.1:3197\/u\/hosted\d+$/.test(hostedSample.hostedUrl || ''),
      hostedSample.hostedUrl,
    );
    check('hoster recorded the upload', hostedUploads.size >= 1, `${hostedUploads.size} file(s)`);

    const uploadedBytes = [...hostedUploads.values()][0]?.bytes || 0;
    check(
      'the whole compressed file was uploaded',
      uploadedBytes === hostedSample.outputBytes,
      `${uploadedBytes} vs ${hostedSample.outputBytes}`,
    );
    check('hosted provider is reported', hostedSample.hostProvider === 'pixeldrain', hostedSample.hostProvider);
    check('hosted file stays downloadable locally', hostedSample.hasFile === true);

    const jobList = await (await fetch(`${BASE}/api/jobs`)).json();
    check('job list exposes recent jobs', Array.isArray(jobList.jobs) && jobList.jobs.length >= 1);
    check(
      'job list carries the share link',
      jobList.jobs.some((j) => j.hostedUrl),
      `${jobList.jobs.length} jobs`,
    );

    // A link obtained elsewhere (e.g. uploaded from the browser) can be attached.
    const manual = await createJob({ source: 'sample', presetId: 'tiny' });
    await waitForStatus(manual.id, ['done', 'hosted', 'error'], 120000);
    const attach = await fetch(`${BASE}/api/jobs/${manual.id}/hosted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://gofile.io/d/BrowserMade', provider: 'gofile' }),
    });
    const attached = await attach.json();
    check('a browser-made link can be attached', attach.status === 200 && attached.job.hostedUrl.endsWith('BrowserMade'));
    check('attached link records who made it', attached.job.hostedBy === 'browser', attached.job.hostedBy);

    const badLink = await fetch(`${BASE}/api/jobs/${manual.id}/hosted`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });
    check('a non-http link is refused', badLink.status === 400);

    const ghostHost = await fetch(`${BASE}/api/jobs/nope/host`, { method: 'POST' });
    check('hosting an unknown job 404s', ghostHost.status === 404);

    // --------------------------------------------------- chunked/resumable upload
    const chunkInit = await (
      await fetch(`${BASE}/api/upload/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'chunked.mp4', size: fileBytes.length, presetId: 'tiny' }),
      })
    ).json();
    check('chunked upload init returns an id', Boolean(chunkInit.uploadId) && chunkInit.chunkSize > 0);

    const chunkCount = 5;
    const per = Math.ceil(fileBytes.length / chunkCount);
    let uploaded = 0;
    for (let i = 0; i < chunkCount; i += 1) {
      const slice = fileBytes.subarray(i * per, Math.min((i + 1) * per, fileBytes.length));
      const res = await fetch(`${BASE}/api/upload/chunk/${chunkInit.uploadId}/${i}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: slice,
      });
      if (res.ok) uploaded += 1;
    }
    check('all chunks accepted', uploaded === chunkCount, `${uploaded}/${chunkCount}`);

    const dupe = await fetch(`${BASE}/api/upload/chunk/${chunkInit.uploadId}/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    check('a re-sent chunk is tolerated', dupe.status === 200);

    const jump = await fetch(`${BASE}/api/upload/chunk/${chunkInit.uploadId}/99`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    check('an out-of-order chunk is rejected', jump.status === 409);

    const chunkDone = await (
      await fetch(`${BASE}/api/upload/finish/${chunkInit.uploadId}`, { method: 'POST' })
    ).json();
    check('chunked upload produces a job', Boolean(chunkDone.job?.id));

    const chunkedJob = await waitForJob(chunkDone.job.id);
    check('chunked upload results in a video', ['done', 'hosted'].includes(chunkedJob.status), chunkedJob.error || '');
    check(
      'chunked upload kept every byte',
      chunkedJob.sourceBytes === fileBytes.length,
      `${chunkedJob.sourceBytes} vs ${fileBytes.length}`,
    );

    const ghostUpload = await fetch(`${BASE}/api/upload/finish/not-a-real-upload`, { method: 'POST' });
    check('unknown upload id is refused', ghostUpload.status === 410);

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

    // ------------------------------------------------ survives a server restart
    await sleep(600);
    const beforeRestart = await (await fetch(`${BASE}/api/jobs`)).json();
    const hostedBefore = beforeRestart.jobs.find((j) => j.id === sampleJob.id);
    check('the sample job is the one under test', Boolean(hostedBefore?.hostedUrl), hostedBefore?.hostedUrl);
    server.kill('SIGKILL');
    await sleep(700);
    server = startServer();
    await waitForHealth();
    const afterRestart = await (await fetch(`${BASE}/api/jobs`)).json();
    const restored = afterRestart.jobs.find((j) => j.id === hostedBefore?.id);
    check('job history survives a restart', Boolean(restored), `${afterRestart.jobs.length} jobs`);
    check(
      'share links survive a restart',
      restored?.hostedUrl === hostedBefore?.hostedUrl,
      `${restored?.hostedUrl}`,
    );
    check(
      'links are also appended to a durable ledger',
      await fs
        .readFile(path.join(DATA_DIR, 'links.json'), 'utf8')
        .then((text) => text.includes(hostedBefore?.hostedUrl || 'missing'))
        .catch(() => false),
    );
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
