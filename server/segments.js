'use strict';
/**
 * Resumable encoding: a long file is encoded in parts, and each finished part
 * is recorded on disk.
 *
 * A Codespace that runs out of minutes, a laptop that sleeps, a closed window —
 * none of them can pause an ffmpeg process. What they *can* do is leave behind
 * the work that was already finished, which is what this module exists for: the
 * video is cut into chunks, every chunk is encoded on its own, and the chunks
 * are joined at the end. A restart re-encodes only what is missing.
 *
 * Why the video only, and the audio at the end:
 *   - joining separately encoded AAC streams leaves gaps and clicks at every
 *     seam, because each piece carries its own encoder delay;
 *   - a video seam is invisible in comparison, and the audio for the whole file
 *     takes seconds to encode once, at the end.
 *
 * The cost is a couple of percent of file size (each chunk starts a fresh
 * encode), which buys back however many hours the machine had already spent.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const STATE_FILE = 'segments.json';
const SEGMENT_DIR = 'segments';

/* Long enough that resuming is worth the seams, short enough that a restart
   does not throw away an hour of work. */
const MIN_DURATION_SECONDS = Number(process.env.SEGMENT_MIN_SECONDS) || 240;
const MIN_CHUNK = 60;
const MAX_CHUNK = 300;

/** How long each piece should be for a file of this length. */
function chunkSecondsFor(duration) {
  const forced = Number(process.env.SEGMENT_SECONDS) || 0;
  /* Tests use very short parts; anything under a few seconds is a typo. */
  if (forced >= 2) return Math.round(forced);
  // Aim for ~12 pieces: enough to resume usefully, few enough that the seams
  // and the extra encoder startups stay cheap.
  const ideal = Math.round((Number(duration) || 0) / 12);
  return Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, ideal));
}

/** [{ index, start, length }] covering the whole file. */
function plan({ duration, chunkSeconds }) {
  const total = Math.max(1, Math.ceil(duration / chunkSeconds));
  const pieces = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSeconds;
    const length = Math.min(chunkSeconds, Math.max(0, duration - start));
    if (length <= 0) break;
    pieces.push({ index, start, length });
  }
  return pieces;
}

const statePath = (jobDir) => path.join(jobDir, STATE_FILE);
const dirFor = (jobDir) => path.join(jobDir, SEGMENT_DIR);
const fileFor = (jobDir, index) => path.join(dirFor(jobDir), `part-${String(index).padStart(4, '0')}.mp4`);

async function read(jobDir) {
  try {
    const raw = await fsp.readFile(statePath(jobDir), 'utf8');
    const state = JSON.parse(raw);
    if (!state || !Array.isArray(state.done) || !state.total) return null;
    return state;
  } catch {
    return null;
  }
}

async function write(jobDir, state) {
  const tmp = `${statePath(jobDir)}.tmp`;
  await fsp.mkdir(jobDir, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(state));
  await fsp.rename(tmp, statePath(jobDir));
}

async function clear(jobDir) {
  await fsp.rm(dirFor(jobDir), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(statePath(jobDir), { force: true }).catch(() => {});
}

/**
 * The pieces that are actually on disk, whatever the state file says.
 *
 * A part is only usable if the state recorded it *and* the file survived the
 * crash: a half-written tail file is re-encoded rather than joined.
 */
async function finishedParts(jobDir, state) {
  const done = new Set();
  if (!state || !Array.isArray(state.done)) return done;
  for (const index of state.done) {
    try {
      const stat = await fsp.stat(fileFor(jobDir, index));
      if (stat.size > 1024) done.add(index);
    } catch {
      /* the file is gone: this piece is not done, whatever the state said */
    }
  }
  return done;
}

/** A concat list for ffmpeg, in order. */
async function writeConcatFile(jobDir, pieces) {
  const listPath = path.join(dirFor(jobDir), 'concat.txt');
  const lines = pieces.map((piece) => {
    // ffmpeg's concat demuxer takes a hard-coded single-quote escape.
    const file = fileFor(jobDir, piece.index).replace(/'/g, "'\\''");
    return `file '${file}'`;
  });
  await fsp.writeFile(listPath, `${lines.join('\n')}\n`);
  return listPath;
}

/** Everything the encoder stops needing once the file is joined. */
async function cleanup(jobDir) {
  await fsp.rm(dirFor(jobDir), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(statePath(jobDir), { force: true }).catch(() => {});
}

module.exports = {
  STATE_FILE,
  MIN_DURATION_SECONDS,
  chunkSecondsFor,
  plan,
  read,
  write,
  clear,
  finishedParts,
  writeConcatFile,
  cleanup,
  fileFor,
  dirFor,
};
