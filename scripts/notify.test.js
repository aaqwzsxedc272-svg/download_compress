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

const net = require('node:net');
const assert = require('node:assert');

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

/** A minimal SMTP server that records what a client says to it. */
function fakeSmtp({ advertiseStartTls = false, auth = 'PLAIN' } = {}) {
  const seen = { commands: [], data: '', authenticated: null };
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 fake.smtp.test ESMTP\r\n');
    let buffer = '';
    let inData = false;

    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          seen.data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 Ok: queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        seen.commands.push(line);
        const upper = line.toUpperCase();

        if (/^EHLO/.test(upper)) {
          const caps = ['250-fake.smtp.test', '250-8BITMIME', '250-SIZE 10485760'];
          if (advertiseStartTls) caps.push('250-STARTTLS');
          caps.push(auth === 'PLAIN' ? '250 AUTH PLAIN LOGIN' : '250 AUTH LOGIN');
          socket.write(`${caps.join('\r\n')}\r\n`);
        } else if (upper === 'STARTTLS') {
          socket.write('220 Ready to start TLS\r\n');
        } else if (/^AUTH PLAIN /.test(upper)) {
          const decoded = Buffer.from(line.split(' ')[2], 'base64').toString('utf8');
          seen.authenticated = decoded.split('\0').filter(Boolean);
          const ok = seen.authenticated[0] === 'sender@example.test' && seen.authenticated[1] === 'abcdefghijklmnop';
          socket.write(ok ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Bad credentials\r\n');
        } else if (upper === 'AUTH LOGIN') {
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^(MAIL FROM|RCPT TO)/.test(upper)) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else if (seen.commands.length && /^[A-Za-z0-9+/=]+$/.test(line) && seen.authenticated === null) {
          // AUTH LOGIN continuation lines.
          seen.authenticated = (seen.authenticated || []).concat(
            Buffer.from(line, 'base64').toString('utf8'),
          );
          socket.write(seen.authenticated.length < 2 ? '334 UGFzc3dvcmQ6\r\n' : '235 2.7.0 Accepted\r\n');
        } else {
          socket.write('250 Ok\r\n');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

(async () => {
  // Configuration is read when the module loads, so it has to be set first.
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
