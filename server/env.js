'use strict';
/**
 * Read a `.env` file from the project root, if there is one.
 *
 * Environment variables are the right place for deploy-time settings, but
 * "type this before every npm start" is not a workflow. A `.env` file makes it
 * a one-time thing: the values are there every time the server starts, and the
 * file is already gitignored, so nothing leaks into the repository.
 *
 * Real environment variables still win — `SMTP_PASS=… npm start` overrides the
 * file, which is what a deployment or a Codespaces secret would do.
 */

const fs = require('node:fs');
const path = require('node:path');

/* ENV_FILE lets a deployment point at another file; ./.env is the normal case. */
const DEFAULT_PATH = process.env.ENV_FILE || path.join(__dirname, '..', '.env');

/** Parse the small subset of dotenv this project needs: KEY=value, # comments. */
function parse(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      /* An unquoted trailing comment is a comment. */
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

/** Load the file into process.env without overwriting anything already set. */
function load(file = DEFAULT_PATH, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { loaded: false, path: file, keys: [] };
  }
  const values = parse(text);
  const keys = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] == null || env[key] === '') {
      env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, path: file, keys };
}

module.exports = { load, parse, DEFAULT_PATH };
