'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const UPLOADS_DIR = path.join(TMP_DIR, 'uploads');

const MAX_AGE_MS = 3 * 60 * 60 * 1000; // finished jobs are cleared after 3h
const STORE_PATH = path.join(DATA_DIR, 'jobs.json');
const MAX_RECORDS = 300;

/** @type {Map<string, any>} */
const jobs = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(0);

async function init() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });

  // Restore job records (and their hosted links) from the previous run.
  const raw = await fsp.readFile(STORE_PATH, 'utf8').catch(() => null);
  if (raw) {
    try {
      for (const record of JSON.parse(raw)) {
        if (!record || !record.id) continue;
        const job = { ...record, dir: path.join(JOBS_DIR, record.id), abort: null };
        // Anything mid-flight when the process died is not running now.
        if (!['done', 'hosted', 'error'].includes(job.status)) {
          const wasDoing = job.status;
          job.interrupted = true;
          job.interruptedFrom = wasDoing;
          job.status = 'error';
          /* Stopped during the upload: the encode is finished and its MP4 is on
             disk, so there is nothing left but the upload. (This used to test
             job.status after overwriting it with "error", so it never fired.) */
          if (wasDoing === 'hosting' && fs.existsSync(path.join(job.dir, 'output.mp4'))) {
            job.status = 'done';
            job.stage = 'Ready (upload interrupted)';
            job.error = null;
            job.hostError = 'The upload was interrupted when the machine stopped. It is retried automatically.';
          } else {
            job.stage = 'Interrupted';
            job.error =
              'The machine stopped before this finished. It is picked up again automatically when the server starts.';
          }
        }
        jobs.set(job.id, job);
      }
    } catch {
      /* corrupt store: start clean */
    }
  }

  // Remove working files from jobs that are too old (kept for their links).
  const now = Date.now();
  const entries = await fsp.readdir(JOBS_DIR).catch(() => []);
  for (const name of entries) {
    const job = jobs.get(name);
    if (!job || now - job.createdAt > MAX_AGE_MS) {
      await fsp.rm(path.join(JOBS_DIR, name), { recursive: true, force: true }).catch(() => {});
      if (job) jobs.delete(name);
    }
  }
}

let persistTimer = null;

