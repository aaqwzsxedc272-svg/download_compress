'use strict';
/**
 * Where the "post the links" settings live.
 *
 * Same arrangement as the mail settings: a small JSON file the app writes
 * itself, so a webhook or an ntfy topic is typed once and does not have to be
 * exported before every `npm start`. A .env still works — it is the right way
 * for a deployment — but the file wins for anything it mentions, so editing it
 * on the page always does what it looks like it does.
 *
 *   data/publish.json   (mode 0600, gitignored)
 *   {
 *     "webhook": "https://discord.com/api/webhooks/…",   // a credential
 *     "ntfy": "squeeze-7f3k2p",
 *     "paste": false,
 *     "repo": false
 *   }
 *
 * Nothing here is ever handed back in full: a webhook URL is a password for
 * that channel, and /api/publish is readable.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = () => process.env.DATA_DIR || path.join(ROOT, 'data');
const SETTINGS_PATH = () => path.join(DATA_DIR(), 'publish.json');

const str = (value) => String(value == null ? '' : value).trim();

/** A URL, or nothing. Rejecting here keeps a typo out of the file. */
function url(value) {
  const text = str(value);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

/** Only scheme and host: the path of a Discord webhook is the token. */
function redact(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return null;
  }
}

/**
 * A webhook URL is what the user pasted; Discord's and Slack's are recognisable,
 * and saying which one it is makes "did that work?" easy to answer.
 */
function kindOf(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (/(^|\.)discord(app)?\.com$/.test(host)) return 'Discord';
    if (/(^|\.)slack\.com$/.test(host)) return 'Slack';
    return host;
  } catch {
    return '';
  }
}

function readSync() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8'));
  } catch {
    return null;
  }
}

function fromFile(file) {
  if (!file || typeof file !== 'object') return {};
  const out = {};
  if (url(file.webhook)) out.webhook = url(file.webhook);
  if (str(file.ntfy)) out.ntfy = str(file.ntfy);
  if (file.paste != null) out.paste = Boolean(file.paste);
  if (file.repo != null) out.repo = Boolean(file.repo);
  return out;
}

function fromEnv(env = process.env) {
  const out = {};
  if (url(env.PUBLISH_WEBHOOK)) out.webhook = url(env.PUBLISH_WEBHOOK);
  if (str(env.PUBLISH_NTFY)) out.ntfy = str(env.PUBLISH_NTFY);
  if (env.PUBLISH_PASTE) out.paste = true;
  if (env.PUBLISH_REPO === '1') out.repo = true;
  out.ntfyUrl = str(env.NTFY_URL) || 'https://ntfy.sh';
  out.pasteUrl = str(env.PASTE_URL) || 'https://0x0.st';
  return out;
}

/** The settings in force: file over environment. Read on every use. */
function current(env = process.env) {
  const environment = fromEnv(env);
  const saved = fromFile(readSync());
  const merged = { ...environment, ...saved };
  merged.ntfyUrl = environment.ntfyUrl;
  merged.pasteUrl = environment.pasteUrl;
  merged.fromFile = Object.keys(saved).length > 0;
  return merged;
}

/** The safe summary for the page. Never includes a token. */
function describe() {
  const config = current();
  return {
    webhook: config.webhook ? redact(config.webhook) : null,
    hasWebhook: Boolean(config.webhook),
    webhookKind: config.webhook ? kindOf(config.webhook) : null,
    ntfy: config.ntfy || null,
    paste: Boolean(config.paste),
    pasteUrl: config.pasteUrl,
    repo: Boolean(config.repo),
    saved: config.fromFile,
  };
}

/**
 * Save what the form sent. An omitted field is left alone, an empty string
 * clears it — that way "save" on a half-filled form is not destructive.
 */
async function save(input = {}) {
  const previous = fromFile(readSync());
  const next = { ...previous };

  if (input.webhook !== undefined) {
    if (!str(input.webhook)) delete next.webhook;
    else {
      const parsed = url(input.webhook);
      if (!parsed) throw Object.assign(new Error('That does not look like a webhook URL.'), { code: 'BAD_SETTINGS' });
      next.webhook = parsed;
    }
  }
  if (input.ntfy !== undefined) {
    if (!str(input.ntfy)) delete next.ntfy;
    else {
      const topic = str(input.ntfy);
      if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
        throw Object.assign(new Error('An ntfy topic is letters, digits, - and _ only.'), { code: 'BAD_SETTINGS' });
      }
      next.ntfy = topic;
    }
  }
  if (input.paste !== undefined) next.paste = Boolean(input.paste);
  if (input.repo !== undefined) next.repo = Boolean(input.repo);

  if (!Object.keys(next).length) {
    throw Object.assign(new Error('Nothing to save: give a webhook URL or an ntfy topic.'), { code: 'BAD_SETTINGS' });
  }

  await fsp.mkdir(DATA_DIR(), { recursive: true });
  const file = SETTINGS_PATH();
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file).catch(async (err) => {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw err;
  });
  await fsp.chmod(file, 0o600).catch(() => {});
  return describe();
}

async function forget() {
  await fsp.rm(SETTINGS_PATH(), { force: true }).catch(() => {});
  return describe();
}

module.exports = { current, describe, save, forget, kindOf, redact, SETTINGS_PATH };
