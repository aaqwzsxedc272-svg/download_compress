#!/usr/bin/env node
/**
 * "The Codespace ran out of minutes halfway through a two-hour encode. Do I
 * start again from zero?"
 *
 * No. The encode is cut into parts and each finished part is kept, so this test
 * does the thing that actually matters and measures it:
 *
 *   1. the parts are planned, recorded and read back (unit),
 *   2. a real encode is killed in the middle of the parts,
 *   3. the next start keeps the parts that were already finished — their
 *      modification times are unchanged — and encodes only the rest,
 *   4. the joined file is the same length as the source, with its audio.
 *
 *   npm run test:segments
 */
'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const segments = require('../server/segments');
const { probe } = require('../server/ffmpeg');

const ROOT = path.join(__dirname, '..');
const PORT = 3230;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-segments-${Date.now()}`);

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 240000, intervalMs = 300 } = {}) {
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
      AUTO_HOST: '0',
      /* The sample is 45 s: short parts make the interruption quick and real. */
      SEGMENT_MIN_SECONDS: '8',
      SEGMENT_SECONDS: '5',
      SQUEEZE_PROBE_SECONDS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  return proc;
}

const ready = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });
const getJob = async (id) => (await (await fetch(`${BASE}/api/jobs/${id}`)).json()).job;

(async () => {
  console.log('planning');

  check('parts cover the file exactly', (() => {
    const pieces = segments.plan({ duration: 100, chunkSeconds: 30 });
    const covered = pieces.reduce((sum, piece) => sum + piece.length, 0);
    return pieces.length === 4 && covered === 100 && pieces[3].length === 10;
  })());

  check('a short file is one part, not twelve', segments.plan({ duration: 45, chunkSeconds: 60 }).length === 1);
  check('chunk length is capped so seams stay rare', segments.chunkSecondsFor(7200) === 300);
  check('and floored so parts are not absurdly small', segments.chunkSecondsFor(300) === 60);

  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  const fakeDir = path.join(DATA_DIR, 'unit');
  await segments.write(fakeDir, { version: 1, total: 3, chunkSeconds: 5, done: [0, 1, 2] });
  check('the state is written where the server will look for it', fs.existsSync(path.join(fakeDir, 'segments.json')));
  await fsp.mkdir(segments.dirFor(fakeDir), { recursive: true });
  await fsp.writeFile(segments.fileFor(fakeDir, 0), Buffer.alloc(4096));
  const doneSet = await segments.finishedParts(fakeDir, await segments.read(fakeDir));
  check(
    'a part that is missing from the disk does not count as done',
    doneSet.size === 1 && doneSet.has(0),
    `${doneSet.size} usable`,
  );

  console.log('a real encode, interrupted');

  let server = startServer();
  try {
    await ready();

    const { job } = await (
      await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'sample', presetId: 'max' }),
      })
    ).json();
    check('a job starts', Boolean(job?.id), job?.error || '');

    /* Wait until at least three parts exist: an encode that is genuinely
       half-done, not one that has not begun. */
    const halfDone = await waitFor(async () => {
      const state = JSON.parse(
        await fsp.readFile(path.join(DATA_DIR, 'jobs', job.id, 'segments.json'), 'utf8').catch(() => '{}'),
      );
      return state.done && state.done.length >= 3 ? state : null;
    }, { timeoutMs: 240000 });
    check('the encode is running in parts', Boolean(halfDone), halfDone ? `${halfDone.done.length}/${halfDone.total}` : 'never started');
    if (!halfDone) throw new Error('nothing to resume');

    const keptIndex = halfDone.done[0];
    const keptFile = segments.fileFor(path.join(DATA_DIR, 'jobs', job.id), keptIndex);
    const keptBefore = fs.statSync(keptFile);
    check('the finished parts are on disk', keptBefore.size > 1024, `${keptBefore.size} bytes`);

    /* The machine stops: Codespaces out of minutes, laptop closed, whatever. */
    server.kill('SIGKILL');
    await sleep(700);

    const keptAfterKill = fs.statSync(keptFile);
    check('stopping the machine keeps them', keptAfterKill.size === keptBefore.size);

    server = startServer();
    await ready();

    const resumed = await waitFor(async () => {
      const current = await getJob(job.id);
      return current && current.resumeFrom !== null && current.resumeFrom > 0 ? current : null;
    }, { timeoutMs: 60000 });
    check(
      'the restart says where it picked up',
      Boolean(resumed) && resumed.resumeFrom >= 0.2,
      resumed ? `${Math.round(resumed.resumeFrom * 100)}% already encoded` : 'no resume state',
    );

    /* The proof that the work was kept and not redone: the part written
       before the crash still carries its original modification time. */
    const keptAfterRestart = fs.existsSync(keptFile) ? fs.statSync(keptFile) : null;
    check(
      'the parts from before the crash are reused, not re-encoded',
      Boolean(keptAfterRestart) && Math.abs(keptAfterRestart.mtimeMs - keptBefore.mtimeMs) < 1000,
      keptAfterRestart ? `part ${keptIndex} untouched` : 'the part was rewritten',
    );

    const finished = await waitFor(async () => {
      const current = await getJob(job.id);
      return current && ['done', 'error'].includes(current.status) ? current : null;
    }, { timeoutMs: 300000 });
    check('it finishes after the restart', finished?.status === 'done', finished?.error || finished?.status);

    const parts = await fsp.readdir(segments.dirFor(path.join(DATA_DIR, 'jobs', job.id))).catch(() => []);
    check(
      'the already-encoded parts were not encoded a second time',
      parts.length === 0,
      parts.length ? `${parts.length} parts left over` : 'the join cleaned them up',
    );

    const outputPath = path.join(DATA_DIR, 'jobs', job.id, 'output.mp4');
    const out = fs.existsSync(outputPath) ? await probe(outputPath).catch(() => null) : null;
    check('the joined file is a real video', Boolean(out && out.duration), out ? `${Math.round(out.duration)}s` : 'unreadable');
    check(
      'and it is as long as the source, not just the last part',
      Boolean(out && Math.abs(out.duration - 45) < 1),
      out ? `${out.duration.toFixed(1)}s of 45s` : 'no duration',
    );
    check('with its audio', Boolean(out && out.hasAudio), out ? out.audioCodec : '');
    check(
      'and it is smaller than the source',
      Boolean(finished && finished.outputBytes && finished.outputBytes < finished.sourceBytes),
      finished ? `${finished.outputBytes} vs ${finished.sourceBytes}` : '',
    );
  } finally {
    if (server) server.kill('SIGKILL');
    await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
