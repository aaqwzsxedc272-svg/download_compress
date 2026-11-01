'use strict';

/**
 * Encoding plans.
 *
 * Priorities, in order: keep the picture looking the same, then get the file as
 * small as possible. That means x264 at a slow preset and a low CRF by default,
 * never upscaling, copying the audio stream when it is already efficient, and
 * using two passes when the user asks for a specific size.
 */

/* ------------------------------------------------------------ quality policy
 * The file has to get smaller, but never at the price of looking worse than
 * the source. Two hard rules, applied to every preset and every automatic
 * decision the app makes:
 *
 *   - the picture is never encoded at a CRF above CRF_CEILING. Past 26, x264
 *     stops throwing away invisible detail and starts throwing away visible
 *     detail: a 1080p file at CRF 34 looks like a 480p one, which is exactly
 *     what made people say "the quality got pretty worse".
 *   - the short side never drops below MIN_SHORT_SIDE (720). When a file cannot
 *     be made smaller without either breaking a rule, the encoder downscales to
 *     720p *once* rather than crushing a 1080p frame: crisp 720p looks better
 *     than muddy 1080p, and it is honest about what it produced.
 */
const CRF_CEILING = 26;
const MIN_SHORT_SIDE = 720;

const PRESETS = {
  auto: {
    id: 'auto',
    label: 'Recommended',
    hint: 'best quality it can afford',
    maxShortSide: 1080,
    crf: 23,
    x264Preset: 'medium',
    audioKbps: 160,
    /* How much a preset may raise the CRF before it prefers to downscale. */
    maxLift: 3,
  },
  max: {
    id: 'max',
    label: 'Max quality',
    hint: 'full resolution · near-lossless',
    maxShortSide: null,
    crf: 19,
    x264Preset: 'slow',
    audioKbps: 192,
    maxLift: 2,
  },
  high: {
    id: 'high',
    label: 'High quality',
    hint: 'full resolution',
    maxShortSide: null,
    crf: 22,
    x264Preset: 'medium', // ~2x realtime at 1080p on two cores
    audioKbps: 160,
    maxLift: 3,
  },
  balanced: {
    id: 'balanced',
    label: 'Smaller',
    hint: 'up to 1080p',
    maxShortSide: 1080,
    crf: 24,
    x264Preset: 'fast',
    audioKbps: 128,
    maxLift: 2,
  },
  small: {
    id: 'small',
    label: 'Smallest',
    hint: 'up to 720p',
    maxShortSide: 720,
    crf: 26,
    x264Preset: 'fast',
    audioKbps: 128,
    maxLift: 0,
  },
};

const DEFAULT_PRESET = 'auto';
const PRESET_LIST = Object.values(PRESETS).map(({ id, label, hint }) => ({ id, label, hint }));

const getPreset = (id) => PRESETS[id] || PRESETS[DEFAULT_PRESET];
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Output dimensions for a source clip under a preset (never upscales). */
function targetSize(meta, preset, { maxShortSide } = {}) {
  const { width, height } = meta;
  const shortSide = Math.min(width, height);
  if (!shortSide) return { width, height };

  const caps = [preset.maxShortSide, maxShortSide].filter((value) => Number(value) > 0);
  const cap = caps.length ? Math.min(...caps) : Infinity;
  // Never upscale, and never below the floor — unless the source already is.
  const floor = Math.min(shortSide, MIN_SHORT_SIDE);
  const target = Math.max(floor, Math.min(shortSide, cap));

  const factor = target / shortSide;
  return { width: even(width * factor), height: even(height * factor) };
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

function videoFilter(meta, size, { robust = false } = {}) {
  const scaled = size.width !== meta.width || size.height !== meta.height;
  const chain = [
    ...(scaled ? [`scale=${size.width}:${size.height}:flags=lanczos`] : []),
    // A 10-bit or 4:2:2 source has to be converted explicitly on old builds.
    ...(robust ? ['format=yuv420p'] : []),
  ];
  return chain.length ? ['-vf', chain.join(',')] : [];
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
function buildPlan({
  input,
  output,
  meta,
  preset,
  targetMb,
  passlogBase,
  crfOverride = null,
  maxShortSide = null,
  robust = false,
}) {
  const crf = Math.min(CRF_CEILING, Number.isFinite(crfOverride) ? crfOverride : preset.crf);
  const size = targetSize(meta, preset, { maxShortSide });
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

  /* MKV/AVI sources are messy: timestamps that go backwards, more packets
     buffered than the muxer likes, 10-bit or 4:2:2 frames that "high profile"
     refuses. `robust` is the second attempt that stops insisting on things. */
  const inputArgs = robust ? ['-fflags', '+genpts'] : [];
  const outputArgs = robust
    ? ['-max_muxing_queue_size', '4096', '-max_interleave_delta', '0']
    : [];

  const common = [
    ...outputArgs,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    '-c:v', 'libx264',
    '-preset', preset.x264Preset,
    '-pix_fmt', 'yuv420p',
    ...(robust ? [] : ['-profile:v', 'high']),
    '-movflags', '+faststart',
  ];

  /* MP4 cannot carry every audio codec an MKV can (PCM, DTS, TrueHD...). When
     the copy is refused, the forgiving attempt re-encodes the audio instead. */
  const audioArgs =
    audio.mode === 'copy' && !robust
      ? ['-c:a', 'copy']
      : robust && audio.mode !== 'none'
        ? ['-c:a', 'aac', '-b:a', `${Math.min(Number(preset.audioKbps) || 128, 192)}k`, '-ac', '2']
      : audio.mode === 'aac'
        ? ['-c:a', 'aac', '-b:a', `${audio.kbps}k`, '-ac', '2']
        : ['-an'];

  const scaleArgs = videoFilter(meta, size, { robust });
  const passes = [];

  if (twoPass) {
    passes.push({
      label: 'Analysing',
      args: [
        ...baseArgs(),
        ...inputArgs,
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
        ...inputArgs,
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
        ...inputArgs,
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
  CRF_CEILING,
  MIN_SHORT_SIDE,
  PRESET_LIST,
  DEFAULT_PRESET,
  getPreset,
  targetSize,
  audioPlan,
  buildPlan,
  targetTooSmall,
};
