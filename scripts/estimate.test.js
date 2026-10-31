#!/usr/bin/env node
/**
 * Proves the size prediction that stops the app from spending an hour encoding
 * and then handing back the same bytes.
 *
 * A real (tiny) clip is generated with ffmpeg, so this checks the probe->CRF
 * logic against actual encoder output rather than a mock.
 */
'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { chooseCrf, MIN_SAVING } = require('../server/estimate');
const { PRESETS, buildPlan } = require('../server/compress');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-400)))));
  });
}

async function encode(input, output, crf, preset) {
  await run([
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-an', '-sn',
    '-c:v', 'libx264', '-preset', preset.x264Preset, '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-y', output,
  ]);
  const stat = await fsp.stat(output);
  return stat.size;
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-estimate-'));

  /* A source that is already squeezed hard: 6 s, 320x240, CRF 32. Re-encoding it
     at the "max quality" preset's CRF 19 cannot possibly shrink it. */
  const wasteful = path.join(dir, 'already-small.mp4');
  await run([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
    '-pix_fmt', 'yuv420p', '-y', wasteful,
  ]);
  const wastefulBytes = (await fsp.stat(wasteful)).size;

  /* A source that wastes bits: same picture, encoded with a huge target bitrate,
     so there is real room to shrink it. */
  const wastefulHigh = path.join(dir, 'bloated.mp4');
  await run([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '8M',
    '-pix_fmt', 'yuv420p', '-y', wastefulHigh,
  ]);
  const bloatedBytes = (await fsp.stat(wastefulHigh)).size;

  // 1. A hopeless case is recognised instead of being encoded anyway.
  const hopeless = await chooseCrf({
    input: wasteful,
    meta: { duration: 6, hasAudio: false },
    preset: PRESETS.max,
    sourceBytes: wastefulBytes,
    workDir: dir,
  });
  check('a file that cannot shrink is predicted as such', () => {
    assert.ok(hopeless.probes > 0, 'no probe ran, so nothing was predicted');
    assert.ok(hopeless.saving < 0.02, `prediction claimed a ${Math.round(hopeless.saving * 100)}% saving`);
  });
  check('the "max quality" preset never lifts the CRF past +6', () => {
    assert.ok(hopeless.crf <= PRESETS.max.crf + 6, `CRF ${hopeless.crf} breaks the preset promise`);
  });

  // 2. A file that can shrink is given a CRF that actually delivers.
  const rescue = await chooseCrf({
    input: wastefulHigh,
    meta: { duration: 6, hasAudio: false },
    preset: PRESETS.balanced,
    sourceBytes: bloatedBytes,
    workDir: dir,
  });
  check('a bloated file is predicted to shrink by the required margin', () => {
    assert.ok(rescue.saving >= MIN_SAVING, `only ${Math.round(rescue.saving * 100)}% predicted`);
  });
  check('one probe is enough when the preset CRF already saves', () => {
    assert.strictEqual(rescue.probes, 1, `it ran ${rescue.probes} probes`);
  });

  // 3. The prediction is close to reality (within 25%) at the chosen CRF.
  const actual = await encode(wastefulHigh, path.join(dir, 'check.mp4'), rescue.crf, PRESETS.balanced);
  check('the predicted size is within 25% of the real encode', () => {
    const error = Math.abs(actual - rescue.projectedBytes) / actual;
    assert.ok(error <= 0.25, `predicted ${rescue.projectedBytes} vs actual ${actual}`);
  });
  check('the rescued encode really is smaller than the source', () => {
    assert.ok(actual < bloatedBytes * 0.9, `${actual} bytes vs ${bloatedBytes} source`);
  });

  // 4. Probing is a nicety: a broken probe must never block the job.
  const broken = await chooseCrf({
    input: path.join(dir, 'does-not-exist.mp4'),
    meta: { duration: 6, hasAudio: false },
    preset: PRESETS.balanced,
    sourceBytes: 1000000,
    workDir: dir,
  });
  check('a failed probe falls back to the preset CRF', () => {
    assert.strictEqual(broken.probes, 0);
    assert.strictEqual(broken.crf, PRESETS.balanced.crf);
  });

  // 5. buildPlan honours the CRF it is given.
  const plan = buildPlan({
    input: wastefulHigh,
    output: path.join(dir, 'out.mp4'),
    meta: { duration: 6, hasAudio: false, width: 320, height: 240 },
    preset: PRESETS.balanced,
    passlogBase: path.join(dir, 'pass'),
    crfOverride: rescue.crf,
  });
  check('the plan encodes at the CRF that was chosen', () => {
    const args = plan.passes[plan.passes.length - 1].args;
    assert.strictEqual(args[args.indexOf('-crf') + 1], String(rescue.crf));
    assert.strictEqual(plan.crf, rescue.crf);
  });

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
