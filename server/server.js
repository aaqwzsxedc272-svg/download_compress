'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const express = require('express');

const jobsStore = require('./jobs');
const { probe, thumbnail, transcode } = require('./ffmpeg');
const {
  PRESET_LIST,
  DEFAULT_PRESET,
  getPreset,
  buildPlan,
  targetTooSmall,
} = require('./compress');
const hosters = require('./hosters');
const sources = require('./sources');
const { resolve, directUrl, setGofileBrowser, setPageBrowser } = require('../shared/resolve');

/* gofile mints its API token in an obfuscated browser script, so a headless
   browser is the only way to list a folder once the plain API says no. It is an
   optional dependency: if it is not installed this is a no-op. */
try {
  const browser = require('./browser');
  if (browser.available()) {
    setGofileBrowser((code) => browser.gofileFolder(code));
    setPageBrowser((url) => browser.captureMedia(url));
  }
} catch {
  /* no browser helper on this deployment */
}
const { ensureSample } = require('./sample');

const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 6144;
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
  job.abortSignal = controller.signal;
  return controller;
}

/* ------------------------------------------------------- the actual work */

/** Auto-host finished files when a hoster is configured. */
const AUTO_HOST = process.env.AUTO_HOST !== '0';

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
      audioCodec: meta.audioCodec,
      hasAudio: meta.hasAudio,
    },
    stage: 'Compressing',
  });

  thumbnail(paths.source, paths.thumb, meta.duration).catch(() => {});

  const notes = [];
  if (job.targetMb && targetTooSmall(meta, preset, job.targetMb)) {
    notes.push(`A ${job.targetMb} MB target is very tight for a clip this long — quality may suffer.`);
  }

  const plan = buildPlan({
    input: paths.source,
    output: paths.output,
    meta,
    preset,
    targetMb: job.targetMb,
    passlogBase: path.join(job.dir, 'x264pass'),
  });

  // Progress is spread across passes so a two-pass encode still reads 0-100%.
  const passCount = plan.passes.length;
  let lastEmit = 0;

  for (let index = 0; index < passCount; index += 1) {
    const pass = plan.passes[index];
    const slice = 1 / passCount;

    await transcode(paths.source, paths.output, pass.args, {
      signal: controller.signal,
      duration: meta.duration,
      onProgress: ({ seconds, speed }) => {
        const now = Date.now();
        if (seconds != null && meta.duration > 0) {
          const within = Math.min(1, seconds / meta.duration);
          job.progress = Math.min(1, index * slice + within * slice);
        }
        if (speed != null && speed > 0) {
          job.speed = speed;
          const remaining = Math.max(0, meta.duration - (seconds || 0));
          job.etaSeconds = Math.round(remaining / speed);
        }
        if (now - lastEmit > 400) {
          lastEmit = now;
          jobsStore.updateJob(job, { stage: passCount > 1 ? `${pass.label} (${index + 1}/${passCount})` : 'Compressing' });
        }
      },
    });
  }

  await fsp.rm(`${path.join(job.dir, 'x264pass')}.log`, { force: true }).catch(() => {});
  await fsp.rm(`${path.join(job.dir, 'x264pass')}.log.mbtree`, { force: true }).catch(() => {});

  let outStat = await fsp.stat(paths.output);
  if (!outStat.size) throw Object.assign(new Error('Compression produced an empty file.'), { code: 'EMPTY_OUTPUT' });

  // Never hand back a file that is bigger AND no better: if the re-encode did
  // not pay off, deliver the original bytes instead.
  let usedOriginal = false;
  if (!job.targetMb && outStat.size >= job.sourceBytes) {
    await fsp.copyFile(paths.source, paths.output);
    outStat = await fsp.stat(paths.output);
    usedOriginal = true;
    notes.push('Re-encoding would have made this bigger, so the original file is what gets shared.');
  }

  const saved = job.sourceBytes ? Math.max(0, 1 - outStat.size / job.sourceBytes) : 0;
  if (!usedOriginal && saved < 0.05 && !job.targetMb) {
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
    videoKbps: plan.videoKbps,
    usedOriginal,
    audioMode: plan.audio.mode,
    twoPass: plan.twoPass,
    scaledTo: plan.scaleNote,
    saved,
  });

  // The point of the app is the link, not the local file: hand it to a host now.
  if (AUTO_HOST) {
    const free = await sources.freeDiskBytes(jobsStore.DATA_DIR);
    if (free > outStat.size * 3) hostJob(job).catch(() => {});
  }
}

