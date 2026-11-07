#!/usr/bin/env node
'use strict';
/**
 * What is this file, really?
 *
 *   npm run whatis -- data/jobs/nGJLqPTq/source.mp4
 *   npm run whatis -- ~/Downloads/some-file.mp4
 *
 * Prints the container the bytes actually are (not the extension), the size,
 * what ffprobe makes of it, what ffmpeg says when asked to copy it, and the one
 * sentence the app would show if this file were pasted in.
 *
 * The point is a decisive answer in a pasteable form: "it is a RAR archive with
 * .mp4 on the end" and "it is a truncated MP4" need different fixes, and only
 * the bytes can tell them apart.
 */

const path = require('node:path');
const fs = require('node:fs');
const { identify, adviceFor } = require('../server/whatis');
const { probe, repair, usefulLine, ffprobePath, execFile } = require('../server/ffmpeg');

const bytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${n} B`);

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: npm run whatis -- <file>');
    process.exit(2);
  }
  const file = path.resolve(target);
  if (!fs.existsSync(file)) {
    console.error(`There is no file at ${file}`);
    process.exit(1);
  }

  const shape = await identify(file);
  console.log(`file      ${file}`);
  console.log(`size      ${bytes(shape.bytes)}`);
  console.log(`looks     ${shape.label}${shape.brand ? ` (brand ${shape.brand})` : ''} — ${shape.kind}`);
  if (shape.hex) console.log(`first     ${shape.hex}`);
  console.log('');

  /* ffprobe, and its own words when it refuses. */
  let info = null;
  try {
    info = await probe(file);
    console.log('ffprobe   readable');
    console.log(`          ${info.width}×${info.height} · ${Math.round(info.duration)}s · ${info.videoCodec}` +
      `${info.audioCodec ? ` + ${info.audioCodec}` : ' (no audio)'}`);
  } catch (err) {
    console.log(`ffprobe   ${err.code}: ${err.detail || err.message}`);
    try {
      await execFile(ffprobePath, ['-v', 'error', '-i', file]).catch((raw) => {
        const line = usefulLine(raw.stderr);
        if (line) console.log(`          says: ${line}`);
      });
    } catch {
      /* the probe above already printed the useful line */
    }
  }

  if (!info) {
    console.log('');
    console.log('repair    trying a stream copy (no re-encode)…');
    const fixed = await repair(file, { workDir: path.dirname(file) });
    if (fixed.info) {
      console.log(`          repaired: ${fixed.info.width}×${fixed.info.height} · ${Math.round(fixed.info.duration)}s · ${fixed.info.videoCodec}`);
      console.log('          the file on disk was replaced by the readable copy');
      info = fixed.info;
    } else {
      console.log(`          no: ${fixed.detail || 'ffmpeg could not read it either'}`);
    }
  }

  console.log('');
  if (info) {
    console.log('verdict   a real video — it encodes normally');
  } else {
    const advice = adviceFor(shape, { bytes: shape.bytes });
    console.log('verdict   not a video');
    console.log(`          ${advice}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
