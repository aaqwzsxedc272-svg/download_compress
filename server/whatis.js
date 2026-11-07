'use strict';
/**
 * What is this file, really?
 *
 * A 1.88 GB download called `.mp4` that ffprobe refuses used to produce one
 * sentence — "That file is not a video this server can read." — which is true
 * and useless: there are a dozen things it could be, and only two of them are
 * worth retrying. The answer is in the first bytes.
 *
 * A scene release is often a **RAR split archive with .mp4 on the end**; a
 * Drive link that lost its sharing settings hands back **HTML**; a phone
 * recording is **MPEG-TS**; a "video" from a disc is an **ISO**; and a
 * download that stopped early is a **truncated MP4 whose index is missing**.
 * Each of those wants a different next step, so each gets its own sentence.
 *
 * Nothing here runs ffmpeg: this is pure byte inspection, cheap enough to run
 * on any failure and to expose as `npm run whatis`.
 */

const fsp = require('node:fs/promises');

/** Enough for an ISO's signature at 0x8001 and any text preamble. */
const HEAD_BYTES = 64 * 1024;

async function readHead(file, bytes = HEAD_BYTES) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const ascii = (buffer, start, length) => buffer.subarray(start, start + length).toString('latin1');

/**
 * Where a signature sits, or -1.
 *
 * A file that arrived with junk in front of it — a dropped recording, a
 * download that began mid-stream — is still recognisable, and recognising it is
 * what earns it a repair attempt instead of a shrug.
 */
const findAt = (buffer, signature, within = 8192) => {
  const needle = Buffer.from(signature, 'latin1');
  return buffer.subarray(0, within).indexOf(needle);
};

/** The first 0x47 whose 188-byte-spaced followers agree: an MPEG-TS stream. */
function findTsSync(buffer) {
  for (let offset = 0; offset < Math.min(buffer.length - 188 * 3, 4096); offset += 1) {
    if (buffer[offset] !== 0x47) continue;
    if (buffer[offset + 188] === 0x47 && buffer[offset + 376] === 0x47) return offset;
  }
  return -1;
}
const starts = (buffer, text) => ascii(buffer, 0, text.length) === text;
const isIsoBmff = (buffer) => buffer.length >= 12 && ascii(buffer, 4, 4) === 'ftyp';

