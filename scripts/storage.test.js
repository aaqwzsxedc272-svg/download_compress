#!/usr/bin/env node
/**
 * "Give me more power over the storage" — and "how much is left this month?".
 *
 * Both are things a person only asks about when they are *stuck*: a Codespace
 * with 0 GB free and no idea what is using it, or a machine that stopped at
 * 4 p.m. because the month's hours ran out. So this test does not check that a
 * panel exists; it checks the decisions behind it:
 *
 *   1. sizes come from the filesystem, and the rows add up to the machine;
 *   2. a running job's files cannot be deleted;
 *   3. the only copy of a video needs `force` — "Delete everything" cannot
 *      quietly throw away a video that has no share link;
 *   4. deleting frees the space and is reported honestly;
 *   5. the meter counts core-hours from a simulated month, rolls over on the
 *      1st, and survives a restart without crediting the gap;
 *   6. GB-months are an average, not a peak;
 *   7. the API refuses what it should refuse, with a reason a person can act on.
 *
 *   npm run test:storage
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3240;
const SOURCE_PORT = 3241;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `squeeze-storage-${Date.now()}`);

const storage = require('../server/storage');
const usageFactory = require('../server/usage');

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : '  FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 150 } = {}) {
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
      PORT: String(PORT),
      DATA_DIR,
      AUTO_HOST: '0',
      RESUME_INTERRUPTED: '0',
      ALLOW_PRIVATE_HOSTS: '1',
      HEARTBEAT_SECONDS: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    proc.stderrTail += chunk;
    if (proc.stderrTail.length > 4000) proc.stderrTail = proc.stderrTail.slice(-4000);
  });
  return proc;
}

const ready = () => waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, { timeoutMs: 30000 });

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

/**
 * The storage module only needs three things from the job store, so the pure
 * checks use a stand-in rather than a whole server: a file that is on disk is
 * what is being measured, not a record that claims to be.
 */
function fakeStore(records) {
  return {
    listJobs: () => records,
    getJob: (id) => records.find((job) => job.id === id) || null,
    jobPaths: (job) => ({
      dir: path.join(DATA_DIR, 'jobs', job.id),
      source: path.join(DATA_DIR, 'jobs', job.id, 'source'),
      output: path.join(DATA_DIR, 'jobs', job.id, 'output.mp4'),
      thumb: path.join(DATA_DIR, 'jobs', job.id, 'thumb.jpg'),
    }),
    removeJob: (id) => {
      const at = records.findIndex((job) => job.id === id);
      if (at !== -1) records.splice(at, 1);
      return true;
    },
  };
}

/** Make a fake job directory that looks exactly like a real one. */
async function makeJob(
  id,
  { status = 'hosted', source = 4 * 1024 ** 2, output = 1 * 1024 ** 2, parts = 0, hostedUrl = 'https://host.example/x', downloadTotal = null } = {},
) {
  const dir = path.join(DATA_DIR, 'jobs', id);
  await fsp.mkdir(path.join(dir, 'segments'), { recursive: true });
  if (source) await fsp.writeFile(path.join(dir, 'source'), Buffer.alloc(source, 1));
  if (output) await fsp.writeFile(path.join(dir, 'output.mp4'), Buffer.alloc(output, 2));
  if (parts) {
    await fsp.writeFile(path.join(dir, 'segments', 'part-0000.mp4'), Buffer.alloc(parts, 3));
    await fsp.writeFile(
      path.join(dir, 'segments.json'),
      JSON.stringify({ version: 1, total: 4, done: [0], crf: 23 }),
    );
  }
  return {
    id,
    createdAt: Date.now(),
    status,
    stage: 'Ready',
    progress: 1,
    source: 'url',
    url: 'https://example.test/page',
    name: `${id}.mp4`,
    presetId: 'auto',
    ...(downloadTotal ? { downloadTotal } : {}),
    sourceBytes: source,
    outputBytes: output,
    outputName: `${id} small.mp4`,
    hostedUrl,
    hostProvider: 'pixeldrain',
  };
}

