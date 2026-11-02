'use strict';
/**
 * What is on the disk, what it belongs to, and what may be deleted.
 *
 * The header used to show one number — free space — which answers "will the
 * next job fit" and nothing else. When a Codespace reports 12 GB free and the
 * user has one 4 GB video in it, the useful questions are different: *which*
 * files are those, can I have them, and can I get rid of them? This module
 * answers those, and it is the only place that decides what is safe to delete.
 *
 * The rules are deliberately conservative, because every file here is either
 * the user's video or the only copy of it:
 *
 *   - a file being written or read by a running job is never deleted;
 *   - a compressed file with no share link is the *only* copy — it needs
 *     `force` before it goes;
 *   - a job pinned by the user outlives the automatic sweep.
 *
 * Sizes come from the filesystem, not from the job records: a job that claims
 * 4 GB and has 0 bytes on disk should say 0.
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');

/* statuses where a file is open, being written, or about to be */
const ACTIVE = new Set(['queued', 'fetching', 'uploading', 'awaiting-upload', 'compressing', 'hosting']);

const PARTS = {
  source: { label: 'Original download', kind: 'source' },
  output: { label: 'Compressed result', kind: 'output' },
  parts: { label: 'Encoded parts (resume cache)', kind: 'parts' },
  thumb: { label: 'Thumbnail', kind: 'thumb' },
};

/* Walking node_modules takes half a second, and the panel refreshes itself —
   never make the page wait for a number that has not changed. Anything this
   module deletes invalidates the cache immediately. */
const REPORT_TTL_MS = 2500;
const STATIC_TTL_MS = 5 * 60 * 1000;
const reportCache = new Map();
let staticCache = null;

function invalidate() {
  reportCache.clear();
  /* Only the project/home sizes are cached across reports; deleting a job file
     does not change them. */
}

async function fileSize(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += await fileSize(full);
  }
  return total;
}

/** Is the original download whole? A truncated MP4 is not offered. */
function sourceWhole(job, bytes) {
  const total = Number(job.downloadTotal) || 0;
  if (!bytes) return false;
  if (total > 0) return bytes >= total;
  return !ACTIVE.has(job.status);
}

/** Every file of one job that is big enough to matter, with its size. */
async function jobFiles(job, paths) {
  const rows = [];
  const source = await fileSize(paths.source);
  if (source) {
    const whole = sourceWhole(job, source);
    rows.push({
      part: 'source',
      label: PARTS.source.label,
      bytes: source,
      /* Half a video is not a download: the link appears when the last byte
         lands, and the note says why it is not there yet. */
      download: whole ? `/api/jobs/${job.id}/original/${encodeURIComponent(job.name || 'original.mp4')}` : null,
      note: whole
        ? job.noCompress
          ? 'this is the file that will be delivered'
          : 'kept so a resume does not download it again'
        : 'still downloading — the download starts when it is complete',
    });
  }
  const output = await fileSize(paths.output);
  if (output) {
    rows.push({
      part: 'output',
      label: PARTS.output.label,
      bytes: output,
      download: `/api/jobs/${job.id}/download/${encodeURIComponent(path.basename(paths.output))}`,
      note: job.hostedUrl ? 'also uploaded — this copy is a spare' : 'the only copy until it is uploaded',
    });
  }
  const parts = await dirSize(path.join(paths.dir, 'segments'));
  if (parts) {
    const state = await fsp.readFile(path.join(paths.dir, 'segments.json'), 'utf8').catch(() => null);
    let done = 0;
    let total = 0;
    try {
      const parsed = state ? JSON.parse(state) : null;
      done = Array.isArray(parsed?.done) ? parsed.done.length : 0;
      total = Number(parsed?.total) || 0;
    } catch {
      /* the size is what matters here */
    }
    rows.push({
      part: 'parts',
      label: PARTS.parts.label,
      bytes: parts,
      download: null,
      note: total ? `${done} of ${total} parts finished — deleting them means encoding those again` : 'deleting them means encoding again',
    });
  }
  const thumb = await fileSize(paths.thumb);
  if (thumb) {
    rows.push({
      part: 'thumb',
      label: PARTS.thumb.label,
      bytes: thumb,
      download: `/api/jobs/${job.id}/thumb.jpg`,
      note: 'a still frame',
    });
  }
  return rows;
}