/** Upload a finished job's file to a free host and record the share link. */
async function hostJob(job, { order } = {}) {
  if (job.status !== 'done') {
    throw Object.assign(new Error('That file is not ready yet.'), { code: 'NOT_READY' });
  }
  if (job.hosting) return job;

  const paths = jobsStore.jobPaths(job);
  if (!fs.existsSync(paths.output)) {
    throw Object.assign(new Error('The local copy of this file is gone, so it cannot be re-hosted.'), {
      code: 'NO_FILE',
    });
  }

  job.hosting = true;
  jobsStore.updateJob(job, { status: 'hosting', stage: 'Uploading to a file host', hostError: null, progress: 0 });

  try {
    const result = await hosters.uploadToHoster(
      paths.output,
      { name: job.outputName || 'video.mp4' },
      {
        order,
        signal: job.abortSignal,
        onProgress: ({ sent, total, provider }) => {
          job.progress = total ? sent / total : 0;
          job.stage = `Uploading to ${hosters.PROVIDERS[provider]?.label || provider} · ${Math.round(job.progress * 100)}%`;
          jobsStore.updateJob(job, {});
        },
      },
    );

    jobsStore.updateJob(job, {
      status: 'hosted',
      stage: 'Link ready',
      progress: 1,
      hostedUrl: result.url,
      hostProvider: result.provider,
      hostedBy: 'server',
      hostError: null,
      hostedAt: Date.now(),
    });
    persistHostedLink(job, result.url, result.provider);
    return job;
  } catch (err) {
    jobsStore.updateJob(job, {
      status: 'done',
      progress: 1,
      stage: 'Ready (no share link yet)',
      hostError: err.message,
    });
    throw err;
  } finally {
    job.hosting = false;
  }
}

