'use strict';
/**
 * Where the mail settings live.
 *
 * SMTP details were environment-only, which is fine for a deployment and wrong
 * for the way this app is actually used: `npm start` in a Codespace is a new
 * shell every day, and a rebuilt machine loses its environment entirely. Asking
 * for an app password before every run is exactly the kind of friction that
 * ends with the links never arriving.
 *
 * So the settings are read from three places, in this order of precedence:
 *
 *   1. data/mail.json  — written by the app's own setup form, mode 0600
 *   2. environment     — SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / ...
 *   3. defaults        — port 587, the owner address
 *
 * A saved setting wins over the environment for the same field, so typing the
 * password into the app always does what it looks like it does. Environment
 * variables still fill in anything the file does not mention, which keeps
 * `docker run -e SMTP_PASS=…` and Codespaces secrets working.
 *
 * The password is never returned by describe(): the UI only needs to know that
 * one is stored.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'mail.json');
const OWNER_EMAIL = 'aaqwzsxedc272@gmail.com';

const str = (value) => String(value == null ? '' : value).trim();
/* App passwords are shown in groups of four; the spaces are decoration. */
const password = (value) => str(value).replace(/\s+/g, '');

/** What the environment says, if anything. */
function fromEnv(env = process.env) {
  const port = Number(env.SMTP_PORT) || (Number(env.SMTP_SECURE) === 1 ? 465 : 587);
  const user = str(env.SMTP_USER);
  return {
    host: str(env.SMTP_HOST),
    port,
    secure: Number(env.SMTP_SECURE) === 1 || port === 465,
    user,
    pass: password(env.SMTP_PASS),
    from: str(env.SMTP_FROM) || user,
    to: str(env.NOTIFY_EMAIL) || user || OWNER_EMAIL,
  };
}

/** What the setup form saved, if anything. Missing fields mean "not set here". */
function fromFile(file) {
  if (!file || typeof file !== 'object') return {};
  const out = {};
  if (str(file.host)) out.host = str(file.host);
  if (file.port) out.port = Number(file.port) || 587;
  if (file.secure != null) out.secure = Boolean(file.secure);
  if (str(file.user)) out.user = str(file.user);
  if (file.pass != null && password(file.pass)) out.pass = password(file.pass);
  if (str(file.from)) out.from = str(file.from);
  if (str(file.to)) out.to = str(file.to);
  return out;
}

function readSync() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The settings in force right now: file over environment over defaults.
 * Read on every use (a file read of a few dozen bytes) so a save takes effect
 * without restarting the server.
 */
function current(env = process.env) {
  const envConfig = fromEnv(env);
  const saved = fromFile(readSync());
  const merged = { ...envConfig, ...saved };
  if (merged.port === 465) merged.secure = true;
  merged.from = merged.from || merged.user;
  merged.to = merged.to || merged.user || OWNER_EMAIL;
  merged.configured = Boolean(merged.host && merged.from && (merged.user ? merged.pass : true));
  merged.source = saved.host ? 'saved' : envConfig.host ? 'env' : 'none';
  return merged;
}

/** Never includes the password: the UI only needs to know it is there. */
function describe() {
  const config = current();
  return {
    configured: config.configured,
    host: config.host || null,
    port: config.port,
    secure: Boolean(config.secure),
    user: config.user || null,
    to: config.to || null,
    from: config.from || null,
    source: config.source,
    hasPassword: Boolean(config.pass),
    saved: Boolean(readSync()),
  };
}

/**
 * Save what the form sent. A blank password keeps the stored one, so the form
 * can be re-opened and corrected without retyping it.
 */
async function save(input = {}) {
  const previous = fromFile(readSync());
  const next = { ...previous };

  if (input.host != null) next.host = str(input.host);
  if (input.port != null) {
    const port = Number(input.port) || 587;
    next.port = port;
    next.secure = port === 465;
  }
  if (input.secure != null) next.secure = Boolean(input.secure);
  if (input.user != null) next.user = str(input.user);
  if (input.pass) next.pass = password(input.pass);
  if (input.from != null) next.from = str(input.from);
  if (input.to != null) next.to = str(input.to);

  if (!next.host) throw Object.assign(new Error('An SMTP server is required.'), { code: 'BAD_SETTINGS' });
  if (!next.to) throw Object.assign(new Error('An address to send to is required.'), { code: 'BAD_SETTINGS' });
  if (next.user && !next.pass) {
    throw Object.assign(new Error('That server needs a password (an app password for Gmail).'), {
      code: 'BAD_SETTINGS',
    });
  }
  if (next.port < 1 || next.port > 65535) {
    throw Object.assign(new Error('That port is out of range.'), { code: 'BAD_SETTINGS' });
  }

  await fsp.mkdir(DATA_DIR, { recursive: true });
  const temp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, SETTINGS_PATH).catch(async (err) => {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw err;
  });
  await fsp.chmod(SETTINGS_PATH, 0o600).catch(() => {});
  return describe();
}

/** Forget the saved settings (the environment, if any, comes back into force). */
async function forget() {
  await fsp.rm(SETTINGS_PATH, { force: true }).catch(() => {});
  return describe();
}

module.exports = { current, describe, save, forget, SETTINGS_PATH, OWNER_EMAIL };
