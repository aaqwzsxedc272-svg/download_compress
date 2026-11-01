'use strict';
/**
 * Send the share links somewhere they cannot be lost.
 *
 * Two situations make this necessary:
 *   - the queue is done and the machine stops itself (auto-stop), so the page
 *     that would have shown the link is gone;
 *   - the laptop that had the tab open is shut.
 *
 * The links are already kept in data/links.tsv, but a file on a machine that
 * just stopped is not much of a notification. So: email.
 *
 * Deliberately dependency-free. A whole nodemailer for "connect, EHLO, AUTH,
 * DATA" is 100 MB of install friction on a machine that is already tight on
 * space; the SMTP conversation is small and is exercised by a test against a
 * fake server (scripts/notify.test.js).
 *
 * Configuration (any provider that speaks SMTP, including Gmail with an
 * app password):
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587            # 465 also works (implicit TLS)
 *   SMTP_USER=you@gmail.com
 *   SMTP_PASS=abcd efgh ijkl mnop    # an app password, not the account password
 *   NOTIFY_EMAIL=you@gmail.com       # where the links go (defaults to SMTP_USER)
 *
 * Nothing here is required: without SMTP the app offers a mailto: link instead,
 * which opens the user's own mail client with the links already written.
 */

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');

const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT) || (Number(process.env.SMTP_SECURE) === 1 ? 465 : 587);
const SECURE = Number(process.env.SMTP_SECURE) === 1 || PORT === 465;
const USER = process.env.SMTP_USER || '';
const PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '') || '';
const FROM = process.env.SMTP_FROM || USER;
/* The address this project was asked to mail. A user-set NOTIFY_EMAIL wins,
   then the SMTP account itself, then the known owner address. */
const OWNER_EMAIL = process.env.NOTIFY_EMAIL || process.env.SMTP_USER || 'aaqwzsxedc272@gmail.com';
const DEFAULT_TO = OWNER_EMAIL;

const configured = () => Boolean(HOST && FROM && (USER ? PASS : true));
const defaultTo = () => DEFAULT_TO || null;
const describe = () => ({ configured: configured(), to: defaultTo(), host: HOST || null, port: PORT });

/* ------------------------------------------------------------------ smtp --- */

/** Read SMTP replies: "250-more to come" continues, "250 done" ends. */
function reader(socket) {
  let buffer = '';
  const waiting = [];
  let failure = null;

  const settle = () => {
    while (waiting.length) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      const code = Number(line.slice(0, 3));
      const continuation = line[3] === '-';
      // Collect the whole (possibly multi-line) reply before resolving.
      if (waiting[0].acc) waiting[0].acc.push(line);
      else waiting[0].acc = [line];
      if (continuation) continue;
      const reply = waiting.shift();
      reply.resolve({ code, lines: reply.acc || [line] });
      reply.acc = null;
    }
  };

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    settle();
  });
  const fail = (err) => {
    failure = err;
    while (waiting.length) waiting.shift().reject(err);
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('The mail server closed the connection.')));

  return {
    next() {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject, acc: null });
        // A reply that arrived before anyone was listening is still waiting in
        // the buffer: drain it now.
        settle();
      });
    },
  };
}

function command(socket, line) {
  socket.write(`${line}\r\n`);
}

function expect(reply, codes, what) {
  if (!codes.includes(reply.code)) {
    const detail = reply.lines.join(' ').replace(/\s+/g, ' ').slice(0, 240);
    throw Object.assign(new Error(`${what} was refused (${reply.code}): ${detail}`), { code: 'SMTP_FAILED' });
  }
  return reply;
}

function connect({ host, port, secure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host, timeout: timeoutMs })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error('The mail server took too long to answer.'));
    });
    const done = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    const onError = (err) => reject(err);
    socket.once('error', onError);
    if (secure) socket.once('secureConnect', done);
    else socket.once('connect', done);
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host }, () => resolve(secured));
    secured.once('error', reject);
  });
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** RFC 2047 for headers that are not plain ASCII (file names usually aren't). */
function encodeHeader(text) {
  const ascii = /^[\x20-\x7E]*$/.test(String(text));
  return ascii ? text : `=?UTF-8?B?${b64(String(text))}?=`;
}

/** A text/plain body in base64: never trips a line-length or dot-stuffing rule. */
function message({ from, to, subject, text, date = new Date() }) {
  const body = b64(String(text).replace(/\r?\n/g, '\r\n').replace(/\r\n/g, '\n'));
  const wrapped = body.match(/.{1,76}/g) || [];
  const domain = String(from).split('@')[1] || 'localhost';
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...wrapped,
    '',
  ].join('\r\n');
}