/** Keep a small append-only ledger of share links, independent of job cleanup. */
async function persistHostedLink(job, url, provider) {
  const file = path.join(jobsStore.DATA_DIR, 'links.json');
  const line = JSON.stringify({
    jobId: job.id,
    url,
    provider,
    name: job.outputName,
    sourceBytes: job.sourceBytes,
    outputBytes: job.outputBytes,
    createdAt: job.createdAt,
    at: Date.now(),
  });
  await fsp.appendFile(file, `${line}\n`).catch(() => {});
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
  BLOCKED_HOST: 'That address is not allowed.',
  NO_VIDEO_FOUND: 'No video was found behind that link.',
  GOFILE_PREMIUM: 'gofile only releases that folder to a premium account.',
  PASSWORD: 'That link is password protected.',
  NOT_FOUND: 'That link no longer exists.',
  NO_VIDEO_ON_PAGE: 'That page streams its video, so there is no single file to download.',
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

/**
 * Job whose source still has to be fetched: resolve the file reference to a
 * fresh signed URL, download it, then hand it to the encoder.
 */
async function fetchThenCompress(job, ref) {
  const paths = jobsStore.jobPaths(job);
  const controller = makeController(job);

  try {
    jobsStore.updateJob(job, { status: 'fetching', stage: 'Finding the video file' });

    const url = await directUrl(ref);
    const free = await sources.freeDiskBytes(jobsStore.DATA_DIR);
    const expected = Number(ref.size) || 0;
    if (expected && free < expected * 1.6) {
      throw Object.assign(new Error('Not enough disk space on this server for that file.'), {
        code: 'NO_DISK',
      });
    }

    jobsStore.updateJob(job, { status: 'fetching', stage: 'Downloading video', progress: 0 });

    await sources.downloadHttp(url, paths.source, {
      maxBytes: MAX_UPLOAD_BYTES,
      signal: controller.signal,
      onProgress: (received, total) => {
        const p = total ? received / total : 0;
        job.sourceBytes = received;
        job.progress = p;
        job.stage = total
          ? `Downloading video · ${Math.round(p * 100)}%`
          : `Downloading video (${Math.round(received / 1048576)} MB)`;
        if (Date.now() - (job._lastEmit || 0) > 500) {
          job._lastEmit = Date.now();
          jobsStore.updateJob(job, {});
        }
      },
    });

    jobsStore.updateJob(job, { progress: 0, sourceBytes: (await fsp.stat(paths.source)).size });
    startCompression(job);
  } catch (err) {
    reportJobError(job, err);
  }
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

/* GitHub Codespaces (and similar hosts) stop an idle machine, but "terminal
   output is counted as activity". So while any job is running, print a line
   every 45 seconds: the machine stays awake through a multi-hour encode even if
   nobody is looking at the tab. */
let heartbeatTimer = null;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_SECONDS || 45) * 1000;

function startHeartbeat() {
  if (heartbeatTimer || !HEARTBEAT_MS) return;
  heartbeatTimer = setInterval(() => {
    const busy = jobsStore.listJobs ? jobsStore.listJobs() : [];
    const running = (busy || []).filter((job) =>
      ['fetching', 'queued', 'compressing', 'hosting'].includes(job.status),
    );
    if (!running.length) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    const parts = running.map((job) => {
      const pct = Math.round((Number(job.progress) || 0) * 100);
      const eta = job.etaSeconds ? ` · ${Math.max(1, Math.round(job.etaSeconds / 60))}m left` : '';
      return `${job.id} ${pct}%${eta}`;
    });
    console.log(`[keep-alive] ${new Date().toISOString()} · ${parts.join(' · ')}`);
  }, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function pumpQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!jobsStore.getJob(job.id)) continue; // removed while waiting
    activeCount += 1;
    startHeartbeat();
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
  // Leave room for the encoded output next to the source.
  const free = await sources.freeDiskBytes(jobsStore.DATA_DIR);
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared * 1.5 > free) {
    throw Object.assign(new Error('This server does not have enough free disk space for that file.'), {
      code: 'NO_DISK',
    });
  }

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
    defaultPreset: DEFAULT_PRESET,
    platformDownloads: Boolean(ytdlp),
    ytdlpVersion: ytdlp?.version || null,
    hosters: hosters.describeProviders(),
    autoHost: AUTO_HOST,
    browserHosters: ['gofile', 'pixeldrain'],
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

/** List the actual files behind a share link (gofile folder, turbo.cr page, …). */
app.post('/api/resolve', async (req, res) => {
  const url = sources.normalizeUrl(req.body?.url);
  if (!url) return fail(res, 400, 'BAD_URL', 'That does not look like a valid link.');
  if (sources.isBlockedHost(url)) return fail(res, 400, 'BLOCKED_HOST', 'That address is not allowed.');
  try {
    const result = await fileBehindUrl(url, await resolve(url));
    return res.json({
      resolver: result.resolver,
      title: result.title || null,
      files: result.files.map((file) => ({
        name: file.name,
        size: file.size || 0,
        mime: file.mime || '',
        kind: file.kind,
        ref: file.ref,
      })),
    });
  } catch (err) {
    const status = err.code === 'BAD_URL' ? 400 : 422;
    return fail(res, status, err.code || 'RESOLVE_FAILED', err.message || 'Could not read that link.');
  }
});

const ALLOWED_REF_RESOLVERS = new Set(['gofile', 'turbo', 'pixeldrain', 'direct']);

/**
 * Create a job.
 * body: { source: 'url'|'ref'|'upload'|'sample', url?, ref?, name?, presetId?, targetMb? }
 */
app.post('/api/jobs', async (req, res) => {
  const body = req.body || {};
  const source = body.source || 'url';
  const presetId = String(body.presetId || 'balanced');
  const targetMb = Number(body.targetMb) > 0 ? Number(body.targetMb) : null;

  if (source === 'ref') {
    const ref = body.ref;
    if (!ref || typeof ref !== 'object' || !ALLOWED_REF_RESOLVERS.has(String(ref.resolver))) {
      return fail(res, 400, 'BAD_REF', 'That file reference is not valid.');
    }
    const job = jobsStore.createJob({
      source: 'link',
      url: body.pageUrl ? String(body.pageUrl) : null,
      presetId,
      targetMb,
      name: body.name,
      ref,
    });
    res.status(201).json({ job: jobsStore.publicView(job) });
    fetchThenCompress(job, ref);
    return undefined;
  }

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
  // Work out what this link really points at, cheapest check first.
  // 1. A known share host or an obvious file URL resolves on its own.
  let resolved = null;
  try {
    resolved = await resolve(url, { allowPage: false });
    resolved = await fileBehindUrl(url, resolved);
  } catch (err) {
    return fail(res, 422, err.code || 'RESOLVE_FAILED', err.message);
  }

  // 2. Otherwise ask the host what it is: a video file, or a page to scrape?
  if (!resolved) {
    if (sources.isBlockedHost(url)) {
      return fail(res, 400, 'BLOCKED_HOST', 'That address is not allowed.');
    }
    const remote = await sources.probeRemote(url);

    if (remote.reachable && !remote.isHtml) {
      let name = 'video';
      try {
        name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'video');
      } catch {
        /* keep default */
      }
      resolved = {
        resolver: 'direct',
        title: null,
        files: [
          {
            name,
            size: remote.contentLength || 0,
            mime: remote.contentType || '',
            kind: 'video',
            ref: { resolver: 'direct', url, name },
          },
        ],
      };
    } else if (remote.isHtml) {
      try {
        resolved = await resolve(url);
      } catch (err) {
        return fail(res, 422, err.code || 'RESOLVE_FAILED', err.message);
      }
    } else {
      // The server cannot even reach it: a real browser may still be able to.
      try {
        const browser = require('./browser');
        if (browser.available()) {
          const captured = await browser.captureMedia(url);
          const media = (captured && captured.media) || [];
          if (media.length) {
            resolved = {
              resolver: 'browser',
              title: null,
              files: media.slice(0, 12).map((item, index) => {
                let name = `video-${index + 1}.mp4`;
                try {
                  const last = decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || '');
                  if (last) name = last;
                } catch {
                  /* keep default */
                }
                return {
                  id: item.url,
                  name,
                  size: Number(item.size) || 0,
                  mime: item.contentType || '',
                  kind: 'video',
                  ref: { resolver: 'direct', url: item.url, name },
                };
              }),
            };
          }
        }
      } catch {
        /* fall through to the browser relay */
      }
      if (!resolved) {
        return fail(res, 409, 'NEED_BROWSER', 'This server cannot reach that host. Retrying through your browser instead.');
      }
    }
  }

  const file = resolved.files.find((f) => f.kind === 'video') || resolved.files[0];
  if (!file) return fail(res, 422, 'NO_VIDEO_FOUND', 'No video was found behind that link.');

  const job = jobsStore.createJob({
    source: 'url',
    url,
    presetId,
    targetMb,
    name: body.name || file.name,
    ref: file.ref,
  });
  res.status(201).json({ job: jobsStore.publicView(job) });
  fetchThenCompress(job, file.ref);
  return undefined;
});



