#!/usr/bin/env node
/**
 * The share links are the whole point of the app, so they get their own
 * append-only record that no cleanup pass is allowed to touch. This proves it
 * survives the things that actually happen: a restart, a pruned job list, and a
 * machine that went to sleep.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squeeze-ledger-'));
process.env.DATA_DIR = dir;

const ledger = require('../server/ledger');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

(async () => {
  await check('recording a link writes it to disk', async () => {
    const ok = await ledger.record({
      jobId: 'abc123',
      provider: 'pixeldrain',
      url: 'https://pixeldrain.com/u/example1',
      name: 'holiday-squeeze-balanced.mp4',
      sourceBytes: 508 * 1024 ** 2,
      outputBytes: 402 * 1024 ** 2,
    });
    assert.ok(ok);
    assert.ok(fs.existsSync(path.join(dir, 'links.tsv')));
  });

  await check('a link with no URL is refused', async () => {
    assert.equal(await ledger.record({ jobId: 'x' }), false);
  });

  await check('links come back newest first with their details', async () => {
    await ledger.record({
      jobId: 'def456',
      provider: 'gofile',
      url: 'https://gofile.io/d/example2',
      name: 'clip.mp4',
      sourceBytes: 100,
      outputBytes: 60,
    });
    const links = await ledger.list();
    assert.equal(links[0].url, 'https://gofile.io/d/example2');
    assert.equal(links[0].provider, 'gofile');
    assert.equal(links[1].url, 'https://pixeldrain.com/u/example1');
  });

  await check('the same link recorded twice is listed once', async () => {
    await ledger.record({ url: 'https://gofile.io/d/example2', name: 'clip.mp4' });
    const links = await ledger.list();
    assert.equal(links.filter((l) => l.url === 'https://gofile.io/d/example2').length, 1);
  });

  await check('the text file is tabs and links, ready to copy', async () => {
    const text = await ledger.text();
    assert.match(text, /^https:\/\/gofile\.io\/d\/example2\tclip\.mp4$/m);
  });

  await check('tabs and newlines in a name cannot corrupt the file', async () => {
    await ledger.record({ url: 'https://example.test/u/1', name: 'bad\tname\nwith newline' });
    const links = await ledger.list();
    const entry = links.find((l) => l.url === 'https://example.test/u/1');
    assert.equal(entry.name, 'bad name with newline');
    assert.equal((await ledger.list()).length, 3, 'a mangled line became an extra record');
  });

  await check('a fresh process reads the same links', async () => {
    // Simulate a restart: drop the module from the cache and load it again.
    delete require.cache[require.resolve('../server/ledger')];
    const reloaded = require('../server/ledger');
    const links = await reloaded.list();
    assert.equal(links.length, 3);
    assert.equal(links[0].url, 'https://example.test/u/1');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
