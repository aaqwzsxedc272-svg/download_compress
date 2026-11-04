'use strict';
/**
 * Which build is this, actually?
 *
 * After a crash the first useful question is "am I running the fix or the old
 * code?", and answering it from memory is how an afternoon disappears. The
 * commit is read once at startup and reported in the console banner, in
 * /api/version, in /api/health and on the page.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function readCommit() {
  /* A normal checkout: ask git. It is fast (a few ms) and exact. */
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .trim();
  } catch {
    /* git is not installed, or this is not a git checkout */
  }
  /* A tarball or a deployed copy: read .git by hand. */
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (ref) {
      const target = fs.readFileSync(path.join(ROOT, '.git', ref[1]), 'utf8').trim();
      if (/^[0-9a-f]{40}$/i.test(target)) return target.slice(0, 7);
    }
  } catch {
    /* no .git at all */
  }
  return null;
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

let cached = null;

/** { commit, version, startedAt, node, features } — cheap after the first call. */
function describe() {
  if (cached) return cached;
  const browser = (() => {
    try {
      const pw = require('playwright'); // eslint-disable-line global-require, import/no-unresolved
      return { available: Boolean(pw.chromium), engine: 'playwright' };
    } catch (err) {
      return { available: false, engine: null, why: err.code === 'MODULE_NOT_FOUND' ? 'playwright not installed' : err.message };
    }
  })();
  cached = {
    commit: readCommit(),
    version: packageVersion(),
    startedAt: new Date().toISOString(),
    node: process.version,
    features: {
      resumableEncode: process.env.SEGMENTED !== '0',
      resumableDownload: true,
      cloudflareBrowser: browser.available,
      webhookSettings: true,
    },
    browser,
  };
  return cached;
}

/** One line for the console: what is running, and whether the fixes are in. */
function banner() {
  const info = describe();
  return (
    `Squeeze ${info.version || '1.0.0'}${info.commit ? ` · ${info.commit}` : ''}` +
    ` · resumable encode ${info.features.resumableEncode ? 'on' : 'off'}` +
    ` · browser ${info.browser.available ? 'yes' : 'no'}`
  );
}

/* ---------------------------------------------------------------- freshness
 *
 * "I tested it and it is still broken" has now twice meant "the codespace was
 * running the build before the fix". The banner answers *which* build; it never
 * answered whether that build is the published one. So the checkout asks its
 * remote, once, a few seconds after the server starts: a short `git ls-remote`
 * (no fetch, no working-tree change), a five-minute memo, and silence when the
 * answer cannot be had. Being offline is normal; being stale is not.
 */

const REMOTE_TTL_MS = 5 * 60 * 1000;
const REMOTE_TIMEOUT_MS = 6000;

/** The branch this checkout is on, or null when it is detached. */
function readBranch() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
      .toString()
      .trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/** Run git asynchronously; resolves to stdout, rejects otherwise. */
function gitAsync(args) {
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: ROOT, timeout: REMOTE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))),
    );
  });
}

let remoteCheckedAt = 0;
let remoteResult = null;
let remoteRunning = null;

/**
 * Is the checkout the published one?
 *
 * @param {{run?: (args: string[]) => Promise<string>, force?: boolean}} options
 * @returns {Promise<{branch, head, latest, behind, checkedAt, reason?}>}
 */
async function checkRemote({ run, force = false } = {}) {
  const now = Date.now();
  if (!force && remoteResult && now - remoteCheckedAt < REMOTE_TTL_MS) return remoteResult;
  if (remoteRunning && !force) return remoteRunning;

  const execute = run || gitAsync;
  const branch = readBranch();
  /* A tarball, a detached checkout or a machine without git: nothing to say. */
  if (!branch) {
    remoteResult = { branch: null, head: describe().commit, latest: null, behind: false, checkedAt: now };
    remoteCheckedAt = now;
    return remoteResult;
  }

  remoteRunning = (async () => {
    let latest = null;
    let reason = null;
    try {
      const out = await execute(['ls-remote', '--heads', 'origin', branch]);
      /* "<sha>\trefs/heads/<branch>" */
      const line = String(out)
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => entry.endsWith(`refs/heads/${branch}`));
      if (line) latest = line.split(/\s+/)[0].slice(0, 7);
    } catch (err) {
      reason = err && err.code === 'ENOENT' ? 'git is not installed' : 'the remote could not be reached';
    }
    const head = describe().commit;
    const result = {
      branch,
      head,
      latest,
      /* Only a real difference counts as behind. A short hash compared to a
         full one, or a missing remote, must never nag the user. */
      behind: Boolean(head && latest && head !== latest),
      checkedAt: Date.now(),
      ...(reason ? { reason } : {}),
    };
    remoteResult = result;
    remoteCheckedAt = Date.now();
    return result;
  })();

  try {
    return await remoteRunning;
  } finally {
    remoteRunning = null;
  }
}

/** One line for the console, and for the doctor: are the fixes in *this* box? */
function freshnessLine(status) {
  if (!status) return null;
  if (!status.branch) return null;
  if (status.behind) {
    return (
      `[build] This checkout is ${status.head || 'unknown'} but origin/${status.branch} is ${status.latest} — ` +
      'you are running older code. Run: git pull'
    );
  }
  if (!status.latest) return null; // offline, or no git: say nothing
  return `Build: ${status.head} · up to date with origin/${status.branch}`;
}

/** The last answer, without asking again — for /api/health, which must not wait. */
function knownRemote() {
  return remoteResult;
}

module.exports = { describe, banner, readCommit, readBranch, checkRemote, knownRemote, freshnessLine };


