'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const express = require('express');

const jobsStore = require('./jobs');
const { probe, thumbnail, transcode } = require('./ffmpeg');
const { PRESET_LIST, getPreset, buildArgs, targetTooSmall } = require('./compress');
const sources = require('./sources');
const { ensureSample } = require('./sample');

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 2048;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ helpers */

const relayTokens = new Map(); // token -> expiry

function newRelayToken() {
  const token = crypto.randomBytes(18).toString('base64url');
  relayTokens.set(token, Date.now() + 3 * 60 * 60 * 1000);
  return token;
}

function validRelayToken(token) {
  const expiry = relayTokens.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    relayTokens.delete(token);
    return false;
  }
  return true;
}

function fail(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

function outputNameFor(job) {
  const preset = getPreset(job.presetId);
  let base = job.name || (job.url ? safeNameFromUrl(job.url) : 'video');
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '');
  base = base.replace(/[^\w\-. ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
  const tag = job.targetMb ? `${Math.round(job.targetMb)}mb` : preset.id;
  return `${base}-squeeze-${tag}.mp4`;
}

function safeNameFromUrl(raw) {
  try {
    const u = new URL(raw);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || u.hostname;
  } catch {
    return 'video';
  }
}

function makeController(job) {
  const controller = new AbortController();
  job.abort = () => controller.abort();
  return controller;
}

/* ------------------------------------------------------- the actual work */

async function compressJob(job) {
  const paths = jobsStore.jobPaths(job);
  const preset = getPreset(job.presetId);
  const controller = makeController(job);

  jobsStore.updateJob(job, { status: 'compressing', stage: 'Reading video info', progress: 0 });

  const meta = await probe(paths.source);
  const stat = await fsp.stat(paths.source);
  job.sourceBytes = stat.size;

  if (!meta.duration && !meta.bitrate) {
    throw Object.assign(new Error('Could not read this video — it may be corrupted.'), { code: 'BAD_MEDIA' });
  }

  jobsStore.updateJob(job, {
    meta: {
      duration: Math.round(meta.duration * 10) / 10,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      videoCodec: meta.videoCodec,
      hasAudio: meta.hasAudio,
    },
    stage: 'Compressing',
  });

  thumbnail(paths.source, paths.thumb, meta.duration).catch(() => {});

  const notes = [];
  if (job.targetMb && targetTooSmall(meta, preset, job.targetMb)) {
    notes.push(`A ${job.targetMb} MB target is very tight for a clip this long — quality may suffer.`);
  }

  const { args, videoKbps } = buildArgs({
    input: paths.source,
    output: paths.output,
    meta,
    preset,
    targetMb: job.targetMb,
  });

  let lastEmit = 0;
  await transcode(paths.source, paths.output, args, {
    signal: controller.signal,
    duration: meta.duration,
    onProgress: ({ seconds, speed }) => {
      const now = Date.now();
      if (seconds != null && meta.duration > 0) job.progress = Math.min(1, seconds / meta.duration);
      if (speed != null && speed > 0) {
        job.speed = speed;
        const remaining = Math.max(0, meta.duration - (seconds || 0));
        job.etaSeconds = Math.round(remaining / speed);
      }
      if (now - lastEmit > 400) {
        lastEmit = now;
        jobsStore.updateJob(job, { stage: 'Compressing' });
      }
    },
  });

  const outStat = await fsp.stat(paths.output);
  if (!outStat.size) throw Object.assign(new Error('Compression produced an empty file.'), { code: 'EMPTY_OUTPUT' });

  const saved = job.sourceBytes ? Math.max(0, 1 - outStat.size / job.sourceBytes) : 0;
  if (saved < 0.05 && !job.targetMb) {
    notes.push('This one was already small — the compressed copy is about the same size.');
  }

  jobsStore.updateJob(job, {
    status: 'done',
    stage: 'Ready',
    progress: 1,
    speed: null,
    etaSeconds: 0,
    outputBytes: outStat.size,
    outputName: outputNameFor(job),
    note: notes.join(' ') || null,
    videoKbps,
    saved,
  });
}

const FRIENDLY = {
  CANCELLED: 'Cancelled.',
  NO_VIDEO: 'That file has no video track.',
  INVALID_MEDIA: 'That file is not a video this server can read.',
  BAD_MEDIA: 'That video looks corrupted or uses a format that cannot be read.',
  FFMPEG_FAILED: 'ffmpeg could not process this file. It may be corrupted or use an unusual codec.',
  TOO_BIG: 'That file is larger than this server accepts.',
  UNREACHABLE: 'This server could not reach that link.',
  BAD_STATUS: 'The link did not return a video.',
  HTML_PAGE: 'That link is a web page, not a video file.',
  PLAYLIST: 'That is a streaming playlist (.m3u8 / .mpd), not a video file. Paste a direct MP4 or WebM link instead.',
  DOWNLOAD_FAILED: 'The download stopped before it finished.',
  TIMEOUT: 'The download timed out.',
  NO_YTDLP: 'Platform downloads are not enabled on this server.',
  YTDLP_FAILED: 'The platform refused the download. It may need a login, or the link is unsupported.',
};

function reportJobError(job, err) {
  const message = FRIENDLY[err.code] || err.message || 'Something went wrong while compressing.';
  jobsStore.updateJob(job, {
    status: 'error',
    stage: 'Failed',
    error: message,
    speed: null,
  });
  console.error(`[job ${job.id}] ${err.code || 'ERR'}:`, err.message?.slice(0, 600));
}

/* Encode jobs one at a time per CPU slot: two 1080p encodes fighting over the
   same cores finish slower than they would run back to back. */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 1;
const queue = [];
let activeCount = 0;

function updateQueuePositions() {
  queue.forEach((job, index) => {
    jobsStore.updateJob(job, {
      status: 'queued',
      stage: index === 0 ? 'Next in line' : `${index + 1} in line`,
    });
  });
}

function pumpQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!jobsStore.getJob(job.id)) continue; // removed while waiting
    activeCount += 1;
    compressJob(job)
      .catch((err) => reportJobError(job, err))
      .finally(() => {
        activeCount -= 1;
        updateQueuePositions();
        pumpQueue();
      });
  }
  updateQueuePositions();
}

