'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ffmpegPath, makeProgressReader, usefulLine } = require('./ffmpeg');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/** Hosts that need a platform extractor rather than a plain file download. */
const PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch',
  'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com',
  'reddit.com', 'redd.it', 'twitch.tv', 'soundcloud.com',
  'bilibili.com', 'pinterest.com', 'linkedin.com', 'snapchat.com',
  'streamable.com', 'rumble.com', 'odysee.com', 'tumblr.com',
];

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|mpe?g|ts|m3u8|mpd|3gp|ogv)(?:$|[?#])/i;

function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // A public link needs a dotted host; single words are typos, not domains.
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return null;
  return parsed.toString();
}

function platformFor(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return PLATFORM_HOSTS.find((p) => host === p || host.endsWith(`.${p}`)) || null;
  } catch {
    return null;
  }
}

const looksLikeVideoFile = (url) => VIDEO_EXT.test(url || '');

/** HLS / DASH playlists are streams, not files — they need an extractor. */
const looksLikePlaylist = (url) => /\.(m3u8|mpd)(?:[?#]|$)/i.test(url || '') ||
  /[?&](?:format|type)=m3u8/i.test(url || '');

const PLAYLIST_TYPES = ['mpegurl', 'dash+xml', 'x-mpegurl'];

/* ------------------------------------------------------------------ yt-dlp */

let ytdlpCommand; // undefined = not checked yet, null = unavailable

async function detectYtdlp() {
  const candidates = [
    ['python3', ['-m', 'yt_dlp']],
    ['python', ['-m', 'yt_dlp']],
    ['yt-dlp', []],
  ];
  for (const [bin, prefix] of candidates) {
    const ok = await new Promise((resolve) => {
      const child = spawn(bin, [...prefix, '--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    });
    if (ok) return { bin, prefix, version: ok };
  }
  return null;
}

async function hasYtdlp() {
  if (ytdlpCommand === undefined) ytdlpCommand = await detectYtdlp();
  return ytdlpCommand;
}

/** Download a platform link with yt-dlp and return the resulting file path. */
async function downloadPlatform(url, destDir, { onProgress, timeoutMs = 8 * 60 * 1000 } = {}) {
  const tool = await hasYtdlp();
  if (!tool) {
    throw Object.assign(new Error('yt-dlp is not installed on this server.'), { code: 'NO_YTDLP' });
  }
  const template = path.join(destDir, 'platform.%(ext)s');
  const output = path.join(destDir, 'source');

  await new Promise((resolve, reject) => {
    const child = spawn(
      tool.bin,
      [
        ...tool.prefix,
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--no-part',
        '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegPath,
        '-o', template,
        '--', url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      reject(Object.assign(new Error('The platform download timed out.'), { code: 'TIMEOUT' }));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(chunk);
      if (match && onProgress) onProgress(Number(match[1]) / 100);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(stderr.trim() || `yt-dlp exited ${code}`), { code: 'YTDLP_FAILED' }));
    });
  });

  const files = (await fsp.readdir(destDir)).filter((f) => f.startsWith('platform.'));
  const source = files.find((f) => /\.(mp4|mkv|webm|mov|m4v)$/i.test(f));
  if (!source) throw Object.assign(new Error('yt-dlp produced no video file.'), { code: 'YTDLP_FAILED' });
  await fsp.rename(path.join(destDir, source), output);
  return output;
}

/* --------------------------------------------------------- direct http GET */

/** Cheap reachability check from the server. Never throws. */
async function probeRemote(url, { timeoutMs = 6000, headers: extraHeaders = {} } = {}) {
  if (isBlockedHost(url)) return { reachable: false, status: 0, error: 'blocked-host' };
  const attempt = async (method, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, redirect: 'follow', signal: controller.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await attempt('HEAD', { 'user-agent': UA, ...extraHeaders });
    if (!res.ok || !res.headers.get('content-length')) {
      res = await attempt('GET', { 'user-agent': UA, range: 'bytes=0-0', ...extraHeaders });
    }
    const type = res.headers.get('content-type') || '';
    const length = Number(res.headers.get('content-range')?.split('/')?.[1] || res.headers.get('content-length') || 0);
    if (res.body) res.body.cancel().catch(() => {});
    return {
      reachable: res.ok || res.status === 206,
      status: res.status,
      contentType: type,
      contentLength: Number.isFinite(length) ? length : 0,
      isHtml: type.includes('text/html'),
    };
  } catch (err) {
    return { reachable: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|169\.254\.169\.254|metadata\.google\.internal)/i;

/** Refuse obviously internal targets unless explicitly allowed (SSRF guard). */
function isBlockedHost(rawUrl) {
  if (process.env.ALLOW_PRIVATE_HOSTS === '1') return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return BLOCKED_HOSTS.test(host);
  } catch {
    return true;
  }
}

/** Free bytes on the volume that holds `dir`. */
async function freeDiskBytes(dir) {
  try {
    const stats = await fsp.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Stream a remote file to disk, reporting byte progress. */
/** "attachment; filename*=UTF-8''Name.mp4" / filename="Name.mp4" -> Name.mp4 */
function filenameFrom(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* malformed escape: fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** The last path segment, when it looks like a file name rather than a token. */
function filenameFromUrl(raw) {
  try {
    const last = decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).pop() || '');
    return /\.[a-z0-9]{2,5}$/i.test(last) ? last : null;
  } catch {
    return null;
  }
}

/** "512 MB" — for a sentence about a short download. */
const formatMb = (bytes) => (bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.round(bytes / 1024)} KB`);

async function downloadHttp(
  url,
  destPath,
  {
    onProgress,
    maxBytes = 1024 ** 3,
    idleTimeoutMs = 45_000,
    signal: outerSignal,
    extraHeaders = {},
    /* Continue a download that was cut off (a crashed machine, a stopped
       Codespace) instead of fetching the same gigabytes again. */
    resumeFrom = 0,
    expectTotal = 0,
    /* Called as soon as the headers are in, before a single byte is written:
       the size and URL have to be recorded *before* the transfer can be cut
       off by a crash, or the next run has nothing to resume against. */
    onStart = null,
  } = {},
) {
  if (isBlockedHost(url)) {
    throw Object.assign(new Error('That address is not allowed.'), { code: 'BLOCKED_HOST' });
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (outerSignal) outerSignal.addEventListener('abort', forwardAbort, { once: true });
  let idle = setTimeout(() => controller.abort(), idleTimeoutMs);
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), idleTimeoutMs);
  };

  /* Some CDNs (fileditch among them) 403 a bare request but answer a browser:
     same-origin Referer, an Accept-Language and the usual fetch hints. */
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  })();
  const browserHeaders = (withReferer) => ({
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    ...(withReferer && origin ? { referer: `${origin}/`, origin } : {}),
  });

  /* gofile's store hosts answer an HTML page unless the guest account token
     rides along; its own frontend sends exactly this cookie. */
  let hostHeaders = {};
  try {
    if (/(^|\.)gofile\.io$/i.test(new URL(url).hostname)) {
      const { gofileDownloadHeaders } = require('../shared/resolve');
      if (gofileDownloadHeaders) hostHeaders = await gofileDownloadHeaders();
    }
  } catch {
    /* no resolver module (standalone use): carry on without the cookie */
  }

  const rangeHeaders = resumeFrom > 0 ? { range: `bytes=${Math.floor(resumeFrom)}-` } : {};
  let res;
  try {
    res = await fetch(url, {
      headers: { ...browserHeaders(false), ...hostHeaders, ...extraHeaders, ...rangeHeaders },
      redirect: 'follow',
      signal: controller.signal,
    });
    if ((res.status === 403 || res.status === 401) && origin) {
      res.body?.cancel().catch(() => {});
      const retry = await fetch(url, {
        headers: { ...browserHeaders(true), ...hostHeaders, ...extraHeaders },
        redirect: 'follow',
        signal: controller.signal,
      });
      res = retry;
    }
  } catch (err) {
    clearTimeout(idle);
    if (outerSignal && outerSignal.aborted) {
      throw Object.assign(new Error('Download cancelled.'), { code: 'CANCELLED' });
    }
    throw Object.assign(new Error(`Could not reach ${new URL(url).hostname}.`), { code: 'UNREACHABLE' });
  }

  /* A range the server did not honour comes back as 200 with the whole file;
     that is not an error, it just means the download starts over. */
  const partial = resumeFrom > 0 && res.status === 206;
  if (partial) {
    const contentRange = String(res.headers.get('content-range') || '');
    const parsed = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(contentRange);
    const start = parsed ? Number(parsed[1]) : NaN;
    const whole = parsed ? Number(parsed[3]) : 0;
    /* The range has to start exactly where the fragment ends, and (when the
       earlier run recorded it) belong to a file of the same size. A host that
       mints a fresh URL for the same bytes passes this; a different file does
       not. */
    const wrongStart = Number.isFinite(start) && start !== Math.floor(resumeFrom);
    const wrongSize = expectTotal > 0 && whole > 0 && whole !== expectTotal;
    if (wrongStart || wrongSize) {
      res.body?.cancel().catch(() => {});
      clearTimeout(idle);
      throw Object.assign(new Error('The host sent a different range than was asked for.'), { code: 'BAD_RANGE' });
    }
  }
  if (!res.ok || !res.body) {
    clearTimeout(idle);
    throw Object.assign(new Error(`The link returned HTTP ${res.status}.`), { code: 'BAD_STATUS' });
  }

  const total = Number(res.headers.get('content-length') || 0) + (partial ? Math.floor(resumeFrom) : 0);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  /* The host knows what the file is called; a signed CDN URL usually does not.
     Content-Disposition is the only place a name like "Holiday in Rome.mp4"
     survives, and it is what filester was losing. */
  const filename = filenameFrom(res.headers.get('content-disposition')) || filenameFromUrl(res.url);
  if (total > maxBytes) {
    clearTimeout(idle);
    res.body.cancel().catch(() => {});
    throw Object.assign(new Error('That file is larger than this server accepts.'), { code: 'TOO_BIG' });
  }
  if (type.includes('text/html')) {
    clearTimeout(idle);
    res.body.cancel().catch(() => {});
    throw Object.assign(new Error('That link is a web page, not a video file.'), { code: 'HTML_PAGE' });
  }
  if (PLAYLIST_TYPES.some((t) => type.includes(t))) {
    clearTimeout(idle);
    res.body.cancel().catch(() => {});
    throw Object.assign(new Error('That link is a streaming playlist, not a single file.'), {
      code: 'PLAYLIST',
    });
  }

  if (onStart) {
    try {
      onStart({ total, resumeFrom: partial ? Math.floor(resumeFrom) : 0, url: res.url || url, filename });
    } catch {
      /* a callback must never break a download */
    }
  }

  let received = 0;
  const offset = partial ? Math.floor(resumeFrom) : 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    bump();
    if (offset + received > maxBytes) controller.abort();
    if (onProgress) onProgress(offset + received, total);
  });

  /* A crash must not cost the bytes that already arrived, so the partial file
     is left on disk on failure (it is what the next run resumes from). Only a
     deliberate cancel, or a host that lied about the range, throws it away. */
  let out;
  try {
    out = fs.createWriteStream(destPath, { flags: partial ? 'a' : 'w' });
    await pipeline(body, out);
  } catch (err) {
    if (!partial || outerSignal?.aborted) await fsp.rm(destPath, { force: true }).catch(() => {});
    if (outerSignal && outerSignal.aborted) {
      throw Object.assign(new Error('Download cancelled.'), { code: 'CANCELLED' });
    }
    if (offset + received > maxBytes) {
      throw Object.assign(new Error('That file is larger than this server accepts.'), { code: 'TOO_BIG' });
    }
    const kept = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
    throw Object.assign(
      new Error(
        kept
          ? `The download stopped before it finished — ${Math.round(kept / 1048576)} MB are kept and it carries on from there.`
          : 'The download stopped before it finished.',
      ),
      { code: 'DOWNLOAD_FAILED', keptBytes: kept },
    );
  } finally {
    clearTimeout(idle);
    if (outerSignal) outerSignal.removeEventListener('abort', forwardAbort);
  }

  /* A body that ended early without an error is still a short file, and a
     short MP4 is a file with no index — which surfaces later as "not a video",
     three states away from the cause. Say it here, where the fix lives (the
     fragment is on disk, and the next attempt carries on from it). */
  const expected = expectTotal > 0 ? expectTotal : total;
  if (expected > 0 && offset + received < expected) {
    throw Object.assign(
      new Error(
        `The download stopped ${formatMb(expected - (offset + received))} short of ${formatMb(expected)} — ` +
          'the part that arrived is kept, and it carries on from there.',
      ),
      { code: 'DOWNLOAD_FAILED', keptBytes: offset + received, expectedBytes: expected },
    );
  }
  return {
    bytes: offset + received,
    contentType: type,
    filename,
    url: res.url || url,
    resumed: partial,
    total: expected,
  };
}

/* -------------------------------------------------------------- streams */

/**
 * Fetch an HLS (or DASH) stream into one local file.
 *
 * A playlist is a list of segments, so there is nothing a Range request can do
 * with it. ffmpeg is the tool that already knows how to read one, and `-c copy`
 * means it only remuxes: every segment's frames land in the MP4 exactly as the
 * host encoded them. The encoder then treats that MP4 like any other source, so
 * the rest of the pipeline (and its 720p floor, its size checks, its resume)
 * works unchanged.
 *
 * The file is assembled under a `.part` name and only renamed when ffmpeg exits
 * cleanly — the same rule the encoder's parts follow, for the same reason: a
 * machine that stops mid-stream must not leave something that looks like a video.
 */
async function downloadStream(
  url,
  destPath,
  {
    onProgress,
    duration = 0,
    signal,
    extraHeaders = {},
    timeoutMs = 45 * 60 * 1000,
  } = {},
) {
  const temp = `${destPath}.stream.part`;
  await fsp.rm(temp, { force: true }).catch(() => {});

  const headerLines = Object.entries(extraHeaders)
    .filter(([key, value]) => value && !['user-agent'].includes(String(key).toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  const userAgent = extraHeaders['user-agent'] || extraHeaders['User-Agent'] || UA;

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (headerLines) args.push('-headers', `${headerLines}\r\n`);
  args.push('-user_agent', userAgent);
  args.push(
    '-i', url,
    /* Both tracks, if they exist; `?` keeps a video-only stream from failing. */
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-progress', 'pipe:1',
    '-nostats',
    temp,
  );

  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdoutBuf = '';
    let killed = null;
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const stop = (code) => {
      killed = code;
      child.kill('SIGKILL');
    };
    const onAbort = () => stop('CANCELLED');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    if (timer.unref) timer.unref();

    const reader = makeProgressReader(({ seconds, speed }) => {
      if (!onProgress) return;
      let bytes = 0;
      try {
        bytes = fs.statSync(temp).size;
      } catch {
        /* not written yet */
      }
      onProgress({ seconds, speed, bytes, duration });
    }, { duration });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) reader.line(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (killed === 'CANCELLED') {
        return finish(reject, Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      }
      if (killed === 'TIMEOUT') {
        return finish(
          reject,
          Object.assign(
            new Error(
              `The stream was still running after ${Math.round(timeoutMs / 60000)} minutes and was stopped. ` +
                'A live stream never finishes; a very long recording needs a bigger STREAM_TIMEOUT_MINUTES.',
            ),
            { code: 'STREAM_TIMEOUT' },
          ),
        );
      }
      if (code === 0) return finish(resolve, { stderr, tookMs: Date.now() - started });
      return finish(
        reject,
        Object.assign(new Error(stderr.trim() || `ffmpeg exited with code ${code}`), {
          code: 'FFMPEG_FAILED',
          stderr,
          detail: usefulLine(stderr),
        }),
      );
    });
  }).catch(async (err) => {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw err;
  });

  const stat = await fsp.stat(temp).catch(() => null);
  if (!stat || stat.size < 1024) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw Object.assign(
      new Error(
        'The stream produced no video. The server that holds the segments may want the page as its referer, ' +
          'or the stream may have expired.',
      ),
      { code: 'STREAM_EMPTY' },
    );
  }
  await fsp.rm(destPath, { force: true }).catch(() => {});
  await fsp.rename(temp, destPath);
  return { url, total: stat.size, tookMs: result.tookMs };
}


/**
 * Remux a playlist of *local* files into one MP4.
 *
 * This is the second half of the browser download: once the pieces are on
 * disk, ffmpeg has no reason to touch the network — and on a CDN that refuses
 * ffmpeg's HTTP client, touching the network is the whole problem. `-c copy`
 * still keeps every frame exactly as the host encoded it.
 */
async function remuxLocalPlaylist(playlistPath, destPath, { signal, onProgress, duration = 0 } = {}) {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const temp = `${destPath}.remux.part`;
  await fsp.rm(temp, { force: true }).catch(() => {});
  await fsp.mkdir(path.dirname(destPath), { recursive: true }).catch(() => {});

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    /* The pieces keep the extension their CDN used (.ts, .m4s, …). */
    '-allowed_extensions',
    'ALL',
    '-protocol_whitelist',
    'file,crypto',
    '-i',
    playlistPath,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-progress',
    'pipe:1',
    '-nostats',
    temp,
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buffer = '';
    let seconds = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error('Stopped.'), { code: 'CANCELLED' }));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
        const next = Number(value) / 1e6;
        if (Number.isFinite(next) && next > seconds) seconds = next;
        if (onProgress && duration > 0) onProgress(Math.min(0.99, seconds / duration));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (err) => finish(reject, err));
    child.on('close', async (code) => {
      if (signal && signal.aborted) return;
      if (code !== 0) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        const detail = usefulLine(stderr);
        return finish(
          reject,
          Object.assign(new Error(`ffmpeg could not write the stream (${detail || `exit ${code}`}).`), {
            code: 'FFMPEG_FAILED',
            detail,
          }),
        );
      }
      await fsp.rename(temp, destPath).catch(async (err) => finish(reject, err));
      const stat = await fsp.stat(destPath).catch(() => ({ size: 0 }));
      return finish(resolve, { bytes: stat.size, seconds });
    });
  });
}

module.exports = {
  UA,
  normalizeUrl,
  platformFor,
  looksLikeVideoFile,
  looksLikePlaylist,
  hasYtdlp,
  detectYtdlp,
  downloadPlatform,
  probeRemote,
  downloadHttp,
  downloadStream,
  remuxLocalPlaylist,
  isBlockedHost,
  freeDiskBytes,
  filenameFrom,
  filenameFromUrl,
};
