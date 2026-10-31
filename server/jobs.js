'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

const MAX_AGE_MS = 3 * 60 * 60 * 1000; // finished jobs are cleared after 3h

/** @type {Map<string, any>} */
const jobs = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(0);

async function init() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  // Nothing survives a restart, so clear out stale working files.
  const entries = await fsp.readdir(JOBS_DIR).catch(() => []);
  await Promise.all(
    entries.map((name) => fsp.rm(path.join(JOBS_DIR, name), { recursive: true, force: true })),
  );
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
    ref: fields.ref || null,
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
  return job;
}

const getJob = (id) => jobs.get(id) || null;

function updateJob(job, patch) {
  Object.assign(job, patch);
  bus.emit('update', job);
}

function jobPaths(job) {
  return {
    dir: job.dir,
    source: path.join(job.dir, 'source'),
    output: path.join(job.dir, 'output.mp4'),
    thumb: path.join(job.dir, 'thumb.jpg'),
  };
}

function publicView(job) {
  const paths = jobPaths(job);
  return {
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
    note: job.note,
    error: job.error,
    hasThumb: fs.existsSync(paths.thumb),
    hasFile: job.status === 'done' && fs.existsSync(paths.output),
  };
}

async function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  jobs.delete(id);
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  return true;
}

function sweep() {
  const now = Date.now();
  for (const job of jobs.values()) {
    const age = now - job.createdAt;
    const finished = job.status === 'done' || job.status === 'error';
    if (age > MAX_AGE_MS || (finished && age > 45 * 60 * 1000)) {
      removeJob(job.id);
    }
  }
}

setInterval(sweep, 10 * 60 * 1000).unref();

module.exports = {
  bus,
  DATA_DIR,
  JOBS_DIR,
  TMP_DIR,
  init,
  createJob,
  getJob,
  updateJob,
  jobPaths,
  publicView,
  removeJob,
};