function startCompression(job) {
  jobsStore.updateJob(job, { status: 'queued', stage: 'Queued', progress: 0 });
  queue.push(job);
  pumpQueue();
}

/* --------------------------------------------------------------- raw uploads */

async function saveRequestToFile(req, destPath, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  const out = fs.createWriteStream(destPath);
  let received = 0;
  let tooBig = false;

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > maxBytes && !tooBig) {
      tooBig = true;
      req.destroy();
      out.destroy();
    }
  });

  try {
    await pipeline(req, out);
  } catch {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    if (tooBig) {
      throw Object.assign(new Error(`Files up to ${MAX_UPLOAD_MB} MB are supported.`), { code: 'TOO_BIG' });
    }
    throw Object.assign(new Error('The upload stopped before it finished.'), { code: 'UPLOAD_FAILED' });
  }

  if (tooBig) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw Object.assign(new Error(`Files up to ${MAX_UPLOAD_MB} MB are supported.`), { code: 'TOO_BIG' });
  }

  return received;
}

/** Move a freshly received file into the job folder and kick off compression. */
async function adoptUpload(tmpPath, fields) {
  const job = jobsStore.createJob({
    source: fields.source || 'upload',
    url: fields.url,
    name: fields.name,
    presetId: fields.presetId,
    targetMb: fields.targetMb,
  });
  const paths = jobsStore.jobPaths(job);

  try {
    await probe(tmpPath);
  } catch (err) {
    await jobsStore.removeJob(job.id);
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  await fsp.rename(tmpPath, paths.source);
  const size = (await fsp.stat(paths.source)).size;
  jobsStore.updateJob(job, { status: 'queued', sourceBytes: size, stage: 'Queued' });
  startCompression(job);
  return job;
}

/* -------------------------------------------------------------------- routes */

app.get('/api/health', async (req, res) => {
  const ytdlp = await sources.hasYtdlp();
  res.json({
    ok: true,
    maxUploadMb: MAX_UPLOAD_MB,
    presets: PRESET_LIST,
    platformDownloads: Boolean(ytdlp),
    ytdlpVersion: ytdlp?.version || null,
  });
});

app.get('/api/presets', (req, res) => res.json({ presets: PRESET_LIST }));

app.post('/api/relay-token', (req, res) => {
  res.json({ token: newRelayToken(), maxUploadMb: MAX_UPLOAD_MB });
});

/** Does the server itself have a route to this URL? Drives the UI's strategy. */
app.post('/api/probe', async (req, res) => {
  const url = sources.normalizeUrl(req.body?.url);
  if (!url) return fail(res, 400, 'BAD_URL', 'That does not look like a valid link.');
  const platform = sources.platformFor(url);
  if (platform) {
    const ytdlp = await sources.hasYtdlp();
    return res.json({
      url,
      platform,
      serverCanFetch: Boolean(ytdlp),
      reason: ytdlp ? null : 'platform-needs-ytdlp',
    });
  }
  const remote = await sources.probeRemote(url);
  res.json({
    url,
    platform: null,
    serverCanFetch: remote.reachable && !remote.isHtml,
    contentLength: remote.contentLength || 0,
    contentType: remote.contentType || null,
    reason: remote.reachable ? (remote.isHtml ? 'html-page' : null) : 'unreachable',
  });
});

/**
 * Create a job.
 * body: { source: 'url'|'upload'|'sample', url?, name?, presetId?, targetMb? }
 */
app.post('/api/jobs', async (req, res) => {
  const body = req.body || {};
  const source = body.source || 'url';
  const presetId = String(body.presetId || 'balanced');
  const targetMb = Number(body.targetMb) > 0 ? Number(body.targetMb) : null;

  if (source === 'sample') {
    const job = jobsStore.createJob({ source: 'sample', name: 'squeeze-sample', presetId, targetMb });
    const paths = jobsStore.jobPaths(job);
    ensureSample()
      .then((samplePath) => fsp.copyFile(samplePath, paths.source))
      .then(() => {
        const size = fs.statSync(paths.source).size;
        jobsStore.updateJob(job, { sourceBytes: size });
        startCompression(job);
      })
      .catch((err) => reportJobError(job, err));
    return res.status(201).json({ job: jobsStore.publicView(job) });
  }

  if (source !== 'url') return fail(res, 400, 'BAD_SOURCE', 'Unknown job source.');

  const url = sources.normalizeUrl(body.url);
  if (!url) return fail(res, 400, 'BAD_URL', 'That does not look like a valid link.');

  const platform = sources.platformFor(url);

  // Streaming playlists need an extractor, never a plain download.
  if (sources.looksLikePlaylist(url) && !platform) {
    const ytdlp = await sources.hasYtdlp();
    if (!ytdlp) {
      return fail(
        res,
        400,
        'PLAYLIST',
        'That is a streaming playlist (.m3u8 / .mpd), not a video file. Paste a direct MP4 or WebM link instead.',
      );
    }
  }

  // Platform links (YouTube, TikTok, …) need yt-dlp on the server.
  if (platform) {
    const ytdlp = await sources.hasYtdlp();
    if (!ytdlp) {
      return fail(
        res,
        409,
        'NEED_BROWSER',
        'This server cannot extract platform links. Retrying through your browser instead.',
      );
    }
    const job = jobsStore.createJob({ source: 'ytdlp', url, presetId, targetMb, name: body.name });
    jobsStore.updateJob(job, { status: 'fetching', stage: 'Downloading from the platform' });
    sources
      .downloadPlatform(url, job.dir, {
        onProgress: (p) => jobsStore.updateJob(job, { progress: p, stage: 'Downloading from the platform' }),
      })
      .then(() => {
        jobsStore.updateJob(job, { progress: 0 });
        startCompression(job);
      })
      .catch((err) => {
        if (err.code === 'NO_VIDEO' || err.code === 'BAD_MEDIA') return;
        reportJobError(job, err);
      });
    return res.status(201).json({ job: jobsStore.publicView(job) });
  }

  // Plain file URLs: the server downloads them when it can.
  const remote = await sources.probeRemote(url);
  if (!remote.reachable || remote.isHtml) {
    return fail(
      res,
      409,
      'NEED_BROWSER',
      remote.isHtml
        ? 'That link is a web page, not a video file. Retrying through your browser instead.'
        : 'This server cannot reach that host directly. Retrying through your browser instead.',
    );
  }

  const job = jobsStore.createJob({ source: 'url', url, presetId, targetMb, name: body.name });
  const paths = jobsStore.jobPaths(job);
  jobsStore.updateJob(job, { status: 'fetching', stage: 'Downloading video' });

  sources
    .downloadHttp(url, paths.source, {
      maxBytes: MAX_UPLOAD_BYTES,
      onProgress: (received, total) => {
        const p = total ? received / total : 0;
        jobsStore.updateJob(job, {
          progress: p,
          sourceBytes: received,
          stage: total ? 'Downloading video' : `Downloading video (${Math.round(received / 1048576)} MB)`,
        });
      },
    })
    .then(() => {
      jobsStore.updateJob(job, { progress: 0 });
      startCompression(job);
    })
    .catch((err) => reportJobError(job, err));

  return res.status(201).json({ job: jobsStore.publicView(job) });
});

/** Upload straight from the browser (drag & drop). */
app.post('/api/upload', async (req, res) => {
  const tmp = path.join(jobsStore.TMP_DIR, `${crypto.randomBytes(8).toString('hex')}.part`);
  try {
    await saveRequestToFile(req, tmp);
    const presets = req.query.presetId ? String(req.query.presetId) : 'balanced';
    const job = await adoptUpload(tmp, {
      source: 'upload',
      name: req.query.name ? String(req.query.name) : null,
      presetId: presets,
      targetMb: Number(req.query.targetMb) > 0 ? Number(req.query.targetMb) : null,
    });
    res.status(201).json({ job: jobsStore.publicView(job) });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (err.code === 'TOO_BIG') return fail(res, 413, 'TOO_BIG', err.message);
    if (err.code === 'NO_VIDEO') return fail(res, 415, 'NO_VIDEO', 'That file does not contain a video track.');
    if (err.code === 'INVALID_MEDIA') {
      return fail(res, 415, 'INVALID_MEDIA', 'That file is not a video this server can read.');
    }
    return fail(res, 400, 'UPLOAD_FAILED', err.message);
  }
});

/**
 * Browser relay: the browser fetched the video itself (it can reach hosts this
 * server cannot) and streams the bytes here for compression.
 */
app.put('/api/relay/:token', async (req, res) => {
  const token = req.params.token;
  if (!validRelayToken(token)) return fail(res, 410, 'TOKEN_EXPIRED', 'This transfer link expired. Try again.');
  relayTokens.delete(token);

  const tmp = path.join(jobsStore.TMP_DIR, `${crypto.randomBytes(8).toString('hex')}.part`);
  try {
    const bytes = await saveRequestToFile(req, tmp);
    if (!bytes) throw Object.assign(new Error('No data was received.'), { code: 'EMPTY' });
    const job = await adoptUpload(tmp, {
      source: 'relay',
      url: req.query.url ? String(req.query.url) : null,
      name: req.query.filename ? String(req.query.filename) : null,
      presetId: req.query.presetId ? String(req.query.presetId) : 'balanced',
      targetMb: Number(req.query.targetMb) > 0 ? Number(req.query.targetMb) : null,
    });
    res.status(201).json({ job: jobsStore.publicView(job) });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (err.code === 'TOO_BIG') return fail(res, 413, 'TOO_BIG', err.message);
    if (err.code === 'NO_VIDEO' || err.code === 'INVALID_MEDIA') {
      return fail(res, 415, 'NO_VIDEO', 'That link did not download as a playable video file.');
    }
    return fail(res, 400, 'RELAY_FAILED', err.message);
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'That job no longer exists.');
  res.json({ job: jobsStore.publicView(job) });
});

/** Live progress stream. */
app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'That job no longer exists.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const send = (j) => {
    if (j.id !== job.id) return;
    res.write(`data: ${JSON.stringify(jobsStore.publicView(j))}\n\n`);
  };
  send(job);

  const onUpdate = (j) => {
    if (j.id !== job.id) return;
    send(j);
    if (j.status === 'done' || j.status === 'error') cleanup();
  };
  const cleanup = () => {
    jobsStore.bus.off('update', onUpdate);
    clearInterval(ping);
    res.end();
  };
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  jobsStore.bus.on('update', onUpdate);
  req.on('close', cleanup);
});