/**
 * A ".mp4" URL is only a file if it answers like one. Hotlink-protected hosts
 * (fileditch among them) answer with an HTML challenge, which used to fail the
 * job after the download had already started. Try the page path instead, then a
 * real browser, before giving up.
 */
async function fileBehindUrl(url, resolved) {
  if (!resolved || !resolved.files || !resolved.files.length) return resolved;
  if (resolved.resolver !== 'direct') return resolved;
  const remote = await sources.probeRemote(url);
  if (!remote.reachable || !remote.isHtml) return resolved;
  try {
    const viaPage = await resolve(url);
    if (viaPage && viaPage.files && viaPage.files.length) return viaPage;
  } catch {
    /* fall through to the browser */
  }
  try {
    const browser = require('./browser');
    if (browser.available()) {
      const captured = await browser.captureMedia(url);
      const media = (captured && captured.media) || [];
      if (media.length) {
        return {
          resolver: 'browser',
          title: null,
          files: media.slice(0, 12).map((item, index) => {
            let name = `video-${index + 1}.mp4`;
            try {
              const last = decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || '');
              if (last) name = last;
            } catch {
              /* keep default */
            }
            return {
              id: item.url,
              name,
              size: Number(item.size) || 0,
              mime: item.contentType || '',
              kind: 'video',
              ref: { resolver: 'direct', url: item.url, name },
            };
          }),
        };
      }
    }
  } catch {
    /* nothing more to try */
  }
  return resolved;
}

/* ------------------------------------------------- chunked / resumable upload */

/**
 * A multi-GB video cannot be pushed as one request through every proxy, and a
 * dropped connection should not lose the whole transfer. Uploads are therefore
 * split into fixed-size chunks appended to a temp file, then finished in one call.
 */
const CHUNK_SIZE = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