/**
 * The whole picture: the machine, this app, every job, and the other things
 * that take up room (the project, the browser, npm's cache).
 */
async function describe({ dataDir, jobsStore, projectRoot }) {
  const now = Date.now();
  const cached = reportCache.get(dataDir);
  if (cached && now - cached.at < REPORT_TTL_MS) return { ...cached.report, cached: true };

  const stat = await fsp.statfs(dataDir).catch(() => fsp.statfs(projectRoot));
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bavail * stat.bsize;

  const jobs = [];
  for (const job of jobsStore.listJobs()) {
    const paths = jobsStore.jobPaths(job);
    const files = await jobFiles(job, paths);
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const active = ACTIVE.has(job.status);
    /* A job that is working right now belongs in the list even before its first
       byte lands: "it is downloading and has 0 MB so far" is exactly what a
       person looking at a full disk wants to see. A finished job with nothing
       left on disk is just noise. */
    if (!bytes && !files.length && !active) continue;
    jobs.push({
      id: job.id,
      name: job.name || job.outputName || 'Video',
      status: job.status,
      stage: job.stage || null,
      createdAt: job.createdAt,
      hostedUrl: job.hostedUrl || null,
      hostProvider: job.hostProvider || null,
      pinLocal: Boolean(job.pinLocal),
      active,
      bytes,
      files,
      /* What happens to this on its own, so nothing disappears by surprise. */
      autoDeletesInSeconds: autoDeleteIn(job),
    });
  }
  jobs.sort((a, b) => b.bytes - a.bytes);

  const tmpBytes = await dirSize(path.join(dataDir, 'tmp'));
  /* The sample clip counts even while it is still being built: that file is
     several hundred MB for a while, and a panel that hides it is lying about
     where the space went. */
  let sampleTotal = 0;
  for (const name of await fsp.readdir(dataDir).catch(() => [])) {
    if (/^sample.*\.mp4$/.test(name)) sampleTotal += await fileSize(path.join(dataDir, name));
  }
  const recordsBytes =
    (await fileSize(path.join(dataDir, 'jobs.json'))) +
    (await fileSize(path.join(dataDir, 'links.tsv'))) +
    (await fileSize(path.join(dataDir, 'usage.json')));
  const dataBytes = await dirSize(dataDir);

  const home = process.env.HOME || '/home';
  /* node_modules is the project; the browser and npm's cache live in the home
     directory and are not part of it. Counting them separately keeps the rows
     adding up to the machine's used space instead of overlapping.
     These change when someone runs npm install, not while a video encodes, so
     they are measured once every few minutes. */
  let statics = staticCache;
  if (!statics || Date.now() - statics.at > STATIC_TTL_MS) {
    const projectRows = [];
    const nodeModules = path.join(projectRoot, 'node_modules');
    if (fs.existsSync(nodeModules)) {
      projectRows.push({ label: 'Project (node_modules, ffmpeg)', bytes: await dirSize(nodeModules), kind: 'project' });
    }
    const homeRows = [];
    for (const [label, dir] of [
      ['Headless browser (playwright)', path.join(home, '.cache/ms-playwright')],
      ['npm cache', path.join(home, '.npm')],
    ]) {
      if (!fs.existsSync(dir)) continue;
      homeRows.push({ label, bytes: await dirSize(dir), kind: 'home', deletable: false });
    }
    statics = { at: Date.now(), projectRows, homeRows };
    staticCache = statics;
  }
  const { projectRows, homeRows } = statics;
  const extras = [...projectRows, ...homeRows].filter((item) => item.bytes > 0);
  const projectBytes = projectRows.reduce((sum, item) => sum + item.bytes, 0);
  const homeBytes = homeRows.reduce((sum, item) => sum + item.bytes, 0);

  const jobsBytes = jobs.reduce((sum, job) => sum + job.bytes, 0);
  const otherBytes = Math.max(0, dataBytes - jobsBytes);

  return {
    disk: {
      totalBytes,
      freeBytes,
      usedBytes: totalBytes - freeBytes,
      percentFree: totalBytes ? Math.round((freeBytes / totalBytes) * 100) : null,
    },
    totals: {
      dataBytes,
      jobsBytes,
      otherDataBytes: otherBytes,
      projectBytes,
      homeBytes,
      extrasBytes: projectBytes + homeBytes,
      squeezeBytes: dataBytes,
      /* The OS, the editor, other checkouts: whatever is left once this app, the
         project and its caches are accounted for. Shown so the rows add up to
         "used" instead of leaving a number from nowhere. */
      restOfMachineBytes: Math.max(0, totalBytes - freeBytes - dataBytes - projectBytes - homeBytes),
    },
    breakdown: [
      { label: 'Videos (jobs)', bytes: jobsBytes, kind: 'jobs' },
      { label: 'Temp uploads', bytes: tmpBytes, kind: 'tmp', deletable: tmpBytes > 0 },
      { label: 'Sample clip', bytes: sampleTotal, kind: 'sample', deletable: sampleTotal > 0 },
      { label: 'Records (links, meter)', bytes: recordsBytes, kind: 'records', deletable: false },
      { label: 'Other data', bytes: Math.max(0, otherBytes - tmpBytes - sampleTotal - recordsBytes), kind: 'other', deletable: false },
    ].filter((row) => row.bytes > 0),
    jobs,
    extras,
    reclaimable: {
      finished: jobs.filter((job) => !job.active && ['done', 'hosted', 'error'].includes(job.status)).reduce((sum, job) => sum + job.bytes, 0),
      hosted: jobs.filter((job) => job.hostedUrl).reduce((sum, job) => sum + job.bytes, 0),
      tmp: tmpBytes,
      sample: sampleTotal,
    },
    limits: {
      /* The Codespace disk is 32 GB; a hosted job's local copy and the temp
         uploads are the parts that are safe to lose. */
      hostedLocalMinutes: Number(process.env.HOSTED_LOCAL_KEEP_MINUTES || 120),
      finishedMinutes: Number(process.env.FINISHED_KEEP_MINUTES || 180),
      unfinishedHours: Number(process.env.KEEP_UNFINISHED_HOURS || 24),
    },
    at: Date.now(),
    cached: false,
  };
  reportCache.set(dataDir, { at: Date.now(), report });
  return report;
}