/** "47 4d ..." — the first bytes, for a message that is checkable. */
function hexPreview(buffer, count = 12) {
  return [...buffer.subarray(0, count)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/**
 * The container, from the bytes alone.
 *
 * `family` is what the caller acts on: `video` means "right kind of file, so
 * a repair is worth trying", `document` means "nothing to encode here", and
 * `unknown` means "say the bytes and stop guessing".
 */
function shapeOf(buffer) {
  if (!buffer || !buffer.length) {
    return { kind: 'empty', family: 'document', label: 'an empty file' };
  }
  const ftyp = findAt(buffer, 'ftyp', 64 * 1024);
  if (ftyp > 0 || isIsoBmff(buffer)) {
    const brand = ftyp > 0 ? ascii(buffer, ftyp + 4, 4).trim() || 'isom' : ascii(buffer, 8, 4).trim() || 'isom';
    const offset = ftyp > 0 ? Math.max(0, ftyp - 4) : 0;
    return { kind: 'mp4', family: 'video', label: 'an MP4/MOV', brand, offset };
  }
  const matroska = findAt(buffer, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 64 * 1024);
  if (matroska >= 0) {
    return { kind: 'matroska', family: 'video', label: 'a Matroska/WebM file', offset: matroska };
  }
  if (starts(buffer, 'RIFF') && ascii(buffer, 8, 4) === 'AVI ') {
    return { kind: 'avi', family: 'video', label: 'an AVI' };
  }
  if (starts(buffer, 'FLV') || findAt(buffer, 'FLV', 4096) === 0) {
    return { kind: 'flv', family: 'video', label: 'a Flash video' };
  }
  const ts = findTsSync(buffer);
  if (ts >= 0) {
    return { kind: 'mpegts', family: 'video', label: 'an MPEG-TS stream', offset: ts };
  }
  if (starts(buffer, 'Rar!\x1a\x07')) return { kind: 'rar', family: 'archive', label: 'a RAR archive' };
  if (starts(buffer, 'PK\x03\x04') || starts(buffer, 'PK\x05\x06')) {
    return { kind: 'zip', family: 'archive', label: 'a ZIP archive' };
  }
  if (buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc && buffer[3] === 0xaf) {
    return { kind: '7z', family: 'archive', label: 'a 7-Zip archive' };
  }
  if (ascii(buffer, 0x8001, 5) === 'CD001') return { kind: 'iso', family: 'document', label: 'a disc image (ISO)' };
  if (/^\s*(<!doctype html|<html|<\?xml|<head|<body)/i.test(ascii(buffer, 0, 64))) {
    return { kind: 'html', family: 'document', label: 'a web page' };
  }
  if (starts(buffer, '%PDF')) return { kind: 'pdf', family: 'document', label: 'a PDF' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { kind: 'jpeg', family: 'document', label: 'a JPEG image' };
  if (buffer[0] === 0x89 && ascii(buffer, 1, 3) === 'PNG') return { kind: 'png', family: 'document', label: 'a PNG image' };
  if (starts(buffer, 'GIF8')) return { kind: 'gif', family: 'document', label: 'a GIF image' };
  if (starts(buffer, 'ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) !== 0)) {
    return { kind: 'mp3', family: 'audio', label: 'an MP3' };
  }
  if (starts(buffer, 'fLaC')) return { kind: 'flac', family: 'audio', label: 'a FLAC file' };
  if (starts(buffer, 'OggS')) return { kind: 'ogg', family: 'audio', label: 'an Ogg file' };
  if (buffer.every((byte) => byte === 0)) {
    return { kind: 'zeroes', family: 'document', label: 'a file of zeroes' };
  }
  return { kind: 'unknown', family: 'unknown', label: 'an unknown container' };
}

/** One sentence that says what to do about it. */
function adviceFor(shape, { bytes = 0, expected = 0 } = {}) {
  const size = bytes ? `${Math.round((bytes / 1048576) * 10) / 10} MB` : '';
  switch (shape.kind) {
    case 'rar':
    case 'zip':
    case '7z':
      return (
        `It is ${shape.label} with a video's name on it — a scene release is often split into parts. ` +
        'Extract it on your own machine and drop the video here, or paste the link of the extracted file.'
      );
    case 'html':
      return (
        'The link handed back a web page instead of the file, which is what a share page does when it wants a ' +
        'sign-in or a confirm step. Paste the page’s own link again, or use “Save file” in your browser and drop it here.'
      );
    case 'iso':
      return 'It is a disc image, not a video file. Mount it and drop the video inside, or paste its own link.';
    case 'pdf':
    case 'jpeg':
    case 'png':
    case 'gif':
      return `It is ${shape.label}, not a video.`;
    case 'mp3':
    case 'flac':
    case 'ogg':
      return `It is ${shape.label} — sound only, so there is no picture to compress.`;
    case 'empty':
    case 'zeroes':
      return 'The file is empty — the download produced nothing. Paste the link again.';
    case 'mp4':
    case 'matroska':
    case 'avi':
    case 'flv':
    case 'mpegts':
      return (
        `It is ${shape.label}, but this build's ffprobe cannot parse it` +
        (expected && bytes && bytes < expected * 0.995
          ? `, and it is short: ${size} arrived of ${Math.round((expected / 1048576) * 10) / 10} MB. The download was cut off, so paste the link again.`
          : ` — the download may be damaged${size ? ` (${size})` : ''}. Paste the link again to fetch a fresh copy.`)
      );
    default:
      return (
        `It does not look like any video container this build knows — it begins with “${hexPreview(shape.head || Buffer.alloc(0))}”. ` +
        'The file on the host is not a video, or its name is wrong.'
      );
  }
}

/** Identify a file on disk. Never throws: a missing file is its own answer. */
async function identify(file) {
  let head;
  let bytes = 0;
  try {
    const stat = await fsp.stat(file);
    bytes = stat.size || 0;
    head = await readHead(file);
  } catch (err) {
    return { kind: 'missing', family: 'unknown', label: 'a file that is not there', bytes: 0, error: err.message };
  }
  const shape = shapeOf(head);
  return { ...shape, bytes, head: head.subarray(0, 16), hex: hexPreview(head) };
}

/**
 * A human paragraph: the shape, its size, and what to do.
 *
 * `expected` is the size the host promised, so a short download can say so.
 */
async function explainFile(file, { expected = 0 } = {}) {
  const shape = await identify(file);
  return {
    shape,
    advice: adviceFor(shape, { bytes: shape.bytes, expected }),
    hex: shape.hex || '',
  };
}

/**
 * Is fetching the file again the fix?
 *
 * When the bytes on disk are a web page, an empty file or nothing at all, the
 * *download* went wrong and a second attempt can succeed. When they are a RAR,
 * a PDF or a broken container, the host will hand back the same bytes and the
 * retry is a loop — which is what three identical failures in a row looked
 * like from the outside.
 */
function shouldRedownload(shape) {
  return Boolean(shape) && ['html', 'empty', 'zeroes', 'missing'].includes(shape.kind);
}

module.exports = { identify, shapeOf, adviceFor, explainFile, shouldRedownload, hexPreview, readHead };
