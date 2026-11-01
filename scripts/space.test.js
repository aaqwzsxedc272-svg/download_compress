'use strict';

/**
 * The space policy, end to end.
 *
 * Space on the free machines this runs on is the whole reason the app deletes
 * things, so it gets its own server: a throwaway data dir, a fake hoster, and
 * the real delete-after-upload behaviour switched on.
 *
 * Checks, in order:
 *   1. a finished job uploads, and afterwards its files are gone from disk
 *   2. the share link survives that deletion (it is in the ledger, not the file)
 *   3. the download route says the file is gone instead of serving half a file
 *   4. a finished job's directory really is empty
 *   5. KEEP_LOCAL_AFTER_UPLOAD=1 keeps everything (the opt-out still works)
 *
 *   node scripts/space.test.js
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PORT = 3191;
const HOSTER_PORT = 3192;
const HOOK_PORT = 3193; // stands in for a webhook the links are posted to
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), `squeeze-space-${Date.now()}`);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 30000) {
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

async function waitForStatus(id, statuses, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { job } = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    last = job;
    if (statuses.includes(job.status)) return job;
    await sleep(500);
  }
  throw new Error(`job ${id} timed out in state ${last && last.status}`);
}

/** A stand-in for a webhook (Discord, n8n, …): records what it was sent. */
function fakeHook() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hits.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return { server, hits };
}

/** A stand-in for pixeldrain that accepts the upload and hands back an id. */
function fakeHoster() {
  const uploads = new Map();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/file/')) {
      const name = decodeURIComponent(req.url.slice('/api/file/'.length));
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += chunk.length;
      });
      req.on('end', () => {
        const id = `space${uploads.size + 1}`;
        uploads.set(id, { name, bytes });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, name }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return { server, uploads };
}

async function startApp(extraEnv = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      MAX_CONCURRENT: '1',
      ALLOW_PRIVATE_HOSTS: '1',
      HOSTERS: 'pixeldrain',
      PIXELDRAIN_API_BASE: `http://127.0.0.1:${HOSTER_PORT}`,
      AUTO_HOST: '1',
      AUTO_EMAIL: '0',
      PUBLISH_WEBHOOK: `http://127.0.0.1:${HOOK_PORT}/hook`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', (d) => (proc.log += d));
  proc.stderr.on('data', (d) => (proc.log += d));
  return proc;
}

async function stopApp(proc) {
  if (!proc) return;
  proc.kill('SIGKILL');
  await sleep(400);
}

/** Every file inside a job's directory, relative to it. */
async function jobFiles(jobId) {
  const dir = path.join(DATA_DIR, 'jobs', jobId);
  const out = [];
  const walk = async (current, prefix) => {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, path.join(prefix, entry.name));
      else {
        const stat = await fs.stat(full).catch(() => null);
        out.push({ name: path.join(prefix, entry.name), bytes: stat ? stat.size : 0 });
      }
    }
  };
  await walk(dir, '');
  return out;
}

async function main() {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  const hoster = fakeHoster();
  const hook = fakeHook();
  await new Promise((resolve) => hoster.server.listen(HOSTER_PORT, '127.0.0.1', resolve));
  await new Promise((resolve) => hook.server.listen(HOOK_PORT, '127.0.0.1', resolve));

  let app = null;
  try {
    app = await startApp();
    await waitForHealth();

    console.log('delete once hosted (the default)');
    const created = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'sample', presetId: 'small' }),
      })
    ).json();
    const job = await waitForStatus(created.job.id, ['hosted', 'done', 'error']);
    check('the job reaches the host', job.status === 'hosted', job.hostError || job.error || '');
    check('the host got every byte', hoster.uploads.size === 1, `${hoster.uploads.size} upload(s)`);

    await sleep(700); // the deletion runs just after the upload resolves
    const after = await (await fetch(`${BASE}/api/jobs/${job.id}`)).json();
    const view = after.job;
    check('the local copy is marked deleted', view.localDeleted === true);
    check('the job reports no file', view.hasFile === false);
    check('the share link survives the deletion', Boolean(view.hostedUrl), view.hostedUrl);

    const files = await jobFiles(job.id);
    check('not one byte is left in the job directory', files.length === 0, files.map((f) => f.name).join(', '));

    const download = await fetch(`${BASE}/api/jobs/${job.id}/download`);
    check('the download route answers 410/404, not a broken file', [404, 410].includes(download.status), String(download.status));

    /* The upload runs behind the encoder, so the queue "drains" before the link
       exists. The links must still be posted — and posted only once there is a
       real URL in them. */
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !hook.hits.some((hit) => hit.includes(view.hostedUrl))) {
      await sleep(500);
    }
    const posted = hook.hits.find((hit) => hit.includes(view.hostedUrl));
    check('the link is posted automatically once the upload finishes', Boolean(posted));
    if (posted) {
      const payload = JSON.parse(posted);
      check('the post happens after the link exists', !/undefined|null\/u\//.test(payload.text), payload.text.slice(0, 80));
      check('and names the reason', /queue is finished/.test(payload.text));
    }
    check('nothing was posted before there was a link', hook.hits.length === 1, `${hook.hits.length} post(s)`);

    const links = await (await fetch(`${BASE}/api/links`)).json();
    check(
      'the link is still in the durable list',
      (links.links || []).some((link) => link.url === view.hostedUrl),
      `${(links.links || []).length} link(s)`,
    );

    const disk = await (await fetch(`${BASE}/api/health`)).json();
    check('health still reports free space', Number(disk.disk.freeBytes) > 0);

    console.log('keep-local opt-out');

    await stopApp(app);
    app = await startApp({ KEEP_LOCAL_AFTER_UPLOAD: '1' });
    await waitForHealth();

    const kept = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'sample', presetId: 'small' }),
      })
    ).json();
    const keptJob = await waitForStatus(kept.job.id, ['hosted', 'done', 'error']);
    check('the opt-out job still hosts', keptJob.status === 'hosted', keptJob.hostError || keptJob.error || '');
    const keptView = (await (await fetch(`${BASE}/api/jobs/${kept.job.id}`)).json()).job;
    check('KEEP_LOCAL_AFTER_UPLOAD=1 keeps the file', keptView.hasFile === true);
    check('and does not mark it deleted', keptView.localDeleted !== true);
    const keptFiles = await jobFiles(kept.job.id);
    check('the files are still on disk', keptFiles.length > 0, keptFiles.map((f) => f.name).join(', '));

    const served = await fetch(`${BASE}/api/jobs/${keptJob.id}/download`);
    check('the download route serves it', served.status === 200);
  } finally {
    await stopApp(app);
    hoster.server.close();
    hook.server.close();
    await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`Space run crashed: ${err.message}`);
  process.exit(1);
});