/** When the sweeper will remove this job's files by itself (null: not yet known). */
function autoDeleteIn(job, at = Date.now()) {
  if (job.pinLocal) return null;
  if (ACTIVE.has(job.status)) return null;
  /* From when the file became ready, not from when the job was created: the
     sweeper uses the same rule, and a panel that promises the wrong deadline
     is worse than no deadline. */
  const since = job.hostedUrl
    ? Number(job.hostedAt) || Number(job.createdAt)
    : Number(job.createdAt);
  const start = since || at;
  const minutes = job.hostedUrl
    ? Number(process.env.HOSTED_LOCAL_KEEP_MINUTES || 120)
    : Number(process.env.FINISHED_KEEP_MINUTES || 180);
  const atMs = start + minutes * 60000;
  return Math.max(0, Math.round((atMs - at) / 1000));
}

/**
 * Delete one part of one job.
 * @returns {{ok: boolean, code?: string, message?: string, freed?: number}}
 */
async function deletePart({ jobsStore, job, part }) {
  if (!job) return { ok: false, code: 'NOT_FOUND', message: 'That job no longer exists.' };
  if (!PARTS[part]) return { ok: false, code: 'BAD_PART', message: `Unknown part "${part}".` };
  const paths = jobsStore.jobPaths(job);
  const active = ACTIVE.has(job.status);

  if (active && part !== 'thumb') {
    return {
      ok: false,
      code: 'IN_USE',
      message: `This file is being worked on right now (${job.stage || job.status}) — deleting it would break the job. Stop it first, or wait.`,
    };
  }

  let freed = 0;
  if (part === 'source') {
    freed = await fileSize(paths.source);
    await fsp.rm(paths.source, { force: true }).catch(() => {});
    job.localSourceDeleted = true;
  } else if (part === 'output') {
    /* The only copy, with no share link and nothing to fall back on: deleting
       it throws the video away. The page asks; this makes sure a stray call
       cannot do it by accident. */
    freed = await fileSize(paths.output);
    await fsp.rm(paths.output, { force: true }).catch(() => {});
    job.localDeleted = true;
  } else if (part === 'parts') {
    const dir = jobsStore.jobPaths(job).dir;
    freed = await dirSize(path.join(dir, 'segments'));
    await fsp.rm(path.join(dir, 'segments'), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(dir, 'segments.json'), { force: true }).catch(() => {});
  } else if (part === 'thumb') {
    freed = await fileSize(paths.thumb);
    await fsp.rm(paths.thumb, { force: true }).catch(() => {});
  }
  invalidate();
  return { ok: true, freed };
}

