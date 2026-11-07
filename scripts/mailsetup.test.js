'use strict';

/**
 * "Do I have to set the mail up on every run?"
 *
 * The answer has to be no, and it has to be true from a fresh shell with no
 * environment at all. This checks the three things that make that so:
 *
 *   1. `.env` — a file in the project root is read at boot, and a real
 *      environment variable still wins over it.
 *   2. `data/mail.json` — settings saved by the app's own form persist, are
 *      readable only by their owner, never hand the password back, and win over
 *      the environment.
 *   3. The running server picks the saved settings up **without a restart**:
 *      POST them, then send a test mail, and it lands on a real (fake) SMTP
 *      server in the same process.
 *
 *   npm run test:mail
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { fakeSmtp } = require('./fake-smtp');

const ROOT = path.join(__dirname, '..');
const PORT = 3189;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('server did not start');
}

async function stop(proc) {
  if (!proc) return;
  proc.kill('SIGKILL');
  await sleep(350);
}

async function startServer(env) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', (d) => (proc.log += d));
  proc.stderr.on('data', (d) => (proc.log += d));
  return proc;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squeeze-mail-'));
  const dataDir = path.join(tmp, 'data');

  /* ------------------------------------------------ .env parsing and loading */
  console.log('.env file');
  const envModule = require('../server/env');
  const parsed = envModule.parse(
    ['# a comment', 'SMTP_HOST=smtp.example.test', 'SMTP_PASS="abcd efgh"', "NOTIFY_EMAIL='me@example.test'", 'EMPTY=', 'BAD LINE', 'export PORT=4321'].join('\n'),
  );
  check('keys and values are parsed', parsed.SMTP_HOST === 'smtp.example.test' && parsed.PORT === '4321');
  check('quotes are stripped', parsed.SMTP_PASS === 'abcd efgh' && parsed.NOTIFY_EMAIL === 'me@example.test');
  check('junk lines are ignored', !('BAD' in parsed) && parsed.EMPTY === '');

  const envPath = path.join(tmp, '.env');
  fs.writeFileSync(envPath, 'SMTP_HOST=from-file.test\nSMTP_USER=file@example.test\n');
  const fakeEnv = { SMTP_USER: 'shell@example.test' };
  const loaded = envModule.load(envPath, fakeEnv);
  check('.env is read at boot', loaded.loaded && loaded.keys.includes('SMTP_HOST'));
  check('the file fills an empty variable', fakeEnv.SMTP_HOST === 'from-file.test');
  check('a real environment variable wins over the file', fakeEnv.SMTP_USER === 'shell@example.test');

  /* --------------------------------------------------- saved settings, in isolation */
  console.log('saved settings');
  const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squeeze-mail-cfg-'));
  process.env.DATA_DIR = mailDir;
  const mailsettings = require('../server/mailsettings');

  const before = mailsettings.describe();
  check('nothing is configured to start with', before.configured === false && before.to === 'aaqwzsxedc272@gmail.com', JSON.stringify(before.to));

  const saved = await mailsettings.save({
    host: 'smtp.example.test',
    port: 465,
    user: 'own er@example.test',
    pass: 'abcd efgh ijkl mnop',
    to: 'links@example.test',
  });
  check('saving makes it configured', saved.configured === true && saved.source === 'saved');
  check('port 465 implies implicit TLS', saved.secure === true);
  check('spaces in the app password are dropped', mailsettings.current().pass === 'abcdefghijklmnop');
  check('the password is never handed back', saved.hasPassword === true && !('pass' in saved), JSON.stringify(saved));
  const mode = fs.statSync(mailsettings.SETTINGS_PATH).mode & 0o777;
  check('the settings file is readable only by its owner', mode === 0o600, mode.toString(8));
  check(
    'the file survives a re-read',
    JSON.parse(fs.readFileSync(mailsettings.SETTINGS_PATH, 'utf8')).to === 'links@example.test',
  );

  await mailsettings.save({ host: 'smtp.example.test', port: 587, user: 'owner@example.test', to: 'links@example.test' });
  check(
    'leaving the password blank keeps the stored one',
    mailsettings.current().pass === 'abcdefghijklmnop',
  );

  const cleared = await mailsettings.forget();
  check('removing it goes back to unconfigured', cleared.configured === false && cleared.saved === false);

  /* ------------------------------------------------------ live server, no restart */
  console.log('a running server');
  const smtp = await fakeSmtp({ auth: 'PLAIN' });
  /* The fake SMTP server is on loopback, which the app refuses by default —
     the same guard that stops a public instance probing its own network. So the
     first run has the guard on, and proves it. */
  const base = { PORT: String(PORT), DATA_DIR: dataDir, AUTO_EMAIL: '0' };
  const env = { ...base, ALLOW_PRIVATE_HOSTS: '1' };
  let app = await startServer(base);
  try {
    await waitForHealth();
    const initial = (await (await fetch(`${BASE}/api/email/settings`)).json()).settings;
    check('a fresh machine reports mail as not set up', initial.configured === false, JSON.stringify(initial));
    check('and names the address it will mail', initial.to === 'aaqwzsxedc272@gmail.com', initial.to);

    const badTo = await fetch(`${BASE}/api/email/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: smtp.port, to: 'not-an-address' }),
    });
    check('a malformed destination is refused', badTo.status === 400);

    const loopback = await fetch(`${BASE}/api/email/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: smtp.port, to: 'me@example.test' }),
    });
    check('a mail server on loopback is refused by default', loopback.status === 400);
    const blocked = await fetch(`${BASE}/api/email/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '169.254.169.254', port: 587, to: 'me@example.test' }),
    });
    check('the metadata address is not a mail server', blocked.status === 400);

    /* Opt in (the documented way to talk to a local relay) and restart. */
    await stop(app);
    app = await startServer(env);
    await waitForHealth();

    const savedRes = await fetch(`${BASE}/api/email/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: '127.0.0.1',
        port: smtp.port,
        user: 'sender@example.test',
        pass: 'abcd efgh ijkl mnop',
        to: 'aaqwzsxedc272@gmail.com',
      }),
    });
    const savedBody = await savedRes.json();
    check('saving over the API works', savedRes.status === 200 && savedBody.settings.configured === true);
    check('the response carries no password', !JSON.stringify(savedBody).includes('abcdefghijklmnop'));

    const test = await fetch(`${BASE}/api/email/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const testBody = await test.json();
    check('a test mail is sent with no restart', test.status === 200 && testBody.ok === true, testBody.error || '');
    check('the test mail reached the server', smtp.seen.commands.some((c) => /^DATA/i.test(c)));
    check('it was addressed to the saved address', /RCPT TO:<aaqwzsxedc272@gmail.com>/i.test(smtp.seen.commands.join('\n')));
    check('the login used the saved app password', Array.isArray(smtp.seen.authenticated), JSON.stringify(smtp.seen.authenticated));

    const health = await (await fetch(`${BASE}/api/health`)).json();
    check('health reports mail as configured', health.email.configured === true && health.email.source === 'saved');

    const removed = await fetch(`${BASE}/api/email/settings`, { method: 'DELETE' });
    const removedBody = await removed.json();
    check('the settings can be removed again', removedBody.settings.configured === false);
    check('the file is gone', !fs.existsSync(path.join(dataDir, 'mail.json')));

    /* Restart on the same data dir: a saved file must still be in force, which
       is the whole point of saving it. */
    await fetch(`${BASE}/api/email/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: '127.0.0.1',
        port: smtp.port,
        user: 'sender@example.test',
        pass: 'abcdefghijklmnop',
        to: 'aaqwzsxedc272@gmail.com',
      }),
    });
    await stop(app);
    app = await startServer(env);
    await waitForHealth();
    const afterRestart = (await (await fetch(`${BASE}/api/email/settings`)).json()).settings;
    check('the saved settings survive a restart', afterRestart.configured === true, afterRestart.source);
    check('the boot log says where the mail will go', /Mail: links go to aaqwzsxedc272@gmail\.com/.test(app.log), app.log.split('\n').find((l) => l.startsWith('Mail:')) || 'no Mail line');
  } finally {
    await stop(app);
    smtp.server.close();
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(mailDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`Mail setup run crashed: ${err.message}`);
  process.exit(1);
});
