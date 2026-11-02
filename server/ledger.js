'use strict';
/**
 * A permanent record of every share link the app has produced.
 *
 * The job list is a working area: records are pruned after a few hours and the
 * video files are deleted once they are on a host. The links are the thing the
 * user actually came for, so they live in their own append-only file that no
 * sweep touches. That is what makes a finished job survive a closed tab, a
 * stopped Codespace, and a machine that went to sleep mid-encode.
 *
 * One line per link, tab separated:
 *   recordedAt  jobId  provider  url  name  sourceBytes  outputBytes
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'links.tsv');
const MAX_LINES = 2000;

const clean = (value) => String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ').trim();

/** Remember a share link. Cheap, idempotent enough, and never throws. */
async function record(entry = {}) {
  if (!entry.url) return false;
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  const line = [
    new Date(entry.at || Date.now()).toISOString(),
    clean(entry.jobId),
    clean(entry.provider),
    clean(entry.url),
    clean(entry.name),
    Number(entry.sourceBytes) || '',
    Number(entry.outputBytes) || '',
  ].join('\t');
  try {
    await fsp.appendFile(LEDGER_PATH, `${line}\n`);
    await trim();
    return true;
  } catch {
    return false; // the in-memory job still has the link
  }
}

/** Keep the file from growing without bound, newest lines win. */
async function trim() {
  const raw = await fsp.readFile(LEDGER_PATH, 'utf8').catch(() => null);
  if (!raw) return;
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= MAX_LINES) return;
  const kept = lines.slice(-MAX_LINES);
  const tmp = `${LEDGER_PATH}.tmp`;
  await fsp.writeFile(tmp, `${kept.join('\n')}\n`).catch(() => {});
  await fsp.rename(tmp, LEDGER_PATH).catch(() => {});
}

/** Every remembered link, newest first, one entry per URL. */
async function list() {
  const raw = await fsp.readFile(LEDGER_PATH, 'utf8').catch(() => null);
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  const lines = raw.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    const [at, jobId, provider, url, name, sourceBytes, outputBytes] = line.split('\t');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      at,
      jobId: jobId || null,
      provider: provider || null,
      url,
      name: name || null,
      sourceBytes: Number(sourceBytes) || null,
      outputBytes: Number(outputBytes) || null,
    });
  }
  return out;
}

/** A plain-text file the user can open or copy from any machine. */
async function text() {
  const entries = await list();
  if (!entries.length) return '';
  return `${entries.map((entry) => `${entry.url}\t${entry.name || ''}`).join('\n')}\n`;
}

const exists = () => fs.existsSync(LEDGER_PATH);

module.exports = { record, list, text, exists, LEDGER_PATH };
