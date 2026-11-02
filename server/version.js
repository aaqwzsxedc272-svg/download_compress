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

module.exports = { describe, banner, readCommit };
