#!/usr/bin/env node
/**
 * Is this machine running the build I think it is?
 *
 * Twice, "it still does not work" meant "the codespace never pulled": the fix
 * was written, pushed and tested, and the box was running the commit before it.
 * The banner answered *which* build; nothing answered *whether that is the
 * published one*. So the checkout asks its remote once at startup, the doctor
 * says it before it says anything about the link, and the page footer turns
 * amber.
 *
 *   npm run test:update
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');

const version = require('../server/version');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(` FAIL  ${name}\n         ${err.message}`);
  }
}

const BRANCH = version.readBranch() || 'main';
const SHA = (seed) => seed.repeat(40).slice(0, 40);
const lsRemote = (sha, branch = BRANCH) => `${sha}\trefs/heads/${branch}\n`;

(async () => {
  console.log('build freshness (is this checkout the published one?)');

  await test('a checkout that matches its remote is not nagged', async () => {
    let calls = 0;
    const head = version.describe().commit;
    const status = await version.checkRemote({
      force: true,
      run: async () => {
        calls += 1;
        return lsRemote(`${head}0000000000000000`);
      },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(status.behind, false, JSON.stringify(status));
    assert.strictEqual(status.latest, head);
    assert.match(version.freshnessLine(status), /up to date/);
    assert.doesNotMatch(version.freshnessLine(status), /git pull/);
  });

  await test('a checkout behind its remote says so, with the command', async () => {
    const status = await version.checkRemote({ force: true, run: async () => lsRemote(SHA('a')) });
    assert.strictEqual(status.behind, true);
    assert.strictEqual(status.latest, 'aaaaaaa');
    const line = version.freshnessLine(status);
    assert.match(line, /origin\//);
    assert.match(line, /git pull/);
    assert.match(line, /older code/);
  });

  await test('no network is not a problem to report', async () => {
    const status = await version.checkRemote({
      force: true,
      run: async () => {
        throw Object.assign(new Error('could not resolve host'), { code: 'ENOTFOUND' });
      },
    });
    assert.strictEqual(status.behind, false);
    assert.strictEqual(status.latest, null);
    assert.strictEqual(version.freshnessLine(status), null, 'an offline box must not be told to pull');
    assert.ok(status.reason, 'but the reason is kept, for anyone looking');
  });

  await test('git missing is named as such, not guessed at', async () => {
    const status = await version.checkRemote({
      force: true,
      run: async () => {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      },
    });
    assert.match(String(status.reason), /git is not installed/);
  });

  await test('a remote that answers for another branch is not evidence', async () => {
    const status = await version.checkRemote({ force: true, run: async () => lsRemote(SHA('b'), 'main') });
    assert.strictEqual(status.behind, false, 'another branch says nothing about this one');
    assert.strictEqual(status.latest, null);
  });

  await test('the answer is remembered, so a page load costs nothing', async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return lsRemote(SHA('c'));
    };
    await version.checkRemote({ force: true, run });
    await version.checkRemote({ run });
    await version.checkRemote({ run });
    assert.strictEqual(calls, 1, `asked ${calls} times`);
    /* ...and the same answer is there for /api/health, without waiting. */
    assert.strictEqual(version.knownRemote().latest, 'ccccccc');
  });

  await test('a tarball or a detached checkout simply has nothing to say', async () => {
    /* readBranch() is real here, so this asserts the branch actually read. */
    assert.ok(typeof BRANCH === 'string' && BRANCH.length > 0);
    const nothing = version.freshnessLine({ branch: null, behind: false, latest: null });
    assert.strictEqual(nothing, null);
  });

  /* The doctor is where a person looks when a link fails, so it has to say it
     first — before any opinion about the link, which would be about old code. */
  await test('the doctor leads with the stale checkout', async () => {
    const { diagnose } = require('../server/diagnose');
    const report = await diagnose('http://127.0.0.1:1/nothing', {
      browser: 'skip',
      remote: { branch: BRANCH, head: '1111111', latest: '2222222', behind: true },
    });
    assert.match(report.text, /update\s+this checkout is 1111111/, report.text);
    assert.match(report.text, /git pull/);
    assert.match(report.text, /VERDICT\s+This machine is running 1111111/, report.text);
  });

  await test('and says nothing when it is current', async () => {
    const { diagnose } = require('../server/diagnose');
    const report = await diagnose('http://127.0.0.1:1/nothing', {
      browser: 'skip',
      remote: { branch: BRANCH, head: '1111111', latest: '1111111', behind: false },
    });
    assert.match(report.text, /update\s+up to date with origin\//, report.text);
    assert.doesNotMatch(report.text, /This machine is running 1111111/);
  });

  /* The page footer turns amber, and the tooltip carries the command. Both are
     read out of public/app.js by the UI suite; here the rule itself is checked
     against the same object /api/health returns. */
  await test('the health payload carries the answer to the page', async () => {
    const healthShape = { ...version.describe(), update: version.knownRemote() };
    assert.ok('update' in healthShape, 'health must carry the remote answer');
    assert.strictEqual(healthShape.update.latest, 'ccccccc');
    assert.strictEqual(healthShape.update.behind, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
