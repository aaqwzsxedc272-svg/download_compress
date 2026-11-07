'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ffmpegPath } = require('./ffmpeg');
const { DATA_DIR } = require('./jobs');

const SAMPLE_PATH = path.join(DATA_DIR, 'sample.mp4');
const SAMPLE_TMP = path.join(DATA_DIR, 'sample.building.mp4');

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
];

let building = null;

async function build() {
  const font = FONT_CANDIDATES.find((f) => fs.existsSync(f));
  const label = font
    ? `,drawtext=fontfile=${font}:text='SQUEEZE SAMPLE':fontcolor=white:fontsize=64:` +
      `x=(w-text_w)/2:y=h*0.78:box=1:boxcolor=black@0.45:boxborderw=24`
    : '';

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=45',
    '-f', 'lavfi', '-i', 'sine=frequency=420:sample_rate=48000:duration=45',
    '-vf', `hue=H=2*PI*t/12${label}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-shortest',
    SAMPLE_TMP,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not build the sample clip: ${err.slice(-500)}`));
    });
  });

  // Only move it into place once it is complete, so readers never see a partial file.
  await fsp.rename(SAMPLE_TMP, SAMPLE_PATH);
  return SAMPLE_PATH;
}

/** A ready-made demo clip so the tool can be tried without any external video. */
async function ensureSample() {
  if (fs.existsSync(SAMPLE_PATH)) return SAMPLE_PATH;
  if (!building) {
    building = build().finally(() => {
      building = null;
    });
  }
  return building;
}

module.exports = { ensureSample, SAMPLE_PATH };
