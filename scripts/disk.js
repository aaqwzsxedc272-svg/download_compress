#!/usr/bin/env node
/**
 * How much space is left, what is using it, and one command to reclaim it.
 *
 *   npm run disk            # report
 *   npm run disk -- --clean # delete finished/failed jobs and stray files
 *
 * The same facts are on the page behind the header's storage button, where
 * every file can also be downloaded or deleted one at a time.
 *
 * "Finished" means a job whose result either has a share link or has failed:
 * the compressed file is still downloadable until you clean, so nothing is
 * deleted while it is the only copy — and a job that has been **pinned** in the
 * page is never deleted here at all.
 */
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const gb = (bytes) => `${(bytes / 1073741824).toFixed(2)} GB`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;
const human = (bytes) => (bytes >= 1073741824 ? gb(bytes) : mb(bytes));

async function dirSize(dir) {
  let total = 0;
  const walk = async (current) => {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* vanished */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

async function main() {
  const clean = process.argv.includes('--clean');

  const stat = await fsp.statfs(DATA_DIR).catch(() => fsp.statfs(ROOT));
  const total = stat.blocks * stat.bsize;
  const free = stat.bavail * stat.bsize;
  const used = total - free;

  console.log(`Disk: ${human(total)} total · ${human(used)} used · ${human(free)} free (${Math.round((free / total) * 100)}%)`);
  console.log(`Working files: ${DATA_DIR}`);

  const jobsDir = path.join(DATA_DIR, 'jobs');
  let entries = [];
  try {
    entries = await fsp.readdir(jobsDir, { withFileTypes: true });
  } catch {
    console.log('  (no jobs yet)');
  }

  /* The records live in one file, not in each job directory. */
  let records = [];
  try {
    records = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'jobs.json'), 'utf8'));
  } catch {
    /* no records: sizes are still worth printing */
  }
  const byId = new Map(records.map((job) => [job.id, job]));

  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(jobsDir, entry.name);
    const size = await dirSize(dir);
    const record = byId.get(entry.name) || {};
    rows.push({
      id: entry.name,
      dir,
      size,
      status: record.status || 'unknown',
      name: record.name || null,
      pinned: Boolean(record.pinLocal),
      hosted: Boolean(record.hostedUrl),
    });
  }

  rows.sort((a, b) => b.size - a.size);
  const biggest = rows.slice(0, 10);
  if (biggest.length) {
    console.log('\nLargest jobs:');
    for (const row of biggest) {
      console.log(
        `  ${human(row.size).padStart(9)}  ${row.status.padEnd(10)} ${row.id}` +
          `${row.pinned ? '  (pinned)' : ''}${row.name ? `  ${row.name}` : ''}`,
      );
    }
    const jobBytes = rows.reduce((sum, row) => sum + row.size, 0);
    console.log(`\n  ${human(jobBytes)} across ${rows.length} job${rows.length === 1 ? '' : 's'}`);
  }

  // Sizes of the things that are not jobs but can still be large.
  const extras = [
    ['node_modules', path.join(ROOT, 'node_modules')],
    ['playwright browsers', path.join(process.env.HOME || '/home', '.cache/ms-playwright')],
    ['npm cache', path.join(process.env.HOME || '/home', '.npm')],
  ];
  const extraRows = [];
  for (const [label, dir] of extras) {
    if (!fs.existsSync(dir)) continue;
    extraRows.push([label, await dirSize(dir)]);
  }
  if (extraRows.length) {
    console.log('\nOther:');
    extraRows.forEach(([label, size]) => console.log(`  ${human(size).padStart(9)}  ${label}`));
  }

  const finished = rows.filter((row) => ['done', 'hosted', 'error'].includes(row.status) && !row.pinned);
  const pinned = rows.filter((row) => row.pinned);
  if (!clean) {
    console.log('\nReclaim space with:  npm run disk -- --clean');
    console.log('Or open the page and press the disk pill: every file, with a download and a delete.');
    if (finished.length) {
      const bytes = finished.reduce((sum, row) => sum + row.size, 0);
      console.log(`  would free ${human(bytes)} from ${finished.length} finished job(s)`);
    }
    if (pinned.length) {
      console.log(`  ${pinned.length} job(s) are pinned and would be kept: ${pinned.map((row) => row.id).join(', ')}`);
    }
    return;
  }

  let freed = 0;
  for (const row of finished) {
    await fsp.rm(row.dir, { recursive: true, force: true }).catch(() => {});
    freed += row.size;
  }
  const tmp = path.join(DATA_DIR, 'tmp');
  const tmpSize = await dirSize(tmp).catch(() => 0);
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  freed += tmpSize;

  const after = await fsp.statfs(DATA_DIR).catch(() => fsp.statfs(ROOT));
  console.log(`\nFreed ${human(freed)}. Now ${human(after.bavail * after.bsize)} free.`);
}

main().catch((err) => {
  console.error('disk check failed:', err.message);
  process.exit(1);
});
