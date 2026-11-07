#!/usr/bin/env node
/**
 * "My PC turned off while it was compressing — did it finish?"
 *
 * Kills the server in the middle of an encode, starts it again on the same data
 * directory, and checks that the half-done job is picked up and carried to a
 * share link instead of being stranded as an error.
 *
 *   npm run test:resume
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3215;
const HOSTER_PORT = 3216;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-resume-${Date.now()}`);

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 120000, intervalMs = 400 } = {}) {
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
      // A short probe keeps the test quick; the sample is 45 s of 1080p.
      SQUEEZE_PROBE_SECONDS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  return proc;
}

const ready = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  const hoster = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/file/')) {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'resumed1', name: 'video.mp4' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => hoster.listen(HOSTER_PORT, '127.0.0.1', resolve));

  let server = startServer();
  try {
    await ready();

    // Max quality on 45 s of 1080p: long enough to be interrupted for real.
    const { job } = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'sample', presetId: 'max' }),
      })
    ).json();
    check('a job can be started', Boolean(job?.id));
    const id = job.id;

    // Wait until it is actually encoding (past the probe), then pull the plug.
    const encoding = await waitFor(async () => {
      const current = (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;
      return current.status === 'compressing' && current.progress > 0.05 ? current : null;
    });
    check('the job reached the encoder before the crash', Boolean(encoding), encoding ? `${Math.round(encoding.progress * 100)}%` : 'never started');

    server.kill('SIGKILL');
    await sleep(900);
    check('the machine is off', true);

    server = startServer();
    await ready();

    const restarted = (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;
    check(
      'the interrupted job is picked up again on boot',
      ['queued', 'compressing', 'done', 'hosted'].includes(restarted.status),
      restarted.status,
    );

    const finished = await waitFor(
      async () => {
        const current = (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;
        return ['done', 'hosted', 'error'].includes(current.status) ? current : null;
      },
      { timeoutMs: 240000 },
    );
    check('it finishes after the restart', finished?.status === 'hosted' || finished?.status === 'done', finished?.status || 'timed out');
    check('it ends up with a share link', /^https?:/.test(finished?.hostedUrl || ''), finished?.hostedUrl || finished?.error);
    check('it is no longer marked interrupted', finished?.interrupted !== true);
  } finally {
    if (server) server.kill('SIGKILL');
    hoster.close();
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  console.log(failures ? 'Resume checks failed' : 'An interrupted encode is carried to a share link on the next boot.');
  process.exit(failures ? 1 : 0);
})();
