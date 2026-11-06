'use strict';
/**
 * Decide how to encode a file before spending an hour encoding it.
 *
 * Two things have to be true of the result, in this order:
 *
 *   1. it looks as good as the source. That is a hard rule, expressed as a CRF
 *      ceiling and a resolution floor (see server/compress.js). A file that
 *      cannot get smaller inside those rules is not encoded at all.
 *   2. it is smaller. Only after rule 1, using whatever headroom is left.
 *
 * The way to know is to measure: encode a couple of short slices at candidate
 * settings and scale by duration. A 12-second slice costs seconds, a wrong guess
 * costs an hour.
 *
 * The ladder is two groups: the preset's own frame size, then 720p.
 *
 *   preset resolution @ preset CRF   (no quality cost at all)
 *   preset resolution @ CRF ceiling  (a small, invisible cost)
 *   720p @ preset CRF                (crisper, smaller, honest about the size)
 *   720p @ CRF ceiling
 *   give up and keep the original    (it is already as small as it gets)
 *
 * **Every rung of a group is measured before the group is judged.** Stopping at
 * the first rung that saved 12% left the rest of the quality budget unspent:
 * a 720p film whose re-encode at CRF 23 saved 12% was handed back at 12% when
 * the same film at CRF 26 — still inside the quality rules — would have saved
 * 25%. The frame size is chosen first (a 1080p file is not downscaled for a few
 * more percent, because frame size is what people see), and inside one frame
 * size the smallest result wins, because the CRF ceiling *is* the promise.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { targetSize, audioPlan, CRF_CEILING, MIN_SHORT_SIDE } = require('./compress');

/** How much smaller a result must be before an encode is worth doing. */
const MIN_SAVING = Number(process.env.SQUEEZE_MIN_SAVING) || 0.12;
/** Seconds of video per probe; 0 disables prediction. */
const PROBE_SECONDS = process.env.SQUEEZE_PROBE_SECONDS == null ? 12 : Number(process.env.SQUEEZE_PROBE_SECONDS);

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
 * Encode a short slice exactly the way the real encode would — same CRF, same
 * filters, same scaled size — and return the bytes per second it produced.
 * Two slices (a fifth in and seven tenths in) keep the guess honest, because a
 * quiet scene early on is a poor predictor of a busy one later.
 */
async function measureAt(input, { crf, preset, seconds, duration, workDir, meta = {}, maxShortSide = null }) {
  const sliceSeconds = Math.max(4, Math.min(seconds, Math.floor(duration / 3) || seconds));
  const offsets = duration > sliceSeconds * 4
    ? [Math.floor(duration * 0.2), Math.floor(duration * 0.7)]
    : [0];

  const scaled = meta.width && meta.height ? targetSize(meta, preset, { maxShortSide }) : null;
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
  return totalBytes / (sliceSeconds * offsets.length);
}

/** The CRF a preset may reach before it would rather downscale instead. */
function ceilingFor(preset) {
  const lift = Number.isFinite(preset.maxLift) ? preset.maxLift : 0;
  return Math.max(preset.crf, Math.min(CRF_CEILING, preset.crf + lift));
}

/**
 * The decision, separated from the measuring.
 *
 * `results` is the probes of *one* frame size, in the order they were offered.
 * The smallest projection wins as long as it clears `minSaving`; when none
 * does, the best saving is returned anyway so the caller can say what it found
 * and keep the original.
 *
 * Being a plain function is the point: the rule is what regressed, and a rule
 * that can only be tested by encoding an hour of video is a rule that will
 * regress again.
 */
function chooseFromProbes(results, { minSaving = MIN_SAVING } = {}) {
  if (!results || !results.length) return null;
  const fits = results.filter((result) => result.saving >= minSaving);
  if (fits.length) {
    return fits.reduce((best, result) => (result.projectedBytes < best.projectedBytes ? result : best));
  }
  return results.reduce((best, result) => (result.saving > best.saving ? result : best));
}

/**
 * Choose settings that are predicted to save at least MIN_SAVING without
 * breaking a quality rule.
 *
 * @returns {{
 *   crf: number,
 *   maxShortSide: number|null,
 *   projectedBytes: number,
 *   saving: number,
 *   probes: number,
 *   size: {width: number, height: number}|null,
 * }}
 */