/**
 * Housekeeping in bulk.
 *
 * `what`:
 *   tmp       temp uploads only (never anything with a result)
 *   finished  files of finished jobs; an unhosted result needs `force`
 *   all       every job (needs `force`; running jobs are always skipped)
 */
async function clean({ dataDir, jobsStore, what = 'finished', force = false }) {
  const freed = { bytes: 0, jobs: 0 };
  const kept = [];

  if (what === 'tmp' || what === 'finished' || what === 'all') {
    const tmp = path.join(dataDir, 'tmp');
    const before = await dirSize(tmp);
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    freed.bytes += before;
  }

  if (what === 'finished' || what === 'all') {
    for (const job of jobsStore.listJobs()) {
      if (ACTIVE.has(job.status) && what !== 'all') continue;
      const finished = ['done', 'hosted', 'error'].includes(job.status);
      if (what === 'finished' && !finished) continue;
      if (ACTIVE.has(job.status)) {
        kept.push({ id: job.id, name: job.name, reason: 'still running' });
        continue;
      }
      if (job.pinLocal && !force) {
        kept.push({ id: job.id, name: job.name, reason: 'pinned' });
        continue;
      }
      const onlyCopy = job.status === 'done' && !job.hostedUrl;
      if (onlyCopy && !force) {
        /* Keep the result, drop the source: the compressed file is the one
           thing here that cannot be produced again without the original. */
        const result = await deletePart({ jobsStore, job, part: 'source' });
        const parts = await deletePart({ jobsStore, job, part: 'parts' });
        freed.bytes += (result.freed || 0) + (parts.freed || 0);
        kept.push({
          id: job.id,
          name: job.name,
          reason: 'the compressed file has no share link yet — kept, its source was removed',
        });
        continue;
      }
      const before = await dirSize(jobsStore.jobPaths(job).dir);
      jobsStore.removeJob(job.id);
      freed.jobs += 1;
      freed.bytes += before;
    }
  }

  invalidate();
  const after = await fsp.statfs(dataDir).catch(() => null);
  return {
    ok: true,
    freedBytes: freed.bytes,
    removedJobs: freed.jobs,
    kept,
    freeBytes: after ? after.bavail * after.bsize : null,
  };
}

module.exports = { describe, deletePart, clean, dirSize, fileSize, autoDeleteIn, invalidate, ACTIVE, PARTS };