app.get('/api/jobs/:id/thumb', (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'Not found.');
  const { thumb } = jobsStore.jobPaths(job);
  if (!fs.existsSync(thumb)) return fail(res, 404, 'NO_THUMB', 'No preview yet.');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(thumb);
});

function serveOutput(req, res, disposition) {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'That job no longer exists.');
  const { output } = jobsStore.jobPaths(job);
  if (job.status !== 'done' || !fs.existsSync(output)) {
    return fail(res, 409, 'NOT_READY', 'This file is not ready yet.');
  }
  res.sendFile(
    output,
    {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `${disposition}; filename="${job.outputName}"`,
      },
    },
    (err) => {
      if (err && !res.headersSent) fail(res, 500, 'SEND_FAILED', 'Could not send the file.');
    },
  );
}

app.get('/api/jobs/:id/preview', (req, res) => serveOutput(req, res, 'inline'));
app.get('/api/jobs/:id/download', (req, res) => serveOutput(req, res, 'attachment'));

app.delete('/api/jobs/:id', async (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'That job no longer exists.');
  const queuedAt = queue.findIndex((q) => q.id === job.id);
  if (queuedAt !== -1) queue.splice(queuedAt, 1);
  if (job.abort) job.abort();
  await jobsStore.removeJob(req.params.id);
  res.json({ ok: true });
});

/* -------------------------------------------------------------------- static */

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.get('/j/:id', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'job.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND', 'Unknown endpoint.');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* --------------------------------------------------------------------- boot */

async function main() {
  await jobsStore.init();
  ensureSample().catch((err) => console.warn('Sample clip unavailable:', err.message));
  const ytdlp = await sources.hasYtdlp();
  console.log(`Squeeze listening on http://0.0.0.0:${PORT} (yt-dlp: ${ytdlp ? ytdlp.version : 'not installed'})`);
  app.listen(PORT, '0.0.0.0');
}

if (require.main === module) main();

module.exports = app;
