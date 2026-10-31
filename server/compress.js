'use strict';

/**
 * Encoding plans.
 *
 * Priorities, in order: keep the picture looking the same, then get the file as
 * small as possible. That means x264 at a slow preset and a low CRF by default,
 * never upscaling, copying the audio stream when it is already efficient, and
 * using two passes when the user asks for a specific size.
 */

const PRESETS = {
  max: {
    id: 'max',
    label: 'Max quality',
    hint: 'full resolution · near-lossless',
    maxShortSide: null,
    crf: 19,
    x264Preset: 'slow',
    audioKbps: 192,
    maxLift: 6,
  },
  high: {
    id: 'high',
    label: 'High quality',
    hint: 'full resolution · recommended',
    maxShortSide: null,
    crf: 22,
    x264Preset: 'medium', // ~2x realtime at 1080p on two cores; slow is available in Max quality
    audioKbps: 160,
    maxLift: 9,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    hint: 'up to 1080p · much smaller',
    maxShortSide: 1080,
    crf: 24,
    x264Preset: 'fast',
    audioKbps: 128,
    maxLift: 12,
  },
  small: {
    id: 'small',
    label: 'Small',
    hint: 'up to 720p · easy to share',
    maxShortSide: 720,
    crf: 27,
    x264Preset: 'fast',
    audioKbps: 128,
    maxLift: 12,
  },
  tiny: {
    id: 'tiny',
    label: 'Tiny',
    hint: 'up to 480p · smallest file',
    maxShortSide: 480,
    crf: 31,
    x264Preset: 'veryfast',
    audioKbps: 96,
  },
};

const DEFAULT_PRESET = 'high';
const PRESET_LIST = Object.values(PRESETS).map(({ id, label, hint }) => ({ id, label, hint }));

const getPreset = (id) => PRESETS[id] || PRESETS[DEFAULT_PRESET];
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Output dimensions for a source clip under a preset (never upscales). */
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

/** Copy the audio when it is already AAC at a sane bitrate — no quality loss, no time spent. */
function audioPlan(meta, preset) {
  if (!meta.hasAudio) return { mode: 'none' };
  const bitrate = Number(meta.audioBitrate) || 0;
  if (meta.audioCodec === 'aac' && bitrate > 0 && bitrate <= 192000) {
    return { mode: 'copy' };
  }
  return { mode: 'aac', kbps: preset.audioKbps };
}

function baseArgs() {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
}

function videoFilter(meta, size) {
  const scaled = size.width !== meta.width || size.height !== meta.height;
  return scaled ? ['-vf', `scale=${size.width}:${size.height}:flags=lanczos`] : [];
}

/**
 * Build the ffmpeg plan for a job.
 *
 * @returns {{
 *   passes: Array<{args: string[], label: string}>,
 *   size: {width: number, height: number},
 *   audio: object,
 *   videoKbps: number|null,
 *   twoPass: boolean,
 *   scaleNote: string|null,
 * }}
 */
function buildPlan({ input, output, meta, preset, targetMb, passlogBase, crfOverride = null }) {
  const crf = Number.isFinite(crfOverride) ? crfOverride : preset.crf;
  const size = targetSize(meta, preset);
  const audio = audioPlan(meta, preset);
  const duration = Number(meta.duration) || 0;

  // Size-targeted mode: spend the budget on a bitrate and use two passes so the
  // bits land where the detail is. Single-pass CRF cannot hit a size.
  let videoKbps = null;
  const twoPass = Boolean(targetMb && duration > 0);

  if (twoPass) {
    const audioKbps = audio.mode === 'aac' ? audio.kbps : audio.mode === 'copy' ? Math.min(Number(meta.audioBitrate) / 1000 || 128, 192) : 0;
    const totalKbps = (targetMb * 8 * 1024) / duration; // kbit budget per second
    videoKbps = Math.max(80, Math.floor(totalKbps * 0.97 - audioKbps));
  }

  const common = [
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    '-c:v', 'libx264',
    '-preset', preset.x264Preset,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-movflags', '+faststart',
  ];

  const audioArgs =
    audio.mode === 'copy'
      ? ['-c:a', 'copy']
      : audio.mode === 'aac'
        ? ['-c:a', 'aac', '-b:a', `${audio.kbps}k`, '-ac', '2']
        : ['-an'];

  const scaleArgs = videoFilter(meta, size);
  const passes = [];

  if (twoPass) {
    passes.push({
      label: 'Analysing',
      args: [
        ...baseArgs(),
        '-i', input,
        '-map', '0:v:0',
        ...scaleArgs,
        '-c:v', 'libx264',
        '-preset', preset.x264Preset,
        '-b:v', `${videoKbps}k`,
        '-pix_fmt', 'yuv420p',
        '-pass', '1',
        '-passlogfile', passlogBase,
        '-an',
        '-sn',
        '-f', 'null',
        '-progress', 'pipe:1',
        '-nostats',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
      ],
    });
    passes.push({
      label: 'Encoding',
      args: [
        ...baseArgs(),
        '-i', input,
        ...common,
        ...scaleArgs,
        '-b:v', `${videoKbps}k`,
        '-pass', '2',
        '-passlogfile', passlogBase,
        ...audioArgs,
        '-progress', 'pipe:1',
        '-nostats',
        output,
      ],
    });
  } else {
    passes.push({
      label: 'Encoding',
      args: [
        ...baseArgs(),
        '-i', input,
        ...common,
        ...scaleArgs,
        '-crf', String(crf),
        // A ceiling so a long static shot cannot balloon the file.
        '-maxrate', '16M',
        '-bufsize', '32M',
        ...audioArgs,
        '-progress', 'pipe:1',
        '-nostats',
        output,
      ],
    });
  }

  const scaled = size.width !== meta.width || size.height !== meta.height;
  return {
    passes,
    size,
    audio,
    videoKbps,
    crf,
    twoPass,
    scaleNote: scaled ? `${meta.width}×${meta.height} → ${size.width}×${size.height}` : null,
  };
}

/** True when a target-size request leaves too little room for usable video. */
function targetTooSmall({ duration, hasAudio }, preset, targetMb) {
  if (!duration) return false;
  const audio = hasAudio ? preset.audioKbps : 0;
  const kbps = (targetMb * 8 * 1024) / duration;
  return kbps - audio < 80;
}

module.exports = {
  PRESETS,
  PRESET_LIST,
  DEFAULT_PRESET,
  getPreset,
  targetSize,
  audioPlan,
  buildPlan,
  targetTooSmall,
};