async function writeStore() {
  const records = [...jobs.values()]
    .filter((job) => job.status !== 'queued' || job.sourceBytes)
    .slice(-MAX_RECORDS)
    .map((job) => {
      const { abort, ...rest } = job; // eslint-disable-line no-unused-vars
      return rest;
    });
  const tmp = `${STORE_PATH}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(records));
    await fsp.rename(tmp, STORE_PATH);
  } catch {
    /* disk full or race: the in-memory index is still correct */
  }
}

/** Write the job index to disk (debounced, atomic). */
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeStore();
  }, 400);
  if (persistTimer.unref) persistTimer.unref();
}

/** Write immediately — used for terminal states so a crash cannot lose a link. */
function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return writeStore();
}

function createJob(fields = {}) {
  const id = crypto.randomBytes(6).toString('base64url');
  const job = {
    id,
    createdAt: Date.now(),
    status: 'queued', // queued | fetching | awaiting-upload | uploading | compressing | done | error
    stage: 'Queued',
    progress: 0,
    speed: null,
    etaSeconds: null,
    source: fields.source || 'upload', // upload | url | ytdlp | sample | relay
    url: fields.url || null,
    name: fields.name || null,
    presetId: fields.presetId || 'balanced',
    targetMb: fields.targetMb || null,
    /* "Just download": fetch the file and hand it back untouched, no encode. */
    noCompress: Boolean(fields.noCompress),
    ref: fields.ref || null,
    /* Preferred upload hosts for this job, in order; empty means the server's
       default chain. */
    hostOrder: Array.isArray(fields.hostOrder) ? fields.hostOrder.slice(0, 6) : [],
    sourceBytes: 0,
    outputBytes: 0,
    meta: null,
    outputName: null,
    note: null,
    error: null,
  };
  job.dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(job.dir, { recursive: true });
  jobs.set(id, job);
  persist();
  return job;
}

const getJob = (id) => jobs.get(id) || null;

const TERMINAL = new Set(['done', 'hosted', 'error']);

function updateJob(job, patch) {
  Object.assign(job, patch);
  bus.emit('update', job);
  // A share link or a failure must survive an immediate crash.
  if (patch.status && TERMINAL.has(patch.status)) persistNow();
  else persist();
}

/** Recent jobs, newest first. */
function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function jobPaths(job) {
  return {
    dir: job.dir,
    source: path.join(job.dir, 'source'),
    output: path.join(job.dir, 'output.mp4'),
    thumb: path.join(job.dir, 'thumb.jpg'),
  };
}

const jobsStorePath = (job) => path.join(job.dir, 'output.mp4');

/* The server knows how a finished file will be named; jobs.js does not, and
   duplicating that rule here would drift. The server installs a hook instead. */
let viewHook = null;

function setViewHook(fn) {
  viewHook = typeof fn === 'function' ? fn : null;
}

function publicView(job) {
  const view = {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: Math.round(job.progress * 1000) / 1000,
    speed: job.speed,
    etaSeconds: job.etaSeconds,
    source: job.source,
    url: job.url,
    resolver: job.ref ? job.ref.resolver : null,
    name: job.name,
    presetId: job.presetId,
    targetMb: job.targetMb,
    sourceBytes: job.sourceBytes,
    outputBytes: job.outputBytes,
    meta: job.meta,
    outputName: job.outputName,
    saved: job.saved ?? null,
    audioMode: job.audioMode || null,
    twoPass: Boolean(job.twoPass),
    scaledTo: job.scaledTo || null,
    outputSize: job.outputSize || null,
    usedOriginal: Boolean(job.usedOriginal),
    noCompress: Boolean(job.noCompress),
    localDeleted: Boolean(job.localDeleted),
    downloadSpeed: job.downloadSpeed || null,
    downloadEta: job.downloadEta || null,
    projection: job.projection || null,
    hostedUrl: job.hostedUrl || null,
    hostProvider: job.hostProvider || null,
    hostError: job.hostError || null,
    hostedBy: job.hostedBy || null,
    note: job.note,
    error: job.error,
    hasThumb: fs.existsSync(path.join(job.dir, 'thumb.jpg')),
    hasFile:
      ['done', 'hosting', 'hosted'].includes(job.status) && fs.existsSync(jobsStorePath(job)),
    hosting: Boolean(job.hosting),
    /* True once the queue picked this up after the machine stopped. */
    resumed: Boolean(job.resumed),
  };
  if (viewHook) {
    try {
      Object.assign(view, viewHook(job) || {});
    } catch {
      /* a view hook must never break a status update */
    }
  }
  return view;
}

async function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  jobs.delete(id);
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  return true;
}

const HOSTED_RECORD_MS = 30 * 24 * 60 * 60 * 1000; // a share link stays useful for a month

function sweep() {
  const now = Date.now();
  for (const job of jobs.values()) {
    const age = now - job.createdAt;

    if (job.hostedUrl) {
      // The file lives on the host now, so only the local copy is expendable.
      if (age > HOSTED_RECORD_MS) removeJob(job.id);
      else if (age > 30 * 60 * 1000) {
        fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      }
      continue;
    }

    const finished = job.status === 'done' || job.status === 'error';
    if (age > MAX_AGE_MS || (finished && age > 45 * 60 * 1000)) {
      removeJob(job.id);
    }
  }
  persist();
}

setInterval(sweep, 10 * 60 * 1000).unref();

module.exports = {
  setViewHook,
  bus,
  DATA_DIR,
  JOBS_DIR,
  TMP_DIR,
  UPLOADS_DIR,
  init,
  createJob,
  getJob,
  updateJob,
  listJobs,
  persist,
  persistNow,
  jobPaths,
  publicView,
  removeJob,
};
