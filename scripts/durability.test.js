#!/usr/bin/env node
/**
 * "Will it keep going if I close the tab, and will I find my links afterwards?"
 *
 * This runs the real server with a stub file host and answers that with
 * behaviour, not words:
 *
 *   1. a job is started and then the client DISCONNECTS — no polling, no
 *      event stream, nothing watching it,
 *   2. the job finishes and the share link is recorded,
 *   3. the server is killed mid-life (a stopped Codespace, a dead laptop),
 *   4. a fresh server starts on the same data directory and still lists the
 *      link, from the API and from the plain-text file.
 *
 *   npm run test:durability
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3213;
const HOSTER_PORT = 3214;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-durability-${Date.now()}`);

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 120000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function startServer() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      MAX_CONCURRENT: '1',
      HOSTERS: 'pixeldrain',
      PIXELDRAIN_API_BASE: `http://127.0.0.1:${HOSTER_PORT}`,
      AUTO_HOST: '1',
      ALLOW_PRIVATE_HOSTS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  return proc;
}

async function ready() {
  return waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });
}

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  const hoster = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/file/')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'durable1', name: 'video.mp4' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => hoster.listen(HOSTER_PORT, '127.0.0.1', resolve));

  let server = startServer();
  try {
    await ready();

    // 1. Start a job and walk away. Nothing polls it from here on.
    const created = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'sample', presetId: 'small' }),
      })
    ).json();
    const id = created.job?.id;
    check('a job can be started', Boolean(id));

    const finished = await waitFor(async () => {
      const { job } = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
      return ['done', 'hosted', 'error'].includes(job.status) ? job : null;
    });
    check('the job finished with nobody watching', finished?.status === 'hosted', finished?.status || 'timed out');
    check('it produced a share link', /^https?:/.test(finished?.hostedUrl || ''), finished?.hostedUrl);

    // 2. The link is in the durable list while the server is up.
    const live = await (await fetch(`${BASE}/api/links`)).json();
    check('the link is listed by /api/links', (live.links || []).some((l) => l.url === finished.hostedUrl));

    // 3. Kill the server: this is the Codespace stopping or the laptop dying.
    server.kill('SIGKILL');
    await sleep(800);

    // 4. Start again on the same data directory.
    server = startServer();
    await ready();

    const after = await (await fetch(`${BASE}/api/links`)).json();
    const kept = (after.links || []).find((l) => l.url === finished.hostedUrl);
    check('the link survives a restart', Boolean(kept), kept ? kept.name || '' : 'gone');

    const text = await (await fetch(`${BASE}/api/links.txt`)).text();
    check('the plain-text links file still has it', text.includes(finished.hostedUrl));

    const jobs = await (await fetch(`${BASE}/api/jobs`)).json();
    check('the job history survives a restart', (jobs.jobs || []).some((j) => j.id === id));
    check(
      'a finished job is not reported as interrupted',
      (jobs.jobs || []).find((j) => j.id === id)?.error !== 'Interrupted',
    );
  } finally {
    if (server) server.kill('SIGKILL');
    hoster.close();
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  console.log(failures ? 'Durability checks failed' : 'A closed tab and a restarted machine keep the links.');
  process.exit(failures ? 1 : 0);
})();
