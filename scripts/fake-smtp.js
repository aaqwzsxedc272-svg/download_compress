'use strict';
/**
 * A fake SMTP server, shared by the tests that need one.
 *
 * It records every command it is told and the raw DATA body, and it checks
 * credentials for real — a fake that accepts anything hides the exact failure
 * (a wrong app password) these tests exist to catch.
 */

const net = require('node:net');

/** A minimal SMTP server that records what a client says to it. */
function fakeSmtp({ advertiseStartTls = false, auth = 'PLAIN' } = {}) {
  const seen = { commands: [], data: '', authenticated: null };
  const server = net.createServer((socket) => {
    /* The client hangs up straight after QUIT; without this the fake server
       crashes the whole test process with an unhandled ECONNRESET. */
    socket.on('error', () => {});
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

module.exports = { fakeSmtp };
