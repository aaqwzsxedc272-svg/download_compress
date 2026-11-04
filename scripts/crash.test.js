'use strict';

/**
 * The server must survive an error in one of its own callbacks.
 *
 *   node scripts/crash.test.js
 *
 * The field failure this locks down: a page listener inside the browser helper
 * referenced a `const` that lived in another function. Playwright runs listeners
 * on the event loop, so the ReferenceError was not a failed capture — it was an
 * uncaught exception, and Node exited. The server died mid-session with a stack
 * trace in a terminal the user may not even have open.
 *
 * A crash that kills the process is not recoverable by "Try again": nobody is
 * left to click it. So the exception is logged, recorded in data/crash.log, and
 * the process stays up. This test raises a real exception inside a real server
 * process (via `node --require`) and then talks to it over HTTP.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 8137 + Math.floor(Math.random() * 400);
const DATA_DIR = path.join(os.tmpdir(), `squeeze-crash-${process.pid}`);

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`[  ok  ] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`[ FAIL ] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const url = (suffix) => `http://127.0.0.1:${PORT}${suffix}`;
const status = (suffix) => fetch(url(suffix)).then((res) => res.status).catch(() => 0);

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  /* `--require` runs this inside the server process, before the entry point. */
  const thrower = path.join(DATA_DIR, 'thrower.js');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    thrower,
    `setTimeout(() => { throw new ReferenceError('MEDIA is not defined'); }, 4000);\n` +
      `setTimeout(() => { Promise.reject(new Error('a promise nobody awaited')); }, 5000);\n`,
  );

  const child = spawn(process.execPath, ['--require', thrower, 'server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  /* `exited` must be a flag, not the exit code: a process killed by a signal
     reports code === null, which is the same value as "still running". */
  let exited = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    lastExit = { code, signal };
  });
  let lastExit = null;

  try {
    for (let i = 0; i < 120 && !/listening/.test(output); i += 1) await sleep(250);
    check('the server starts', /listening/.test(output), `port ${PORT}`);
    check('and answers HTTP', (await status('/api/health')) === 200);

    /* The exceptions fire at 4 s and 5 s. */
    await sleep(7000);

    check('an uncaught exception does not stop the process', exited === false, JSON.stringify(exited));
    check('the server still answers', (await status('/api/health')) === 200);
    check('and its API still works', (await status('/api/jobs')) === 200);
    check('the exception is reported, not swallowed', /\[survived\] uncaughtException/.test(output));
    check('an unhandled rejection is survived too', /\[survived\] unhandledRejection/.test(output));

    const logFile = path.join(DATA_DIR, 'crash.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('both are written to data/crash.log', /uncaughtException/.test(log) && /unhandledRejection/.test(log));
    check('with the build it happened on', /1\.0\.0|·/.test(log), log.split('\n')[0] || 'empty');

    /* Surviving must not mean refusing to stop. */
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && exited === false; i += 1) await sleep(250);
    check('a normal shutdown still works', exited !== false, JSON.stringify(lastExit));
  } finally {
    if (exited === false) child.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
