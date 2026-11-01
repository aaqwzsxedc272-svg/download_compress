'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const express = require('express');

const jobsStore = require('./jobs');
const { probe, thumbnail, transcode } = require('./ffmpeg');
const { downloadWithFallback } = require('./fallback');
const autoStop = require('./autostop');
const ledger = require('./ledger');
const { chooseCrf } = require('./estimate');
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

/** The capture function, or null when Chromium is not installed here. */
function browserCapture() {
  try {
    const browser = require('./browser');
    if (!browser.available()) return null;
    return (url) => browser.captureMedia(url);
  } catch {
    return null;
  }
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
  base = base
    .replace(/[^\w\-. ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-_. ]+$/, '')
    .slice(0, 80)
    .replace(/[-_. ]+$/, '') || 'video';
  const tag = job.targetMb ? `${Math.round(job.targetMb)}mb` : preset.id;
  return `${base}-squeeze-${tag}.mp4`;
}

/** A file name from the host beats a slug from the link, which beats a token. */
function bestName(current, candidate) {
  const looksReal = (name) => Boolean(name) && /\.[a-z0-9]{2,5}$/i.test(name) && !/^[a-f0-9]{16,}\b/i.test(name);
  if (looksReal(candidate) && !looksReal(current)) return candidate;
  if (!current) return candidate || current;
  return current;
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


/** Run every pass of a plan, keeping progress/ETA on the job. */
async function runPasses(job, plan, paths, meta, controller) {
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
          jobsStore.updateJob(job, {
            stage: passCount > 1 ? `${pass.label} (${index + 1}/${passCount})` : 'Compressing',
          });
        }
      },
    });
  }
}

/** "video: hevc · audio: truehd", for when the encoder refuses a file. */
function codecSummary(meta) {
  const parts = [];
  if (meta.videoCodec) parts.push(`video ${meta.videoCodec}`);
  if (meta.audioCodec) parts.push(`audio ${meta.audioCodec}`);
  return parts.join(' · ');
}

/* ------------------------------------------------------- the actual work */

/** Auto-host finished files when a hoster is configured. */
const AUTO_HOST = process.env.AUTO_HOST !== '0';

/* Below this predicted saving the encode is skipped and the original is shared:
   spending half an hour to hand back the same bytes is worse than saying so. */
