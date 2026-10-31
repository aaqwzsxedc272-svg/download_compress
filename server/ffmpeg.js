'use strict';

const { spawn } = require('node:child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

/** Run a process and collect stdout/stderr (used for short-lived commands). */
function execFile(bin, args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
      if (stdout.length > maxBuffer) child.kill('SIGKILL');
    });
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > maxBuffer) child.kill('SIGKILL');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(stderr.trim() || `exit ${code}`), { code, stderr }));
    });
  });
}

/** Read duration / dimensions / codecs for a media file. */
async function probe(file) {
  let raw;
  try {
    raw = await execFile(ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '-i', file,
    ]);
  } catch {
    throw Object.assign(new Error('That file is not a video this server can read.'), {
      code: 'INVALID_MEDIA',
    });
  }
  const info = JSON.parse(raw);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video) {
    throw Object.assign(new Error('That file does not contain a video track.'), { code: 'NO_VIDEO' });
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  // Some containers report duration only on the stream.
  let duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = 0;

  let width = Number(video.width) || 0;
  let height = Number(video.height) || 0;
  // ffmpeg auto-rotates on decode, so swap for 90/270 degree sources.
  const rotation = Number(
    video.tags?.rotate ?? video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0,
  );
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

  const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;

  return {
    duration,
    width,
    height,
    fps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0,
    videoCodec: video.codec_name || null,
    audioCodec: audio?.codec_name || null,
    hasAudio: Boolean(audio),
    bitrate: Number(info.format?.bit_rate) || null,
  };
}

/** Grab a single JPEG frame for the UI thumbnail. */
async function thumbnail(file, outPath, duration) {
  const at = duration && duration > 2 ? Math.min(2, duration * 0.15) : 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (at > 0) args.push('-ss', at.toFixed(3));
  args.push(
    '-i', file,
    '-frames:v', '1',
    '-vf', 'scale=480:-2',
    '-q:v', '6',
    outPath,
  );
  await execFile(ffmpegPath, args);
  return outPath;
}

function parseTimecode(value) {
  // out_time=00:01:23.456000
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(value).trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Transcode with live progress reporting.
 * onProgress receives { seconds, speed, fps } as ffmpeg reports it.
 */
function transcode(input, output, args, { onProgress, duration = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdoutBuf = '';
    let killed = false;

    const onAbort = () => {
      killed = true;
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === 'out_time' && onProgress) {
          const seconds = parseTimecode(value);
          if (seconds != null) onProgress({ seconds });
        } else if (key === 'speed' && onProgress) {
          const speed = Number(String(value).replace('x', ''));
          if (Number.isFinite(speed)) onProgress({ speed });
        } else if (key === 'progress' && value === 'end') {
          if (onProgress) onProgress({ seconds: duration });
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (killed) return reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      if (code === 0) return resolve({ stderr });
      reject(Object.assign(new Error(stderr.trim() || `ffmpeg exited with code ${code}`), {
        code: 'FFMPEG_FAILED',
        stderr,
      }));
    });
  });
}

module.exports = { ffmpegPath, ffprobePath, probe, thumbnail, transcode, execFile };
