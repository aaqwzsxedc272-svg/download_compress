#!/usr/bin/env node
/**
 * The links have to reach the user even when the machine switches itself off
 * right after the last upload. That means a mail has to actually leave this
 * process, so this test runs a real SMTP conversation against a fake server and
 * checks what arrived on the wire.
 *
 *   npm run test:notify
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fakeSmtp } = require('./fake-smtp');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failures.push(`${name}: ${err.message}`);
      console.log(`FAIL  ${name} — ${err.message}`);
    });
}

(async () => {
  /* A throwaway data dir, so settings saved by a real run of the app can never
     leak into this test (the file wins over the environment). */
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'squeeze-notify-'));
  const smtp = await fakeSmtp({ auth: 'PLAIN' });
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_USER = 'sender@example.test';
  process.env.SMTP_PASS = 'abcd efgh ijkl mnop';
  process.env.NOTIFY_EMAIL = 'aaqwzsxedc272@gmail.com';
  delete process.env.SMTP_SECURE;

  const notify = require('../server/notify');

  await check('it reports itself configured, with a default recipient', () => {
    assert.equal(notify.configured(), true);
    assert.equal(notify.defaultTo(), 'aaqwzsxedc272@gmail.com');
  });

  await check('a mail actually reaches the server', async () => {
    const result = await notify.sendMail({
      subject: 'Squeeze: your video is ready',
      text: 'https://pixeldrain.com/u/example',
    });
    assert.equal(result.ok, true);
    assert.ok(smtp.seen.data.length > 0, 'nothing arrived');
  });

  await check('the password is sent without the spaces Gmail puts in it', () => {
    assert.deepEqual(smtp.seen.authenticated, ['sender@example.test', 'abcdefghijklmnop']);
  });

  await check('the envelope names the right sender and recipient', () => {
    const joined = smtp.seen.commands.join('\n');
    assert.match(joined, /MAIL FROM:<sender@example\.test>/);
    assert.match(joined, /RCPT TO:<aaqwzsxedc272@gmail\.com>/);
  });

  await check('the link survives the trip in the body', () => {
    const body = Buffer.from(
      smtp.seen.data
        .split('\r\n')
        .filter((line) => /^[A-Za-z0-9+/=]{4,}$/.test(line))
        .join(''),
      'base64',
    ).toString('utf8');
    assert.match(body, /https:\/\/pixeldrain\.com\/u\/example/);
  });

  await check('a link list is turned into a readable mail', () => {
    const { subject, text } = notify.linksMail(
      [
        {
          name: 'holiday.mp4',
          url: 'https://pixeldrain.com/u/abc',
          provider: 'pixeldrain',
          sourceBytes: 508 * 1048576,
          outputBytes: 341 * 1048576,
        },
      ],
      { reason: 'The machine is about to switch itself off.' },
    );
    assert.match(subject, /holiday\.mp4/);
    assert.match(text, /https:\/\/pixeldrain\.com\/u\/abc/);
    assert.match(text, /508 MB → 341 MB/);
    assert.match(text, /switch itself off/);
  });

  await check('a mailto fallback exists for a machine with no SMTP', () => {
    const url = notify.mailtoUrl([{ name: 'a.mp4', url: 'https://x.test/u/1' }], { to: 'me@example.test' });
    assert.match(url, /^mailto:me@example\.test\?subject=/);
    assert.match(decodeURIComponent(url), /https:\/\/x\.test\/u\/1/);
  });

  await check('a server that refuses the login is reported, not swallowed', async () => {
    // Wrong password against the same fake server.
    const savedPass = process.env.SMTP_PASS;
    delete require.cache[require.resolve('../server/notify')];
    process.env.SMTP_PASS = 'wrong';
    const fresh = require('../server/notify');
    await assert.rejects(() => fresh.sendMail({ subject: 'x', text: 'y' }), /refused|535|Bad credentials/i);
    process.env.SMTP_PASS = savedPass;
  });

  smtp.server.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  process.exit(0);
})();