/** Write records straight into jobs.json, the way a restart would find them. */
async function writeStore(records) {
  await fsp.writeFile(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(records));
}

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(path.join(DATA_DIR, 'jobs'), { recursive: true });
  await fsp.mkdir(path.join(DATA_DIR, 'tmp', 'uploads', 'abc'), { recursive: true });
  await fsp.writeFile(path.join(DATA_DIR, 'tmp', 'uploads', 'abc', 'blob'), Buffer.alloc(1024 * 1024, 7));
  await fsp.writeFile(path.join(DATA_DIR, 'copy of links.tsv'), 'x'.repeat(64));

  /* ---------------------------------------------------------- the meter --- */

  console.log('the meter (simulated months)');

  {
    const dir = path.join(DATA_DIR, 'meter');
    await fsp.mkdir(dir, { recursive: true });
    let clock = Date.UTC(2026, 10, 2, 9, 0, 0); // 2 Nov 2026, 09:00 UTC
    const meter = usageFactory.createMeter({ dataDir: dir, now: () => clock, cores: 2, log: () => {} });
    await meter.init();
    const start = meter.describe();
    check('a fresh month starts at zero', start.month.coreHours === 0 && start.month.percent === 0, String(start.month.coreHours));
    check('the default quota is GitHub Free', start.settings.quotaCoreHours === 120 && start.settings.quotaStorageGb === 15);

    /* One hour of a 2-core machine is 2 core-hours. */
    clock += 60 * 60 * 1000;
    meter.tick(0);
    check('an hour on 2 cores is 2 core-hours', Math.abs(meter.describe().month.coreHours - 2) < 0.01, String(meter.describe().month.coreHours));

    /* Ten days in, still 2 core-hours: `machineHoursLeft` is what the user
       actually reads, and it must not be confused with core-hours. */
    check(
      'the machine-hours left is core-hours divided by cores',
      Math.abs(meter.describe().month.machineHoursLeft - 59) < 0.01,
      String(meter.describe().month.machineHoursLeft),
    );

    /* Eight hours of holding 4 GB: 4 GB × 8 h = 32 GB-hours = 0.0444 GB-months
       in November (720 h). A panel that reported the *current* size would say
       4.00 GB-months and look full immediately. */
    clock += 8 * 60 * 60 * 1000;
    meter.tick(4 * 1024 ** 3);
    const afterStorage = meter.describe();
    check(
      'GB-months are an average over the month, not the current size',
      afterStorage.storage.gbMonths > 0.02 && afterStorage.storage.gbMonths < 0.1,
      `${afterStorage.storage.gbMonths} GB-months`,
    );
    check('the current size is still reported as is', afterStorage.storage.bytesNow === 4 * 1024 ** 3, String(afterStorage.storage.bytesNow));

    /* The 1st of the next month: the meter resets and keeps last month in
       history, because "what did I use" is a question people ask. */
    clock = Date.UTC(2026, 11, 1, 0, 5, 0);
    meter.tick(0);
    const december = meter.describe();
    check('the month rolls over on the 1st', december.month.key === '2026-12', december.month.key);
    check('and the allowance is whole again', december.month.coreHours === 0 && december.month.remainingCoreHours === 120);
    check('the finished month is kept in history', december.history.some((row) => row.month === '2026-11'), JSON.stringify(december.history));

    /* A restart must not credit the hours the app was not running: the gap
       between the last tick of one process and the first of the next is
       unknown, and guessing it high would make the allowance look spent. */
    meter.tick(0); // the last thing the first process does
    clock += 6 * 60 * 60 * 1000; // six hours with nobody measuring
    const restarted = usageFactory.createMeter({ dataDir: dir, now: () => clock, cores: 2, log: () => {} });
    await restarted.init();
    restarted.tick(0); // the first tick of the new process
    check(
      'a restart does not credit the time it was not running',
      restarted.describe().month.coreHours < 0.1,
      `${restarted.describe().month.coreHours} core-hours after a 6 h gap`,
    );
    /* And it does credit the time it *is* running. */
    clock += 60 * 60 * 1000;
    restarted.tick(0);
    check(
      'but it does credit the time it is running',
      Math.abs(restarted.describe().month.coreHours - 2) < 0.01,
      String(restarted.describe().month.coreHours),
    );

    /* Settings are a thing a person sets, and the quota follows the plan. */
    await restarted.setSettings({ plan: 'pro' });
    check('choosing Pro raises the quota to 180', restarted.describe().settings.quotaCoreHours === 180);
    await restarted.setSettings({ coreHours: 300 });
    const custom = restarted.describe().settings;
    check('a custom quota is respected and marked custom', custom.plan === 'custom' && custom.quotaCoreHours === 300, JSON.stringify(custom.plan));
    check('the plan list is offered for the select', restarted.describe().settings.plans.length === 3);
  }

  /* --------------------------------------------------------- the storage --- */

  console.log('\nwhat is on the disk');

  const records = [
    await makeJob('big', { status: 'hosted', source: 6 * 1024 ** 2, output: 2 * 1024 ** 2 }),
    await makeJob('working', { status: 'compressing', source: 3 * 1024 ** 2, output: 0, parts: 1024 ** 2, hostedUrl: null }),
    await makeJob('unhosted', { status: 'done', source: 2 * 1024 ** 2, output: 1024 ** 2, hostedUrl: null }),
    await makeJob('failed', { status: 'error', source: 1024 ** 2, output: 0, hostedUrl: null }),
    /* A download that is only half way: 1 MB on disk of a 4 MB file. */
    await makeJob('partial', {
      status: 'fetching',
      source: 1024 ** 2,
      output: 0,
      hostedUrl: null,
      downloadTotal: 4 * 1024 ** 2,
    }),
  ];
  await writeStore(records);
  const jobsStore = fakeStore(records);

  const report = await storage.describe({ dataDir: DATA_DIR, jobsStore, projectRoot: ROOT });

  check('every job with files is listed', report.jobs.length === records.length, `${report.jobs.length} of ${records.length}`);
  const big = report.jobs.find((job) => job.id === 'big');
  check('a job reports its source and its result separately', big.files.length === 2, big.files.map((f) => f.part).join(','));
  check('the bytes match the files on disk', big.bytes === 8 * 1024 ** 2, String(big.bytes));
  const working = report.jobs.find((job) => job.id === 'working');
  check('a running job is marked as in use', working.active === true);
  check('its encoded parts are counted too', working.files.some((file) => file.part === 'parts' && file.bytes === 1024 ** 2));
  check(
    'the parts say what deleting them would cost',
    /encoding/.test(working.files.find((file) => file.part === 'parts').note || ''),
    working.files.find((file) => file.part === 'parts').note,
  );

  const tmpRow = report.breakdown.find((row) => row.kind === 'tmp');
  check('temp uploads are a row of their own', Boolean(tmpRow) && tmpRow.bytes >= 1024 * 1024, tmpRow ? String(tmpRow.bytes) : 'missing');
  check('the temp uploads are reclaimable', report.reclaimable.tmp >= 1024 * 1024);

  const used = report.disk.usedBytes;
  const accounted = report.totals.dataBytes + report.totals.projectBytes + report.totals.homeBytes + report.totals.restOfMachineBytes;
  check(
    'the rows add up to the space the machine says is used',
    Math.abs(used - accounted) <= 1,
    `${used} vs ${accounted}`,
  );
  check('the project is counted once, not twice', report.totals.projectBytes > 0 && report.extras.filter((e) => /node_modules/.test(e.label)).length === 1);
  check(
    'an unhosted result is described as the only copy',
    /only copy/.test(big.files.find((f) => f.part === 'output').note || '') === false &&
      /only copy/.test(report.jobs.find((j) => j.id === 'unhosted').files.find((f) => f.part === 'output').note || ''),
    report.jobs.find((j) => j.id === 'unhosted').files.find((f) => f.part === 'output').note,
  );
  const partial = report.jobs.find((job) => job.id === 'partial');
  check(
    'half a download gets no download link',
    Boolean(partial) && partial.files.find((file) => file.part === 'source').download === null,
    JSON.stringify(partial && partial.files.find((file) => file.part === 'source')),
  );
  check(
    'and says why it is not there yet',
    /still downloading/.test(partial.files.find((file) => file.part === 'source').note || ''),
    partial.files.find((file) => file.part === 'source').note,
  );
  check(
    'a whole download does get one',
    Boolean(report.jobs.find((job) => job.id === 'big').files.find((file) => file.part === 'source').download),
  );
  check(
    'a hosted copy is described as a spare',
    /spare/.test(big.files.find((f) => f.part === 'output').note || ''),
    big.files.find((f) => f.part === 'output').note,
  );

  /* ------------------------------------------------------------ deleting --- */

  console.log('\ndeleting, and what is never deleted');

  const refused = await storage.deletePart({ jobsStore, job: jobsStore.getJob('working'), part: 'source' });
  check('a running job refuses to lose its source', refused.ok === false && refused.code === 'IN_USE', refused.message);
  check('and says why in words a person can act on', /being worked on/.test(refused.message || ''), refused.message);
  check('the source is still there', fs.existsSync(path.join(DATA_DIR, 'jobs', 'working', 'source')));

  const thumbRefused = await storage.deletePart({ jobsStore, job: jobsStore.getJob('working'), part: 'thumb' });
  check('a thumbnail is cheap to lose, so it is allowed', thumbRefused.ok === true);

  const badPart = await storage.deletePart({ jobsStore, job: jobsStore.getJob('big'), part: 'everything' });
  check('an unknown part is refused', badPart.ok === false && badPart.code === 'BAD_PART');

  const before = fs.statSync(path.join(DATA_DIR, 'jobs', 'big', 'source')).size;
  const sourceGone = await storage.deletePart({ jobsStore, job: jobsStore.getJob('big'), part: 'source' });
  check('deleting a source frees exactly its size', sourceGone.freed === before, `${sourceGone.freed} vs ${before}`);
  check('and the file is gone', !fs.existsSync(path.join(DATA_DIR, 'jobs', 'big', 'source')));
  check('the result is untouched', fs.existsSync(path.join(DATA_DIR, 'jobs', 'big', 'output.mp4')));

  /* A pinned job must survive the bulk clean, whatever its status. */
  records.find((job) => job.id === 'big').pinLocal = true;

  /* Cleaning "finished" must keep the only copy of a video. */
  const cleaned = await storage.clean({ dataDir: DATA_DIR, jobsStore, what: 'finished' });
  check('cleaning finished jobs frees space', cleaned.freedBytes > 0, String(cleaned.freedBytes));
  check(
    'the unhosted result is kept when it has no share link',
    fs.existsSync(path.join(DATA_DIR, 'jobs', 'unhosted', 'output.mp4')),
    'its only copy was deleted',
  );
  check(
    'its source is removed instead',
    !fs.existsSync(path.join(DATA_DIR, 'jobs', 'unhosted', 'source')),
  );
  check(
    'the reason is reported, not silent',
    cleaned.kept.some((job) => job.id === 'unhosted' && /share link/.test(job.reason)),
    JSON.stringify(cleaned.kept),
  );
  check('temp uploads are gone', !fs.existsSync(path.join(DATA_DIR, 'tmp', 'uploads')));
  check('a running job is never touched by a clean', fs.existsSync(path.join(DATA_DIR, 'jobs', 'working', 'source')));

  check('a pinned job is kept by the clean', fs.existsSync(path.join(DATA_DIR, 'jobs', 'big', 'output.mp4')));
  check(
    'and is listed as kept because it is pinned',
    cleaned.kept.some((job) => job.id === 'big' && job.reason === 'pinned'),
    JSON.stringify(cleaned.kept),
  );

  /* --------------------------------------------------------------- HTTP --- */

  console.log('\nthe endpoints the page calls');

  /* A host that keeps a download open, so there is a genuinely running job to
     try to delete. A record in jobs.json is not the same thing: on startup it
     is marked interrupted, and then it is not running any more. */
  const trickle = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/slow.mp4')) return res.writeHead(404).end();
    const size = 30 * 1024 * 1024;
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'content-disposition': 'attachment; filename="slow.mp4"',
    });
    for (let sent = 0; sent < size && !res.destroyed; sent += 256 * 1024) {
      res.write(Buffer.alloc(256 * 1024, 1));
      await sleep(60);
    }
    res.end();
  });
  await new Promise((resolve) => trickle.listen(SOURCE_PORT, '127.0.0.1', resolve));

  let server = startServer();
  try {
    await ready();

    const api = await json(`${BASE}/api/storage`);
    check('GET /api/storage answers', api.ok, String(api.status));
    check('with the disk, the jobs and the meter together', Boolean(api.body.disk && api.body.jobs && api.body.usage), Object.keys(api.body).join(','));
    check('the panel has a file row per job file', api.body.jobs.every((job) => Array.isArray(job.files)));

    const usage = await json(`${BASE}/api/usage`);
    check('GET /api/usage answers', usage.ok);
    check('and admits where it comes from', usage.body.usage.meter.source === 'local' && /not a reading/.test(usage.body.usage.meter.note), usage.body.usage.meter.note.slice(0, 60));
    check('the session is being measured', usage.body.usage.session.elapsedSeconds >= 0 && usage.body.usage.month.quotaCoreHours === 120);

    const started = await json(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${SOURCE_PORT}/slow.mp4`, presetId: 'small', source: 'url' }),
    });
    const runningId = started.body.job?.id;
    const active = await waitFor(async () => {
      const job = await json(`${BASE}/api/jobs/${runningId}`);
      return job.body.job && ['fetching', 'compressing', 'queued'].includes(job.body.job.status) ? job.body.job : null;
    }, { timeoutMs: 20000 });
    check('a job is really running for the next check', Boolean(active), active?.status || 'never started');

    const denied = await json(`${BASE}/api/storage/jobs/${runningId}/source`, { method: 'DELETE' });
    check(
      'a running job cannot be deleted through the API',
      denied.status === 409 && denied.body.code === 'IN_USE',
      `${denied.status} ${denied.body.code}`,
    );
    check(
      'and the answer explains what to do instead',
      /being worked on|wait/i.test(denied.body.error || ''),
      denied.body.error,
    );
    /* The running job shows up in the report as in use, which is what the panel
       greys out. */
    const live = await json(`${BASE}/api/storage`);
    check(
      'the panel is told which job is in use',
      live.body.jobs.some((job) => job.id === runningId && job.active === true),
      JSON.stringify(live.body.jobs.map((job) => `${job.id}:${job.active}`)),
    );

    const removed = await json(`${BASE}/api/storage/jobs/${'unhosted'}/output`, { method: 'DELETE' });
    check('a real delete through the API works', removed.ok && removed.body.freedBytes > 0, JSON.stringify(removed.body.freedBytes));
    check('and the file is really gone', !fs.existsSync(path.join(DATA_DIR, 'jobs', 'unhosted', 'output.mp4')));

    const noForce = await json(`${BASE}/api/storage/clean`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ what: 'all' }),
    });
    check('"delete everything" without force is refused', noForce.status === 400 && noForce.body.code === 'NEED_FORCE', `${noForce.status}`);

    const pinnedApi = await json(`${BASE}/api/jobs/big/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    });
    check('a job can be unpinned through the API', pinnedApi.ok && pinnedApi.body.job.pinLocal === false);

    const settings = await json(`${BASE}/api/usage/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    check('the plan can be set from the page', settings.ok && settings.body.usage.settings.quotaCoreHours === 180, String(settings.body.usage?.settings?.quotaCoreHours));

    /* The meter's file is the thing that survives a restart. */
    server.kill('SIGKILL');
    await sleep(500);
    server = startServer();
    await ready();
    const afterRestart = await json(`${BASE}/api/usage`);
    check(
      'the quota and the month survive a restart',
      afterRestart.body.usage.settings.quotaCoreHours === 180 && afterRestart.body.usage.month.key === usage.body.usage.month.key,
      `${afterRestart.body.usage.settings.quotaCoreHours} · ${afterRestart.body.usage.month.key}`,
    );
    check('and the sessions are counted', afterRestart.body.usage.month.sessions >= 2, String(afterRestart.body.usage.month.sessions));
  } finally {
    if (server) server.kill('SIGKILL');
  }

  /* The page itself is in ui.test.js: this test is about the decisions. */
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
