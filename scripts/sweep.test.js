#!/usr/bin/env node
/**
 * "A file treatment failed even it was close to finish."
 *
 * It failed at 91% with `ENOENT … segments/part-0011.mp4`, and the reason was
 * not the encoder: the sweeper deleted the job's directory because the job was
 * older than three hours — *while it was still encoding*. A 4K file on a 2-core
 * machine takes exactly that long, so the longer and more expensive a job was,
 * the more likely it was to be deleted out from under itself.
 *
 * This test pins the rule down with real directories and a real clock:
 *
 *   1. a job that is working is never swept, however old it is;
 *   2. a finished job is measured from when it finished, not when it began, so
 *      a six-hour encode is not deleted the minute it succeeds;
 *   3. an unfinished job keeps its files for a day (KEEP_UNFINISHED_HOURS);
 *   4. pinned files are never swept at all.
 *
 *   npm run test:sweep
 */
'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = path.join(os.tmpdir(), `squeeze-sweep-${Date.now()}`);
process.env.DATA_DIR = DATA_DIR;

const jobsStore = require('../server/jobs');

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : '  FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const HOUR = 60 * 60 * 1000;
const minutes = (value) => value * 60 * 1000;

/** A live job record with a source file in it, as a running job would have. */
function makeJob(fields, { bytes = 2048 } = {}) {
  const job = jobsStore.createJob(fields);
  fs.writeFileSync(path.join(job.dir, 'source'), Buffer.alloc(bytes, 1));
  return job;
}

const alive = (job) => fs.existsSync(job.dir);

(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await jobsStore.init();

  const now = Date.now();
  const ago = (ms) => now - ms;

  const jobs = {
    /* The bug: five hours in, still encoding a 4K file. */
    longrunning: makeJob({ source: 'url', url: 'https://example.test/a', name: '4K.mkv' }),
    queuedold: makeJob({ source: 'url', url: 'https://example.test/b', name: 'waiting.mp4' }),
    /* Finished ten minutes ago, after six hours of work: far too young to die. */
    justfinished: makeJob({ source: 'url', url: 'https://example.test/c', name: 'Done.mkv' }),
    /* Finished four hours ago. */
    oldfinished: makeJob({ source: 'url', url: 'https://example.test/d', name: 'Old.mkv' }),
    /* A crash two hours ago: the fragment and the parts are the point. */
    crashrecent: makeJob({ source: 'url', url: 'https://example.test/e', name: 'Crashed.mkv' }),
    /* A leftover from days ago: that one may go. */
    crashancient: makeJob({ source: 'url', url: 'https://example.test/f', name: 'Forgotten.mkv' }),
    /* Asked to keep it: never swept, however old. */
    pinned: makeJob({ source: 'url', url: 'https://example.test/g', name: 'Pinned.mkv' }),
  };

  Object.assign(jobs.longrunning, { status: 'compressing', createdAt: ago(5 * HOUR), progress: 91 });
  Object.assign(jobs.queuedold, { status: 'queued', createdAt: ago(9 * HOUR) });
  Object.assign(jobs.justfinished, { status: 'done', createdAt: ago(6 * HOUR), finishedAt: ago(minutes(10)) });
  Object.assign(jobs.oldfinished, { status: 'done', createdAt: ago(8 * HOUR), finishedAt: ago(4 * HOUR) });
  Object.assign(jobs.crashrecent, { status: 'error', interrupted: true, createdAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR) });
  Object.assign(jobs.crashancient, { status: 'error', interrupted: true, createdAt: ago(30 * HOUR), finishedAt: ago(30 * HOUR) });
  Object.assign(jobs.pinned, { status: 'done', pinLocal: true, createdAt: ago(72 * HOUR), finishedAt: ago(3 * HOUR) });

  jobsStore.sweep();
  /* Deletions are asynchronous; give them a tick to land. */
  await new Promise((resolve) => setTimeout(resolve, 100));

  check(
    'a job that is still encoding is never swept, however long it has been going',
    alive(jobs.longrunning),
    'its directory was deleted — this is the ENOENT that killed a 4K job at 91%',
  );
  check('a job still waiting in the queue is not swept either', alive(jobs.queuedold));
  check(
    'a job that finished after a six-hour encode is not swept the moment it finishes',
    alive(jobs.justfinished),
    'the deadline has to run from finishedAt, not from createdAt',
  );
  check('a job that finished long ago is swept', !alive(jobs.oldfinished));
  check(
    'a crash from two hours ago keeps its files, so "Try again" can carry on',
    alive(jobs.crashrecent),
  );
  check('a crash from a day and a half ago is cleaned up', !alive(jobs.crashancient));
  check('a pinned job is never swept', alive(jobs.pinned));

  /* Belt and braces: even if a job's status says "finished" while an encoder is
     still on it (a retry starting, a handler running), the server's list of
     running ids wins. This is the check that would have saved the two jobs that
     were deleted at 91% and 75% on a three-hour-old build. */
  const lying = makeJob({ source: 'url', url: 'https://example.test/h', name: 'Lying.mkv' });
  Object.assign(lying, { status: 'done', createdAt: ago(9 * HOUR), finishedAt: ago(5 * HOUR) });
  jobsStore.setBusyHook((id) => id === lying.id);
  jobsStore.sweep();
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    'a job with an encoder on it is kept even when its status says finished',
    alive(lying),
    'the busy hook was ignored',
  );
  jobsStore.setBusyHook(null);

  /* The guard is only as good as its list of busy statuses: a status that
     means "a file is open" but is missing from it is a deleted file waiting to
     happen. */
  const working = ['queued', 'fetching', 'uploading', 'awaiting-upload', 'compressing', 'hosting'];
  const missed = working.filter((status) => !jobsStore.ACTIVE.has(status));
  check(
    'every status that means "working on it" is protected from the sweeper',
    missed.length === 0,
    missed.length ? `not protected: ${missed.join(', ')}` : 'all six',
  );

  /* "Try again" is only offered when something survived to carry on from. */
  const broken = makeJob({ source: 'url', url: 'https://example.test/page', name: 'Broken.mkv' }, { bytes: 4096 });
  jobsStore.updateJob(broken, { status: 'error', error: 'The encoder stopped.' });
  check(
    'a failure that kept its source offers a retry',
    jobsStore.publicView(broken).canRetry === true,
    'canRetry was false while 4 KB of source was sitting on disk',
  );

  await fsp.rm(path.join(broken.dir, 'source'), { force: true });
  const noRetry = jobsStore.publicView(jobsStore.getJob(broken.id));
  check('a failure with nothing left does not pretend it can retry', noRetry.canRetry === false);
  check('and it still exists in the store for its error message', noRetry.status === 'error');

  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(async (err) => {
  console.error('sweep run crashed:', err);
  await fsp.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