/** uploadId -> { dir, metaPath, blobPath, meta } held in memory while active. */
const uploads = new Map();

function uploadDirFor(id) {
  return path.join(jobsStore.UPLOADS_DIR, id);
}

async function writeMeta(entry) {
  await fsp.writeFile(entry.metaPath, JSON.stringify(entry.meta));
}

app.post('/api/upload/init', async (req, res) => {
  const body = req.body || {};
  const size = Number(body.size) || 0;
  if (size > MAX_UPLOAD_BYTES) {
    return fail(res, 413, 'TOO_BIG', `Files up to ${MAX_UPLOAD_MB} MB are supported.`);
  }
  const free = await sources.freeDiskBytes(jobsStore.DATA_DIR);
  if (size && size * 1.5 > free) {
    return fail(res, 507, 'NO_DISK', 'This server does not have enough free disk space for that file.');
  }

  const id = crypto.randomBytes(18).toString('base64url');
  const dir = uploadDirFor(id);
  await fsp.mkdir(dir, { recursive: true });

  const entry = {
    dir,
    metaPath: path.join(dir, 'meta.json'),
    blobPath: path.join(dir, 'blob.part'),
    meta: {
      id,
      filename: String(body.filename || 'video').slice(0, 200),
      size,
      presetId: String(body.presetId || 'balanced'),
      targetMb: Number(body.targetMb) > 0 ? Number(body.targetMb) : null,
      url: body.url ? String(body.url).slice(0, 2000) : null,
      chunks: 0,
      createdAt: Date.now(),
    },
  };
  await fsp.writeFile(entry.blobPath, '');
  await writeMeta(entry);
  uploads.set(id, entry);

  res.status(201).json({ uploadId: id, chunkSize: CHUNK_SIZE });
});

function liveUpload(id) {
  const entry = uploads.get(id);
  if (!entry) return null;
  if (Date.now() - entry.meta.createdAt > UPLOAD_TTL_MS) {
    uploads.delete(id);
    fsp.rm(uploadDirFor(id), { recursive: true, force: true }).catch(() => {});
    return null;
  }
  return entry;
}

app.get('/api/upload/status/:id', (req, res) => {
  const entry = liveUpload(req.params.id);
  if (!entry) return fail(res, 410, 'UPLOAD_EXPIRED', 'That upload expired. Start again.');
  res.json({ chunks: entry.meta.chunks, chunkSize: CHUNK_SIZE });
});

app.put('/api/upload/chunk/:id/:index', async (req, res) => {
  const entry = liveUpload(req.params.id);
  if (!entry) return fail(res, 410, 'UPLOAD_EXPIRED', 'That upload expired. Start again.');

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) return fail(res, 400, 'BAD_CHUNK', 'Invalid chunk index.');
  if (index > entry.meta.chunks) {
    return fail(res, 409, 'OUT_OF_ORDER', `Chunk ${entry.meta.chunks} expected, got ${index}.`);
  }
  if (index < entry.meta.chunks) {
    // Re-sent chunk after a retry: treat as already stored.
    return res.json({ chunks: entry.meta.chunks, skipped: true });
  }

  const sizeBefore = (await fsp.stat(entry.blobPath)).size;
  try {
    await pipeline(req, fs.createWriteStream(entry.blobPath, { flags: 'a' }));
  } catch {
    return fail(res, 400, 'CHUNK_FAILED', 'That chunk did not arrive completely.');
  }

  const sizeAfter = (await fsp.stat(entry.blobPath)).size;
  if (sizeAfter > MAX_UPLOAD_BYTES) {
    uploads.delete(entry.meta.id);
    await fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    return fail(res, 413, 'TOO_BIG', `Files up to ${MAX_UPLOAD_MB} MB are supported.`);
  }
  if (sizeAfter === sizeBefore) return fail(res, 400, 'EMPTY_CHUNK', 'That chunk was empty.');

  entry.meta.chunks = index + 1;
  await writeMeta(entry);
  res.json({ chunks: entry.meta.chunks, bytes: sizeAfter });
});