const SKIP_ENCODE_BELOW = Number(process.env.SQUEEZE_SKIP_BELOW) || 0.05;

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
  let usedOriginal = false;
  const note = (pick) => {
    console.log(
      `[job ${job.id}] predicted ${formatSize(pick.projectedBytes)} at CRF ${pick.crf}` +
        `${pick.size ? ` ${pick.size.width}x${pick.size.height}` : ''} ` +
        `(${pick.saving >= 0 ? '−' : '+'}${Math.abs(Math.round(pick.saving * 100))}% vs the original)`,
    );
  };
  if (job.browserFetched) notes.push('Fetched through a headless browser — the host refuses plain requests.');
  if (job.fetchedNote) notes.push(job.fetchedNote);
  if (job.targetMb && targetTooSmall(meta, preset, job.targetMb)) {
    notes.push(`A ${job.targetMb} MB target is very tight for a clip this long — quality may suffer.`);
  }

  /* Decide the settings before spending an hour encoding: what CRF, at what
     resolution, is predicted to be smaller *without looking worse*. */
  let crfOverride = null;
  let scaleOverride = null;
  let skipEncode = false;
  if (!job.targetMb) {
    jobsStore.updateJob(job, { stage: 'Checking what is worth encoding' });
    const pick = await chooseCrf({
      input: paths.source,
      meta,
      preset,
      sourceBytes: job.sourceBytes,
      workDir: job.dir,
    });
    if (pick.probes) {
      note(pick);
      const pickSize = pick.size || null;
      jobsStore.updateJob(job, {
        projection: {
          crf: pick.crf,
          projectedBytes: pick.projectedBytes,
          saving: Math.round(pick.saving * 1000) / 1000,
          width: pickSize ? pickSize.width : null,
          height: pickSize ? pickSize.height : null,
        },
      });
      if (pick.saving < SKIP_ENCODE_BELOW) {
        skipEncode = true;
        notes.push(
          'This file is already about as small as it can be without losing quality, so the original is what gets shared.',
        );
      } else {
        if (pick.saving < 0.15) {
          notes.push(`Packed tightly already — ${Math.round(pick.saving * 100)}% is all that can come off without hurting the picture.`);
        }
        if (pick.maxShortSide && pick.crf > preset.crf) {
          notes.push(`Straight re-encode is not enough for this one, so it runs slightly flatter (CRF ${pick.crf}).`);
        }
        if (pickSize && meta.width && pickSize.width < meta.width) {
          notes.push(
            `${meta.width}×${meta.height} → ${pickSize.width}×${pickSize.height}: shrinking the frame keeps the picture sharp where a flatter 1080p encode would have looked soft.`,
          );
        }
      }
      if (pick.crf !== preset.crf) crfOverride = pick.crf;
      if (pick.maxShortSide && pick.maxShortSide !== preset.maxShortSide) {
        scaleOverride = pick.maxShortSide;
      }
    }
  }

  if (controller.signal.aborted) {
    throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
  }

  let outStat = null;
  let videoKbps = null;
  let audioMode = null;
  let twoPass = false;
  let scaleNote = null;
  let outSize = { width: meta.width, height: meta.height };

  if (skipEncode) {
    jobsStore.updateJob(job, { stage: 'Keeping the original', progress: 1 });
    await fsp.copyFile(paths.source, paths.output);
    outStat = await fsp.stat(paths.output);
    usedOriginal = true;
  } else {
    /* First attempt uses the normal plan. If ffmpeg trips over the container
       (an MKV with broken timestamps, a 10-bit or 4:2:2 stream, more packets
       buffered than the muxer will take) it is retried once with the forgiving
       flags before the job is allowed to fail — that is the difference between
       "ffmpeg could not process this file" and a working video. */
    let attempt = 0;
    let plan = null;
    for (;;) {
      plan = buildPlan({
        input: paths.source,
        output: paths.output,
        meta,
        preset,
        targetMb: job.targetMb,
        passlogBase: path.join(job.dir, 'x264pass'),
        crfOverride,
        maxShortSide: scaleOverride,
        robust: attempt > 0,
      });

      videoKbps = plan.videoKbps;
      audioMode = plan.audio.mode;
      twoPass = plan.twoPass;
      scaleNote = plan.scaleNote;
      outSize = { width: plan.size.width, height: plan.size.height };

      try {
        await runPasses(job, plan, paths, meta, controller);
        break;
      } catch (err) {
        const recoverable = err.code === 'FFMPEG_FAILED' && attempt === 0 && !controller.signal.aborted;
        if (!recoverable) {
          if (err.code === 'FFMPEG_FAILED') err.codecNote = codecSummary(meta);
          throw err;
        }
        attempt += 1;
        await fsp.rm(paths.output, { force: true }).catch(() => {});
        await fsp.rm(`${path.join(job.dir, 'x264pass')}.log`, { force: true }).catch(() => {});
        notes.push('The first try tripped over something in this file (its container or bit depth), so it was retried in a more forgiving mode.');
        console.log(`[job ${job.id}] ffmpeg retry: ${err.detail || err.message?.slice(0, 200)}`);
        jobsStore.updateJob(job, { stage: 'Retrying with more forgiving encoder settings' });
      }
    }

    await fsp.rm(`${path.join(job.dir, 'x264pass')}.log`, { force: true }).catch(() => {});
    await fsp.rm(`${path.join(job.dir, 'x264pass')}.log.mbtree`, { force: true }).catch(() => {});

    outStat = await fsp.stat(paths.output);
    if (!outStat.size) throw Object.assign(new Error('Compression produced an empty file.'), { code: 'EMPTY_OUTPUT' });

    // Never hand back a file that is bigger AND no better: if the re-encode
    // did not pay off, deliver the original bytes instead.
    if (!job.targetMb && outStat.size >= job.sourceBytes) {
      await fsp.copyFile(paths.source, paths.output);
      outStat = await fsp.stat(paths.output);
      usedOriginal = true;
      notes.push('Re-encoding would have made this bigger, so the original file is what gets shared.');
    }
  }

  /* The source is only needed while encoding. Deleting it now roughly halves
     what a job occupies on disk, which matters on a 32 GB machine handling
     multi-gigabyte 4K files. */
  await fsp.rm(paths.source, { force: true }).catch(() => {});

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
    videoKbps,
    usedOriginal,
    audioMode,
    twoPass,
    scaledTo: scaleNote,
    outputSize: outSize,
    projection: job.projection || null,
    saved,
  });
  writeResultsFile();

  // The point of the app is the link, not the local file: hand it to a host now.
  if (AUTO_HOST) {
    const free = await sources.freeDiskBytes(jobsStore.DATA_DIR);
    if (free > outStat.size * 3) hostJob(job, { order: job.hostOrder }).catch(() => {});
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
    writeResultsFile();
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

/** Keep an append-only ledger of share links, independent of job cleanup. */
async function persistHostedLink(job, url, provider) {
  await ledger.record({
    jobId: job.id,
    url,
    provider,
    name: job.outputName,
    sourceBytes: job.sourceBytes,
    outputBytes: job.outputBytes,
    at: Date.now(),
  });
  // Older releases wrote links.json; keep writing it so no history is lost.
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
  FILEDITCH_FAILED: 'That fileditch link has expired or the page is gone. Paste the page itself (theditch.st/… or fileditchfiles.me/…) and a fresh link is minted for you.',
  FILEDITCH_NO_LINK: 'fileditch did not offer a download for that page — it may have been removed.',
  FILESTER_BLOCKED: 'filester refused the request (its bot protection). Paste the share page again, or pick another host.',
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

const OUT_OF_SPACE = /ENOSPC|No space left on device/i;

const formatGb = (bytes) => `${(bytes / 1073741824).toFixed(1)} GB`;
const formatSize = (bytes) =>
  bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;

/** Total/used/free for the volume that holds the working files. */
async function diskUsage(dir) {
  try {
    const stats = await fsp.statfs(dir);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      totalBytes,
      freeBytes,
      usedBytes: totalBytes - freeBytes,
      percentFree: totalBytes ? Math.round((freeBytes / totalBytes) * 100) : null,
    };
  } catch {
    return { totalBytes: null, freeBytes: null, usedBytes: null, percentFree: null };
  }
}

function reportJobError(job, err) {
  const outOfSpace = err.code === 'NO_DISK' || OUT_OF_SPACE.test(String(err.message || ''));
  /* When the encoder refuses a file, the reason matters more than the apology:
     "ffmpeg could not process this file" hides whether it was the container, the
     bit depth or a codec this build cannot decode. */
  const ffmpegDetail = err.code === 'FFMPEG_FAILED' ? (err.detail || '').trim() : '';
  const message = outOfSpace
    ? 'This machine ran out of disk space. Delete finished videos (the Remove button) and try again — a long 4K file needs about three times its own size free.'
    : err.code === 'FFMPEG_FAILED'
      ? `ffmpeg could not process this file${err.codecNote ? ` (${err.codecNote})` : ''}.` +
        `${ffmpegDetail ? ` It said: ${ffmpegDetail}` : ''} Try another preset, or a different source file.`
      : FRIENDLY[err.code] || err.message || 'Something went wrong while compressing.';
  jobsStore.updateJob(job, {
    status: 'error',
    stage: outOfSpace ? 'Out of disk space' : 'Failed',
    error: message,
    speed: null,
  });
  console.error(`[job ${job.id}] ${outOfSpace ? 'NO_DISK' : err.code || 'ERR'}:`, err.message?.slice(0, 600));

  /* A failed job leaves a partial source and half an output behind. On a small
     disk those are exactly what stops the next job, so drop them now. */
  const paths = jobsStore.jobPaths(job);
  fsp.rm(paths.source, { force: true }).catch(() => {});
  fsp.rm(paths.output, { force: true }).catch(() => {});
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
    /* Encoding needs the source plus the output plus room for the encoder's
       own scratch files, so require ~2.2x the file and never drop below 1 GB. */
    const needed = Math.max(expected * 2.2, 1024 ** 3);
    if (free < needed) {
      throw Object.assign(
        new Error(
          `Not enough disk space: ${formatGb(free)} free, about ${formatGb(needed)} needed for this file.`,
        ),
        { code: 'NO_DISK' },
      );
    }

    jobsStore.updateJob(job, { status: 'fetching', stage: 'Downloading video', progress: 0 });

    const capture = browserCapture();
    /* Signed links from fileditch and friends expect the page that issued them
       as the referer; resolvers put it on the ref. */
    const refHeaders = {};
    if (ref && ref.referer) {
      refHeaders.referer = ref.referer;
      try {
        refHeaders.origin = new URL(ref.referer).origin;
      } catch {
        /* keep referer only */
      }
    }
    const downloadOptions = {
      maxBytes: MAX_UPLOAD_BYTES,
      extraHeaders: refHeaders,
      signal: controller.signal,
      onProgress: (received, total) => {
        const p = total ? received / total : 0;
        /* A host that trickles (bunkr can) is easier to wait for when the speed
           and the remaining time are on screen. */
        const now = Date.now();
        if (job._dlAt) {
          const seconds = (now - job._dlAt) / 1000;
          if (seconds >= 0.9) {
            const rate = (received - (job._dlBytes || 0)) / seconds;
            if (rate > 0) {
              job.downloadSpeed = rate;
              job.downloadEta = total ? Math.round((total - received) / rate) : null;
            }
            job._dlAt = now;
            job._dlBytes = received;
          }
        } else {
          job._dlAt = now;
          job._dlBytes = received;
        }
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
    };

    /* A host that refuses plain requests (hotlink protection, a bot challenge,
       a player-only signed URL) is retried through a real browser before the
       job is allowed to fail. */
    const attempt = await downloadWithFallback({
      url,
      pageUrl: job.url || url,
      destPath: paths.source,
      download: (target, dest, options) => sources.downloadHttp(target, dest, options),
      capture,
      options: downloadOptions,
      /* fileditch's signed links expire in about half an hour — shorter than a
         queue wait — so fetch a fresh one before giving up. */
      refresh: () => directUrl(ref),
    });
    if (attempt.usedBrowser) {
      job.browserFetched = true;
    }
    if (attempt.refreshed) job.fetchedNote = 'The host had rotated its download link, so a fresh one was minted.';


    /* Trust the host's own file name over anything guessed from a URL: a signed
       CDN link says "abc123", the Content-Disposition says "Holiday.mp4". */
    const hostName = attempt.filename || (await sources.filenameFromUrl(attempt.url || url));
    const named = bestName(job.name, hostName);
    if (named && named !== job.name) {
      jobsStore.updateJob(job, { name: named });
    }

    jobsStore.updateJob(job, {
      progress: 0,
      sourceBytes: (await fsp.stat(paths.source)).size,
      downloadSpeed: null,
      downloadEta: null,
    });
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
let finishedThisSession = 0;

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
    autoStop.cancel('a job started');
    compressJob(job)
      .catch((err) => reportJobError(job, err))
      .finally(() => {
        activeCount -= 1;
        finishedThisSession += 1;
        updateQueuePositions();
        pumpQueue();
        // Nothing left to do: let the machine go if the user asked for that.
        if (!queue.length && activeCount === 0) autoStop.schedule('queue finished');
      });
  }
  updateQueuePositions();
}

function startCompression(job) {
  jobsStore.updateJob(job, { status: 'queued', stage: 'Queued', progress: 0, error: null, interrupted: false });
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
  const disk = await diskUsage(jobsStore.DATA_DIR);
  res.json({
    ok: true,
    freeBytes: disk.freeBytes,
    freeGb: Math.round((disk.freeBytes / 1073741824) * 10) / 10,
    disk,
    autoStop: autoStop.status(),
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

/* Stop the machine when the queue drains — for metered hosts. */
app.get('/api/auto-stop', (req, res) => res.json({ autoStop: autoStop.status() }));

app.post('/api/auto-stop', (req, res) => {
  const wants = Boolean(req.body && req.body.enabled);
  if (wants && !autoStop.configured()) {
    return fail(
      res,
      400,
      'AUTOSTOP_UNAVAILABLE',
      'This machine has no stop command configured (set AUTO_STOP_COMMAND, or run inside Codespaces).',
    );
  }
  const enabled = autoStop.enable(wants);
  if (!enabled) autoStop.cancel('switched off');
  else if (!queue.length && activeCount === 0 && finishedThisSession) autoStop.schedule('already idle');
  return res.json({ autoStop: autoStop.status() });
});

app.post('/api/auto-stop/cancel', (req, res) => {
  autoStop.cancel('cancelled by the user');
  return res.json({ autoStop: autoStop.status() });
});

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

/* Every resolver that can turn a reference back into a URL. bunkr and filester
   were missing here, so picking a file from either sent a valid ref and got
   "That file reference is not valid." */
const ALLOWED_REF_RESOLVERS = new Set([
  'gofile',
  'turbo',
  'pixeldrain',
  'bunkr',
  'filester',
  'fileditch',
  'direct',
]);

/**
 * Create a job.
 * body: { source: 'url'|'ref'|'upload'|'sample', url?, ref?, name?, presetId?, targetMb? }
 */
app.post('/api/jobs', async (req, res) => {
  const body = req.body || {};
  const source = body.source || 'url';
  const presetId = String(body.presetId || 'balanced');
  const targetMb = Number(body.targetMb) > 0 ? Number(body.targetMb) : null;
  const hostOrder = Array.isArray(body.hostOrder)
    ? body.hostOrder.map((id) => String(id).toLowerCase()).filter((id) => hosters.PROVIDERS[id])
    : [];

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
      hostOrder,
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
    const job = jobsStore.createJob({ source: 'ytdlp', url, presetId, targetMb, name: body.name, hostOrder });
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
    hostOrder,
    presetId,
    targetMb,
    name: body.name || file.name,
    ref: file.ref,
    hostOrder,
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
  writeResultsFile();
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

/* ------------------------------------------------------------------ results */
/* Everything that finished, in one place, so the links survive the machine:
   they are also written to data/results.txt on every completion. */

/** Best-effort finish time: jobs carry createdAt, and the ledger keeps the rest. */
function jobFinishedAt(view) {
  return view.createdAt || null;
}

/** Keep a copy of the share links on disk, so they survive a stopped machine. */
async function writeResultsFile() {
  try {
    const lines = finishedJobs()
      .filter((view) => view.hostedUrl)
      .map((view) => `${view.hostedUrl}\t${view.outputName || view.name || view.id}`);
    await fsp.writeFile(path.join(jobsStore.DATA_DIR, 'results.txt'), lines.length ? `${lines.join('\n')}\n` : '');
  } catch {
    /* the results endpoint still works without the file */
  }
}

function finishedJobs() {
  return jobsStore
    .listJobs()
    .filter((job) => job.status === 'done' || job.status === 'hosted' || job.error)
    .map((job) => jobsStore.publicView(job))
    .filter((view) => view.status === 'done' || view.status === 'hosted');
}

/**
 * Every share link ever produced, newest first.
 *
 * Job records are pruned; the ledger is not. This is what the user sees after
 * closing the tab, restarting the Codespace, or coming back the next morning.
 */
async function allLinks() {
  const [saved, live] = await Promise.all([ledger.list(), Promise.resolve(finishedJobs())]);
  const byUrl = new Map();
  for (const entry of saved) byUrl.set(entry.url, { ...entry, live: false });
  for (const view of live) {
    if (!view.hostedUrl) continue;
    const existing = byUrl.get(view.hostedUrl);
    byUrl.set(view.hostedUrl, {
      ...(existing || {}),
      at: existing?.at || new Date(jobFinishedAt(view) || Date.now()).toISOString(),
      jobId: view.id,
      provider: view.hostProvider,
      url: view.hostedUrl,
      name: view.outputName || view.name || null,
      sourceBytes: view.sourceBytes ?? existing?.sourceBytes ?? null,
      outputBytes: view.outputBytes ?? existing?.outputBytes ?? null,
      live: view.hasFile === true,
      saved: view.saved ?? null,
      usedOriginal: Boolean(view.usedOriginal),
    });
  }
  return [...byUrl.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

app.get('/api/links', async (req, res) => {
  res.json({ links: await allLinks() });
});

app.get('/api/links.txt', async (req, res) => {
  const text = await ledger.text();
  res.type('text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="squeeze-links.txt"');
  res.send(text || 'No share links yet.\n');
});

app.get('/api/results', (req, res) => {
  res.json({
    results: finishedJobs().map((view) => ({
      id: view.id,
      name: view.outputName || view.name || `video-${view.id}.mp4`,
      shareUrl: view.hostedUrl || null,
      provider: view.hostProvider || null,
      downloadPath: view.hasFile ? `/api/jobs/${view.id}/download` : null,
      previewPath: view.hasFile ? `/api/jobs/${view.id}/preview` : null,
      sourceBytes: view.sourceBytes,
      outputBytes: view.outputBytes,
      saved: view.saved,
      usedOriginal: view.usedOriginal,
      finishedAt: jobFinishedAt(view),
    })),
  });
});

app.get('/api/results.txt', (req, res) => {
  const lines = finishedJobs()
    .filter((view) => view.hostedUrl)
    .map((view) => `${view.hostedUrl}\t${view.outputName || view.name || view.id}`);
  res.type('text/plain').send(lines.length ? `${lines.join('\n')}\n` : '');
});

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

  const free = await sources.freeDiskBytes(jobsStore.DATA_DIR);
  console.log(`Free disk: ${formatGb(free)} in ${jobsStore.DATA_DIR}`);
  if (free < 5 * 1024 ** 3) {
    console.warn(
      `[disk] Only ${formatGb(free)} free. A 4K file needs roughly three times its own size ` +
        `while it encodes. Reclaim space with: npm run disk -- --clean`,
    );
  }
  app.listen(PORT, '0.0.0.0');
  await resumeInterrupted();
  resumeHosting();
}

/**
 * A machine that stops mid-encode (a closed laptop, a stopped Codespace, a
 * reboot) leaves the source file behind. Pick those jobs up instead of leaving
 * the user to guess whether it finished. Set RESUME_INTERRUPTED=0 to opt out.
 */
async function resumeInterrupted() {
  if (process.env.RESUME_INTERRUPTED === '0') return;
  const candidates = jobsStore
    .listJobs()
    .filter((job) => job.interrupted && !job.hostedUrl)
    /* A job stopped while downloading may hold a half-written source, so only
       jobs that got as far as encoding are picked up. Those stopped during the
       upload already have their MP4 and are handled by resumeHosting(). */
    .filter((job) => ['compressing', 'queued'].includes(job.interruptedFrom))
    .filter((job) => fs.existsSync(jobsStore.jobPaths(job).source));
  if (!candidates.length) return;

  const free = await sources.freeDiskBytes(jobsStore.DATA_DIR);
  const resumable = [];
  for (const job of candidates) {
    const need = Math.max((Number(job.sourceBytes) || 0) * 1.2, 512 * 1024 ** 2);
    if (free < need) {
      console.warn(`[resume] not enough space to finish ${job.id} (${formatGb(free)} free)`);
      continue;
    }
    resumable.push(job);
  }
  if (!resumable.length) return;
  console.log(`[resume] picking up ${resumable.length} interrupted job(s)`);
  for (const job of resumable.reverse()) startCompression(job);
}

/**
 * A finished encode whose upload never happened (the machine stopped, the tab
 * closed, the host timed out) still has its MP4 on disk. Pick those up at
 * startup instead of making the user notice and press a button.
 */
async function resumeHosting() {
  if (!AUTO_HOST) return;
  const stale = jobsStore
    .listJobs()
    .filter((job) => job.status === 'done' && !job.hostedUrl && !job.hosting)
    .filter((job) => fs.existsSync(jobsStore.jobPaths(job).output));
  if (!stale.length) return;
  console.log(`[resume] ${stale.length} finished file(s) still need a share link`);
  for (const job of stale) {
    await hostJob(job, { order: job.hostOrder }).catch((err) => {
      console.warn(`[resume] ${job.id}: ${err.message}`);
    });
  }
}

if (require.main === module) main();

module.exports = app;
