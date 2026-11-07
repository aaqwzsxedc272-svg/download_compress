#!/usr/bin/env node
/**
 * Real files fail to encode for boring reasons: an MKV that carries PCM audio
 * (MP4 cannot hold it), timestamps that jump, a 10-bit stream that "high
 * profile" will not take. The first attempt is allowed to fail on those; the
 * second must not.
 *
 * This builds a file that genuinely fails the normal plan and proves the
 * forgiving plan rescues it.
 */
'use strict';

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { buildPlan, PRESETS } = require('../server/compress');
const { transcode, usefulLine } = require('../server/ffmpeg');

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
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-300)))));
  });
}

const planFor = (input, output, meta, robust) =>
  buildPlan({
    input,
    output,
    meta,
    preset: PRESETS.auto,
    passlogBase: path.join(path.dirname(output), 'pass'),
    robust,
  });

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-encode-'));

  /* MKV + PCM audio: exactly what filester handed over. The normal plan tries to
     copy that audio into an MP4, which ffmpeg refuses. */
  const source = path.join(dir, 'pcm.mkv');
  await run([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'pcm_s16le',
    '-y', source,
  ]);
  /* The plan decides to copy the audio when it believes the stream is AAC, which
     is what happens when a container reports something the MP4 muxer cannot
     actually take. That is the failure this test recreates. */
  const meta = { duration: 4, hasAudio: true, width: 640, height: 360, audioCodec: 'aac', audioBitrate: 128000 };

  check('the normal plan copies the audio (which MP4 will refuse here)', () => {
    const plan = planFor(source, path.join(dir, 'a.mp4'), meta, false);
    const args = plan.passes[plan.passes.length - 1].args;
    assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  });

  let firstError = null;
  await transcode(source, path.join(dir, 'a.mp4'), planFor(source, path.join(dir, 'a.mp4'), meta, false).passes[0].args).catch(
    (err) => {
      firstError = err;
    },
  );
  check('the normal plan really fails on that file', () => {
    assert.ok(firstError, `the plan unexpectedly worked${firstError ? `: ${firstError.code}` : ''}`);
  });
  check('the failure carries the line a person can act on', () => {
    assert.ok(firstError, 'no error captured');
    assert.ok(firstError.detail, 'ffmpeg said nothing useful');
    assert.doesNotMatch(firstError.detail, /^Conversion failed/i, 'it reported the useless trailer');
    assert.match(firstError.detail, /could not write header|invalid argument|codec/i, `got: ${firstError.detail}`);
  });

  const output = path.join(dir, 'b.mp4');
  await transcode(source, output, planFor(source, output, meta, true).passes[0].args);
  const stat = await fsp.stat(output);
  check('the forgiving plan rescues the same file', () => {
    assert.ok(stat.size > 0, 'the output is empty');
  });

  check('the forgiving plan re-encodes the audio instead of copying it', () => {
    const plan = planFor(source, output, meta, true);
    const args = plan.passes[plan.passes.length - 1].args;
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  });

  check('the forgiving plan stops insisting on high profile', () => {
    const normal = planFor(source, output, meta, false).passes[0].args;
    const robust = planFor(source, output, meta, true).passes[0].args;
    assert.ok(normal.includes('-profile:v'), 'the normal plan should pin the profile');
    assert.ok(!robust.includes('-profile:v'), 'the forgiving plan should drop it');
  });

  check('the forgiving plan asks the muxer to wait', () => {
    const args = planFor(source, output, meta, true).passes[0].args;
    assert.equal(args[args.indexOf('-max_muxing_queue_size') + 1], '4096');
    assert.ok(args.indexOf('-fflags') < args.indexOf('-i'), 'genpts has to come before the input');
  });

  check('encoder chatter is stripped down to the one useful line', () => {
    const noise = [
      'ffmpeg version N-47683 Copyright (c) 2000-2018',
      '  configuration: --enable-gpl',
      "Input #0, matroska,webm, from 'x.mkv':",
      '  Duration: 00:48:40.12, start: 0.000000, bitrate: 6000 kb/s',
      '[aac @ 0x55] Too many packets buffered for output stream 0:1.',
      'Conversion failed!',
    ].join('\n');
    assert.equal(usefulLine(noise), 'Too many packets buffered for output stream 0:1.');
  });

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