app.post('/api/upload/finish/:id', async (req, res) => {
  const entry = liveUpload(req.params.id);
  if (!entry) return fail(res, 410, 'UPLOAD_EXPIRED', 'That upload expired. Start again.');

  try {
    const stat = await fsp.stat(entry.blobPath);
    if (!stat.size) throw Object.assign(new Error('No data was received.'), { code: 'EMPTY' });
    if (entry.meta.size && stat.size < entry.meta.size * 0.98) {
      return fail(res, 400, 'INCOMPLETE', `Only ${stat.size} of ${entry.meta.size} bytes arrived.`);
    }

    const tmp = path.join(jobsStore.TMP_DIR, `${crypto.randomBytes(8).toString('hex')}.part`);
    await fsp.rename(entry.blobPath, tmp);
    uploads.delete(entry.meta.id);
    await fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});

    const job = await adoptUpload(tmp, {
      source: 'relay',
      name: entry.meta.filename,
      url: entry.meta.url,
      presetId: entry.meta.presetId,
      targetMb: entry.meta.targetMb,
    });
    res.status(201).json({ job: jobsStore.publicView(job) });
  } catch (err) {
    await fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    uploads.delete(entry.meta.id);
    if (err.code === 'NO_VIDEO' || err.code === 'INVALID_MEDIA') {
      return fail(res, 415, 'NO_VIDEO', 'That file is not a video this server can read.');
    }
    if (err.code === 'TOO_BIG') return fail(res, 413, 'TOO_BIG', err.message);
    return fail(res, 400, 'UPLOAD_FAILED', err.message);
  }
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

/** Recent jobs, newest first — the "start it and walk away" list. */
app.get('/api/jobs', (req, res) => {
  const jobs = jobsStore.listJobs().slice(0, 50).map((job) => jobsStore.publicView(job));
  res.json({ jobs });
});

app.get('/api/hosters', (req, res) => {
  res.json({
    server: hosters.describeProviders(),
    browser: ['gofile', 'pixeldrain'],
    autoHost: AUTO_HOST,
  });
});

/** Upload the finished file to a free host and return the share link. */
app.post('/api/jobs/:id/host', async (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'That job no longer exists.');
  if (!['done', 'hosted'].includes(job.status)) {
    return fail(res, 409, 'NOT_READY', 'That file is not ready yet.');
  }
  if (job.status === 'hosted' && job.hostedUrl && !req.body?.force) {
    return res.json({ job: jobsStore.publicView(job) });
  }

  const order = Array.isArray(req.body?.order)
    ? req.body.order.filter((id) => hosters.PROVIDERS[id])
    : undefined;

  // Run in the background so a slow upload cannot hold the request open; the
  // UI follows /api/jobs/:id/events for progress.
  res.status(202).json({ job: jobsStore.publicView(job) });
  hostJob(job, { order }).catch(() => {});
  return undefined;
});

/** Record a link the browser obtained itself (used when the server has no network). */
app.post('/api/jobs/:id/hosted', (req, res) => {
  const job = jobsStore.getJob(req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND', 'That job no longer exists.');

  const url = String(req.body?.url || '').trim();
  const provider = String(req.body?.provider || 'browser').slice(0, 40);
  if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000) {
    return fail(res, 400, 'BAD_URL', 'That share link is not valid.');
  }

  jobsStore.updateJob(job, {
    status: 'hosted',
    stage: 'Link ready',
    hostedUrl: url,
    hostProvider: provider,
    hostedBy: 'browser',
    hostError: null,
    hostedAt: Date.now(),
    progress: 1,
  });
  persistHostedLink(job, url, provider).catch(() => {});
  res.json({ job: jobsStore.publicView(job) });
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
  if (!['done', 'hosting', 'hosted'].includes(job.status) || !fs.existsSync(output)) {
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

// Drop half-finished chunked uploads so abandoned transfers do not fill the disk.
setInterval(async () => {
  const now = Date.now();
  for (const [id, entry] of [...uploads]) {
    if (now - entry.meta.createdAt > UPLOAD_TTL_MS) {
      uploads.delete(id);
      await fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  // Also clear files left behind by a previous process.
  const dirs = await fsp.readdir(jobsStore.UPLOADS_DIR).catch(() => []);
  for (const name of dirs) {
    if (uploads.has(name)) continue;
    const full = uploadDirFor(name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > UPLOAD_TTL_MS) {
      await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 10 * 60 * 1000).unref();

/* -------------------------------------------------------------------- static */

app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.get('/j/:id', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'job.html')));

app.get('/diagnostics', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'diagnostics.html')));

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