/**
 * Send one plain-text mail. Resolves when the server accepted it.
 * Throws an Error with `code: 'SMTP_FAILED'` (or 'SMTP_UNCONFIGURED').
 */
async function sendMail({ to = defaultTo(), subject, text, from = FROM, timeoutMs = 25000 } = {}) {
  if (!configured()) {
    throw Object.assign(new Error('Email is not set up on this machine (set SMTP_HOST, SMTP_USER and SMTP_PASS).'), {
      code: 'SMTP_UNCONFIGURED',
    });
  }
  if (!to) {
    throw Object.assign(new Error('No address to send to (set NOTIFY_EMAIL).'), { code: 'SMTP_NO_RECIPIENT' });
  }

  let socket = await connect({ host: HOST, port: PORT, secure: SECURE, timeoutMs });
  let io = reader(socket);
  try {
    expect(await io.next(), [220], 'The greeting');

    const helo = os.hostname() || 'localhost';
    const say = async (line, codes, what) => {
      command(socket, line);
      return expect(await io.next(), codes, what);
    };

    let caps = await say(`EHLO ${helo}`, [250], 'EHLO');
    let capabilityText = caps.lines.join('\n').toUpperCase();

    /* Port 587 servers start in the clear and require STARTTLS before auth. */
    if (!SECURE && /STARTTLS/.test(capabilityText)) {
      await say('STARTTLS', [220], 'STARTTLS');
      socket = await upgrade(socket, HOST);
      io = reader(socket);
      caps = await say(`EHLO ${helo}`, [250], 'EHLO after STARTTLS');
      capabilityText = caps.lines.join('\n').toUpperCase();
    }

    if (USER) {
      if (/AUTH[ =].*PLAIN/.test(capabilityText)) {
        await say(`AUTH PLAIN ${b64(`\0${USER}\0${PASS}`)}`, [235], 'Login');
      } else {
        await say('AUTH LOGIN', [334], 'Login');
        await say(b64(USER), [334], 'The username');
        await say(b64(PASS), [235], 'The password');
      }
    }

    await say(`MAIL FROM:<${from}>`, [250], 'The sender');
    await say(`RCPT TO:<${to}>`, [250, 251], 'The recipient');
    await say('DATA', [354], 'DATA');

    socket.write(`${message({ from, to, subject, text })}\r\n.\r\n`);
    expect(await io.next(), [250], 'The message');

    command(socket, 'QUIT');
    return { ok: true, to };
  } finally {
    socket.destroy();
  }
}

/* ----------------------------------------------------------------- links --- */

function formatLinks(links = []) {
  if (!links.length) return 'No share links yet.';
  return links
    .map((link, index) => {
      const bits = [];
      if (link.name) bits.push(link.name);
      if (link.sourceBytes && link.outputBytes) {
        bits.push(
          link.usedOriginal
            ? `${mb(link.sourceBytes)} (already small, original kept)`
            : `${mb(link.sourceBytes)} → ${mb(link.outputBytes)} (−${Math.round((1 - link.outputBytes / link.sourceBytes) * 100)}%)`,
        );
      }
      if (link.provider) bits.push(`on ${link.provider}`);
      return `${index + 1}. ${bits.length ? `${bits.join(' · ')}\n   ` : ''}${link.url}`;
    })
    .join('\n\n');
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;

function linksMail(links, { reason } = {}) {
  const count = links.length;
  const subject = count === 1
    ? `Squeeze: ${links[0].name || 'your video'} is ready`
    : `Squeeze: ${count} share links ready`;
  const text = [
    reason ? `${reason}\n` : '',
    `${count} finished file${count === 1 ? '' : 's'} — the links work on their own; this machine is not needed any more.`,
    '',
    formatLinks(links),
    '',
    'The same links are kept on the machine in data/links.tsv and at /api/links.txt.',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return { subject, text };
}

/** Send the given links in one mail. */
async function sendLinks(links, { to = defaultTo(), reason } = {}) {
  const { subject, text } = linksMail(links, { reason });
  return sendMail({ to, subject, text });
}

/** A mailto: URL that opens the user's mail client with the links written out. */
function mailtoUrl(links, { to = defaultTo() } = {}) {
  const { subject, text } = linksMail(links, {});
  const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  return `mailto:${to || ''}?${query}`;
}

module.exports = {
  configured,
  defaultTo,
  describe,
  sendMail,
  sendLinks,
  mailtoUrl,
  formatLinks,
  linksMail,
  message,
  encodeHeader,
};
