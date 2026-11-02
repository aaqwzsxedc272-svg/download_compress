#!/usr/bin/env node
/**
 * "It sat at 0% for twenty minutes."
 *
 * The bar was not lying about the work being slow — it was lying about the work
 * being *nothing*. ffmpeg prints progress in blocks that end with `progress=`:
 *
 *     out_time=00:00:41.360000
 *     speed=0.04x
 *     progress=continue
 *
 * The old reader called `onProgress({ seconds })` and then, a line later,
 * `onProgress({ speed })`. The second call had no `seconds`, and the segmented
 * encoder did `Number(seconds) || 0` — so every block finished by setting the
 * position back to the start of that part. On a 4K file a part is 15–25
 * minutes, which is exactly the "0%" that was reported from a machine that was
 * working perfectly hard the whole time.
 *
 * This test feeds the reader the real block order (recorded from this ffmpeg)
 * and a real encode, and checks that the position never falls back to zero.
 *
 *   npm run test:progress
 */
'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { makeProgressReader, transcode, parseTimecode } = require('../server/ffmpeg');

let passed = 0;
let failures = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failures += 1;
  console.log(`[${ok ? '  ok  ' : '  FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/* One block exactly as ffmpeg 6 printed it during a real segment encode. */
const BLOCK = [
  'frame=1240',
  'fps=0.90',
  'stream_0_0_q=28.0',
  'bitrate= 412.3kbits/s',
  'total_size=1048576',
  'out_time_us=41360000',
  'out_time_ms=41360000',
  'out_time=00:00:41.360000',
  'dup_frames=0',
  'drop_frames=0',
  'speed=0.04x',
  'progress=continue',
];

function feed(lines, options) {
  const events = [];
  const reader = makeProgressReader((event) => events.push(event), options);
  for (const line of lines) reader.line(line);
  return events;
}

(async () => {
  check('a timecode is read', parseTimecode('00:00:41.360000') === 41.36);

  const events = feed(BLOCK);
  check('one block produces one event, not two', events.length === 1, `${events.length} event(s)`);
  check(
    'and the event carries the time and the speed together',
    events[0].seconds === 41.36 && events[0].speed === 0.04,
    JSON.stringify(events[0]),
  );

  /* The bug, as the encoder experienced it: on a 5-second part, the time lands
     and then a speed-only update used to arrive. The old code turned that into
     position 0. Here, no event at all is emitted without a time, so there is
     nothing to reset the bar with. */
  const spooled = [
    ...BLOCK.slice(0, 7),
    'out_time=00:00:01.000000',
    'speed=0.50x',
    'progress=continue',
    'out_time=00:00:02.000000',
    'speed=0.51x',
    'progress=continue',
    'out_time=00:00:02.500000',
    'speed=0.52x',
    'progress=continue',
  ];
  const events2 = feed(spooled);
  check('three blocks are three events', events2.length === 3, `${events2.length}`);
  check(
    'every event after the first carries a time — a speed-only update cannot happen',
    events2.every((event) => Number.isFinite(event.seconds)),
    JSON.stringify(events2.map((e) => e.seconds)),
  );
  check(
    'so the position only ever moves forward',
    events2.every((event, index) => index === 0 || event.seconds >= events2[index - 1].seconds),
    events2.map((e) => e.seconds).join(' → '),
  );

  /* `-ss` seeked parts start their output clock at zero: that is what makes a
     part's own percentage meaningful. */
  const parts = feed(['out_time=00:00:00.000000', 'speed=0.10x', 'progress=continue']);
  check('a seeked part starts its clock at zero', parts[0].seconds === 0);

  /* ffmpeg can report N/A before the first frame. */
  const early = feed(['out_time=N/A', 'speed=N/A', 'progress=continue']);
  check('a block with no usable numbers is not passed on as "0 seconds"', early.length === 0);

  const ended = feed(['out_time=00:00:04.900000', 'speed=1.0x', 'progress=end'], { duration: 5 });
  check(
    'the last block of a pass says the pass is finished, not 98% finished',
    ended[ended.length - 1].seconds === 5,
    JSON.stringify(ended),
  );

  /* ---------------------------------------------------------------- real ffmpeg */
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-progress-'));
  try {
    const source = path.join(dir, 'src.mp4');
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
        source,
      ]);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });

    const seen = [];
    await transcode(
      source,
      path.join(dir, 'out.mp4'),
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', source,
        '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-an',
        '-progress', 'pipe:1', '-nostats',
        path.join(dir, 'out.mp4'),
      ],
      { duration: 6, onProgress: ({ seconds, speed }) => seen.push({ seconds, speed }) },
    );

    check('a real encode reports several times', seen.length >= 2, `${seen.length} update(s)`);
    check(
      'each of those updates still carries both numbers',
      seen.every((event) => Number.isFinite(event.seconds)),
      JSON.stringify(seen.slice(0, 4)),
    );
    check(
      'and the reported position climbs from start to finish',
      seen.length > 1 && seen[seen.length - 1].seconds >= seen[0].seconds,
      `${seen[0]?.seconds}s → ${seen[seen.length - 1]?.seconds}s`,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('progress run crashed:', err);
  process.exit(1);
});
