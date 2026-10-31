'use strict';
/**
 * Predict what an encode will weigh before spending an hour on it.
 *
 * A file that is already efficiently compressed (a 1080p video at ~2 Mbps, for
 * instance) can come out BIGGER at the preset's CRF. Without a prediction the
 * app only discovered that at the end, and returned the original bytes — an hour
 * of CPU for nothing.
 *
 * The trick: encode a few short slices at candidate CRFs, measure them, and
 * scale by duration. Ten seconds per probe, a handful of probes, and the real
 * encode then has a CRF that is known to deliver a saving.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { targetSize, audioPlan } = require('./compress');

/** How much smaller a result must be before it is worth the encode. */
const MIN_SAVING = Number(process.env.SQUEEZE_MIN_SAVING) || 0.12;
/** Seconds of video per probe; 0 disables prediction. */
const PROBE_SECONDS = process.env.SQUEEZE_PROBE_SECONDS == null ? 12 : Number(process.env.SQUEEZE_PROBE_SECONDS);
/** CRF values to try, relative to the preset's own value. */
const CRF_STEPS = [0, 3, 6, 9, 12];
/** CRF points are worth about half the bitrate per 6 steps. */
const CRF_PER_HALVING = 6;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 512 * 1024) child.kill('SIGKILL');
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`))));
  });
}

/**
 * Encode a short slice and return the bytes per second of video it produced.
 * Two slices (a fifth in and seven tenths in) keep the guess honest, because a
 * quiet scene early on is a poor predictor of a busy one later.
 */
async function measureAt(input, { crf, preset, seconds, duration, workDir, meta = {} }) {
  const sliceSeconds = Math.max(4, Math.min(seconds, Math.floor(duration / 3) || seconds));
  const offsets = duration > sliceSeconds * 4
    ? [Math.floor(duration * 0.2), Math.floor(duration * 0.7)]
    : [0];

  /* Probe exactly what the real encode will do: the "Small"/"Tiny" presets
     downscale, and probing at full size would overstate the result badly. */
  const scaled = meta.width && meta.height ? targetSize(meta, preset) : null;
  const filter =
    scaled && (scaled.width !== meta.width || scaled.height !== meta.height)
      ? ['-vf', `scale=${scaled.width}:${scaled.height}:flags=lanczos`]
      : [];

  let totalBytes = 0;
  for (const [index, offset] of offsets.entries()) {
    const out = path.join(workDir, `probe-${crf}-${index}.mp4`);
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(offset),
      '-t', String(sliceSeconds),
      '-i', input,
      '-map', '0:v:0',
      '-an',
      '-sn',
      ...filter,
      '-c:v', 'libx264',
      '-preset', preset.x264Preset,
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', out,
    ]);
    const stat = await fsp.stat(out);
    await fsp.rm(out, { force: true }).catch(() => {});
    totalBytes += stat.size;
  }
  const bytesPerSecond = totalBytes / (sliceSeconds * offsets.length);
  return bytesPerSecond;
}

/**
 * Pick a CRF that is projected to save at least MIN_SAVING.
 *
 * The first probe is at the preset's own CRF. If that already saves enough, one
 * probe is the whole cost. If not, x264's size curve says every 6 CRF points
 * halves the bitrate, so the CRF that should hit the target is interpolated and
 * confirmed with a second probe — no five-step walk through the whole range.
 *
 * @returns {{crf:number, projectedBytes:number, saving:number, probes:number}}
 */
async function chooseCrf({ input, meta, preset, sourceBytes, workDir, onProbe = () => {} }) {
  const duration = Number(meta.duration) || 0;
  /* Match the audio plan the real encode will use: a copied AAC stream keeps its
     own bitrate, a re-encode uses the preset's. */
  const audio = audioPlan(meta, preset);
  const audioKbps = audio.mode === 'copy'
    ? (Number(meta.audioBitrate) || 0) / 1000 || Number(preset.audioKbps) || 128
    : audio.mode === 'aac'
      ? Number(preset.audioKbps) || 128
      : 0;
  const audioBytes = (audioKbps * 1000 * duration) / 8;

  const nope = { crf: preset.crf, projectedBytes: Infinity, saving: 0, probes: 0 };
  if (!PROBE_SECONDS || !duration || !sourceBytes) return nope;

  const base = Math.min(34, Number(preset.crf) || 23);
  /* A quality preset is a promise: "max" may only nudge the CRF, while
     "balanced" is allowed to trade a lot more quality for size. */
  const lift = Number.isFinite(preset.maxLift) ? preset.maxLift : Math.max(...CRF_STEPS);
  const ceiling = Math.max(base, Math.min(34, base + lift));
  const probed = new Map();
  let best = null;

  const probe = async (crf) => {
    const p = Math.min(ceiling, Math.max(0, Math.round(crf)));
    if (probed.has(p)) return probed.get(p);
    let bytesPerSecond;
    try {
      bytesPerSecond = await measureAt(input, {
        crf: p,
        preset,
        seconds: PROBE_SECONDS,
        duration,
        workDir,
        meta,
      });
    } catch {
      return null; // probing is a nicety, never a blocker
    }
    const projectedBytes = Math.round(bytesPerSecond * duration + audioBytes);
    const result = { crf: p, projectedBytes, saving: 1 - projectedBytes / sourceBytes, probes: probed.size + 1 };
    probed.set(p, result);
    onProbe(result);
    if (!best || result.saving > best.saving) best = result;
    return result;
  };

  const first = await probe(base);
  if (!first) return nope; // ffmpeg could not cut a slice: fall back to the preset

  // `probes` on the result is for logs and tests: how many slices were weighed.
  const finish = () => {
    if (best) best.probes = probed.size;
    return best;
  };
  const good = () => best && best.saving >= MIN_SAVING;
  if (good()) return finish();

  // A re-encode that only just beats the original is not worth the quality cost,
  // so aim a little past the threshold.
  const targetBytes = sourceBytes * (1 - MIN_SAVING - 0.02);
  const perSecond = (first.projectedBytes - audioBytes) / duration;
  const wanted = perSecond > 0 ? first.crf + CRF_PER_HALVING * Math.log2(perSecond / ((targetBytes - audioBytes) / duration)) : ceiling;

  const second = await probe(Math.min(ceiling, Math.ceil(wanted)));
  if (second && (good() || second.crf >= ceiling)) return finish();
  if (!second && best) return finish();

  // The interpolation missed: one last try at the ceiling (CRF 34 is as flat as
  // this encoder goes).
  await probe(ceiling);
  return finish() || nope;
}

module.exports = { chooseCrf, measureAt, MIN_SAVING, PROBE_SECONDS };
