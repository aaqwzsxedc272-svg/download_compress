'use strict';

/**
 * Quality presets. `maxShortSide` caps the *shorter* dimension, which keeps
 * portrait videos sensible (a 1080x1920 clip at "720p" stays 405x720).
 */
const PRESETS = {
  tiny: {
    id: 'tiny',
    label: 'Tiny',
    hint: '360p · smallest file',
    maxShortSide: 360,
    crf: 31,
    audioKbps: 64,
  },
  small: {
    id: 'small',
    label: 'Small',
    hint: '480p · great for sharing',
    maxShortSide: 480,
    crf: 29,
    audioKbps: 96,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    hint: '720p · recommended',
    maxShortSide: 720,
    crf: 26,
    audioKbps: 128,
  },
  high: {
    id: 'high',
    label: 'High',
    hint: '1080p · best quality',
    maxShortSide: 1080,
    crf: 24,
    audioKbps: 128,
  },
  original: {
    id: 'original',
    label: 'Original res',
    hint: 'no downscale',
    maxShortSide: null,
    crf: 27,
    audioKbps: 128,
  },
};

const PRESET_LIST = Object.values(PRESETS).map(({ id, label, hint }) => ({ id, label, hint }));

function getPreset(id) {
  return PRESETS[id] || PRESETS.balanced;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Work out the output dimensions for a source clip under a preset. */
function targetSize({ width, height }, preset) {
  let w = width;
  let h = height;
  const shortSide = Math.min(width, height);
  if (preset.maxShortSide && shortSide > preset.maxShortSide) {
    const factor = preset.maxShortSide / shortSide;
    w = width * factor;
    h = height * factor;
  }
  return { width: even(w), height: even(h) };
}

/**
 * Build the ffmpeg argument list for a compression run.
 * @param {object} opts
 * @param {string} opts.input   source path
 * @param {string} opts.output  destination path (.mp4)
 * @param {object} opts.meta    result of probe()
 * @param {object} opts.preset  preset object
 * @param {number} [opts.targetMb] aim for this output size instead of CRF
 */
function buildArgs({ input, output, meta, preset, targetMb }) {
  const size = targetSize(meta, preset);
  const scaled = size.width !== meta.width || size.height !== meta.height;

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
  ];

  if (scaled) args.push('-vf', `scale=${size.width}:${size.height}`);

  let videoKbps = null;
  const duration = meta.duration || 0;

  // "Fit in N MB" mode: derive a bitrate from duration instead of CRF.
  if (targetMb && duration > 0) {
    const overhead = 1.03;
    const totalKbps = (targetMb * 8 * 1024) / duration / overhead;
    const audioKbps = meta.hasAudio ? preset.audioKbps : 0;
    videoKbps = Math.max(60, Math.floor(totalKbps - audioKbps));
    args.push(
      '-b:v', `${videoKbps}k`,
      '-maxrate', `${Math.round(videoKbps * 1.35)}k`,
      '-bufsize', `${videoKbps * 2}k`,
    );
  } else {
    args.push('-crf', String(preset.crf));
    args.push('-maxrate', '12M', '-bufsize', '24M');
  }

  if (meta.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', `${preset.audioKbps}k`, '-ac', '2');
  }

  args.push(
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    output,
  );

  return { args, videoKbps, size: scaled ? size : { width: meta.width, height: meta.height } };
}

/** True when a target-size request is unrealistic for this clip. */
function targetTooSmall({ duration, hasAudio }, preset, targetMb) {
  if (!duration) return false;
  const audio = hasAudio ? preset.audioKbps : 0;
  const kbps = (targetMb * 8 * 1024) / duration;
  return kbps - audio < 80;
}

module.exports = { PRESETS, PRESET_LIST, getPreset, targetSize, buildArgs, targetTooSmall };