async function chooseCrf({ input, meta, preset, sourceBytes, workDir, onProbe = () => {} }) {
  const duration = Number(meta.duration) || 0;
  const audio = audioPlan(meta, preset);
  const audioKbps = audio.mode === 'copy'
    ? (Number(meta.audioBitrate) || 0) / 1000 || Number(preset.audioKbps) || 128
    : audio.mode === 'aac'
      ? Number(preset.audioKbps) || 128
      : 0;
  const audioBytes = (audioKbps * 1000 * duration) / 8;

  const sizeAt = (maxShortSide) => (meta.width && meta.height ? targetSize(meta, preset, { maxShortSide }) : null);
  const label = (maxShortSide) => {
    const size = sizeAt(maxShortSide);
    return size ? `${size.width}x${size.height}` : 'source';
  };

  const nope = {
    crf: preset.crf,
    maxShortSide: preset.maxShortSide || null,
    projectedBytes: Infinity,
    saving: 0,
    probes: 0,
    size: sizeAt(preset.maxShortSide || null),
  };
  if (!PROBE_SECONDS || !duration || !sourceBytes) return nope;

  const ceiling = ceilingFor(preset);

  /* The ladder, grouped by frame size and sharpest group first. A rung is only
     added when it actually changes something. */
  const groups = [];
  const groupFor = (maxShortSide) => {
    const cap = maxShortSide == null ? null : Math.round(maxShortSide);
    let group = groups.find((item) => item.cap === cap);
    if (!group) {
      group = { cap, rungs: [] };
      groups.push(group);
    }
    return group;
  };
  const add = (maxShortSide, crf) => {
    const group = groupFor(maxShortSide);
    const key = `${label(group.cap)}@${crf}`;
    if (group.rungs.some((rung) => rung.key === key)) return;
    group.rungs.push({ key, maxShortSide: group.cap, crf });
  };

  add(preset.maxShortSide || null, preset.crf);
  if (ceiling > preset.crf) add(preset.maxShortSide || null, ceiling);
  // A 720p source cannot benefit from a 720p cap; only offer it as a rescue for
  // bigger sources.
  const sourceShort = Math.min(Number(meta.width) || 0, Number(meta.height) || 0);
  if (!sourceShort || sourceShort > MIN_SHORT_SIDE) {
    add(MIN_SHORT_SIDE, preset.crf);
    if (ceiling > preset.crf) add(MIN_SHORT_SIDE, ceiling);
  }

  let chosen = null;
  let bestOverall = null;
  const probes = [];
  for (const group of groups) {
    const measured = [];
    for (const rung of group.rungs) {
      let bytesPerSecond;
      try {
        bytesPerSecond = await measureAt(input, {
          crf: rung.crf,
          preset,
          seconds: PROBE_SECONDS,
          duration,
          workDir,
          meta,
          maxShortSide: rung.maxShortSide,
        });
      } catch {
        return nope; // probing is a nicety, never a blocker
      }
      const projectedBytes = Math.round(bytesPerSecond * duration + audioBytes);
      const result = {
        crf: rung.crf,
        maxShortSide: rung.maxShortSide,
        projectedBytes,
        saving: 1 - projectedBytes / sourceBytes,
        probes: 0,
        size: sizeAt(rung.maxShortSide),
      };
      onProbe(result);
      measured.push(result);
      probes.push(result);
      if (!bestOverall || result.saving > bestOverall.saving) bestOverall = result;
    }
    const pick = chooseFromProbes(measured, { minSaving: MIN_SAVING });
    /* A group only wins if something in it actually clears the bar; otherwise
       the next (smaller) frame size gets its turn. */
    if (pick && pick.saving >= MIN_SAVING) {
      chosen = pick;
      break;
    }
  }

  const best = chosen || bestOverall;
  if (!best) return nope;
  best.probes = probes.length;
  return best;
}

module.exports = {
  chooseCrf,
  chooseFromProbes,
  measureAt,
  ceilingFor,
  MIN_SAVING,
  PROBE_SECONDS,
  CRF_CEILING,
  MIN_SHORT_SIDE,
};
