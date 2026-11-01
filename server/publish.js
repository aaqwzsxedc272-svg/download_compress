'use strict';
/**
 * Getting the links out of the machine, with as little setup as possible.
 *
 * Email needs an app password, which is a real setup step. Sometimes the job is
 * "tell me the links" and nothing else, so there are cheaper routes, tried in
 * order, each one quitting as soon as it works:
 *
 *   gist    a GitHub gist, updated in place. In a Codespace `gh` is already
 *           logged in to your account, so this needs *no* input at all — the URL
 *           stays the same forever and opens on a phone.
 *   repo    commit LINKS.md to your own repository and push. Also no input in a
 *           Codespace (the built-in token can push); opt in with PUBLISH_REPO=1
 *           because it writes to your repo.
 *   webhook one URL, posted as JSON. Covers Discord, Slack, n8n, a Raspberry Pi.
 *   ntfy    a topic name, no account: the phone buzzes. Also one line to set up.
 *   paste   a public paste service, anonymous, returning a URL.
 *
 * The floor is not a sink at all: the links are always printed to the console
 * and are always on the page / in data/links.tsv, so "nothing configured" still
 * means "the links are somewhere".
 *
 * The last successful publication is remembered in data/published.json, so the
 * app can show the URL it last handed out.
 */

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = () => process.env.DATA_DIR || path.join(ROOT, 'data');
/* Where LINKS.md is committed. The project itself by default; PUBLISH_REPO_DIR
   points it at a notes repository instead. */
const REPO_ROOT = () => process.env.PUBLISH_REPO_DIR || ROOT;
const STATE_PATH = () => path.join(DATA_DIR(), 'published.json');
const UA = 'Squeeze/1.0 (+link publishing)';

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

/** One line per link: name, size change, provider. Used for text sinks. */
function linksText(links = [], { reason, intro } = {}) {
  const lines = [];
  if (reason) lines.push(reason, '');
  if (intro) lines.push(intro, '');
  if (!links.length) {
    lines.push('No share links yet.');
  } else {
    for (const link of links) {
      const bits = [];
      if (link.name) bits.push(link.name);
      if (link.sourceBytes && link.outputBytes) {
        bits.push(
          link.usedOriginal
            ? `${mb(link.sourceBytes)} (already small, original kept)`
            : `${mb(link.sourceBytes)} → ${mb(link.outputBytes)}`,
        );
      }
      if (link.provider) bits.push(`on ${link.provider}`);
      lines.push(bits.length ? `${bits.join(' · ')}\n${link.url}` : link.url, '');
    }
  }
  lines.push('Made by Squeeze — the links work on their own; the machine is not needed any more.');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The same thing as a Markdown document (a gist, a file in the repo). */
function linksMarkdown(links = [], { reason } = {}) {
  const out = ['# Squeeze — share links', ''];
  out.push(`Updated ${new Date().toUTCString()}${reason ? ` · ${reason}` : ''}`, '');
  if (!links.length) {
    out.push('_No share links yet._');
  } else {
    out.push('| File | Size | Host | Link |', '| --- | --- | --- | --- |');
    for (const link of links) {
      const size =
        link.sourceBytes && link.outputBytes
          ? link.usedOriginal
            ? `${mb(link.sourceBytes)} (original kept)`
            : `${mb(link.sourceBytes)} → ${mb(link.outputBytes)}`
          : '—';
      const name = String(link.name || 'video.mp4').replace(/\|/g, '\\|');
      out.push(`| ${name} | ${size} | ${link.provider || '—'} | ${link.url} |`);
    }
  }
  out.push('', '_The links work on their own — the machine they were made on is not needed any more._');
  return `${out.join('\n')}\n`;
}

/* ------------------------------------------------------------------ plumbing */

/** Run a command without a shell, with a timeout. */
function run(cmd, args, { cwd = ROOT, timeoutMs = 20000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ code: -2, stdout, stderr: `${cmd} timed out` });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_PATH(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(patch) {
  const merged = { ...(await readState()), ...patch };
  await fsp.mkdir(DATA_DIR(), { recursive: true }).catch(() => {});
  await fsp.writeFile(STATE_PATH(), `${JSON.stringify(merged, null, 2)}\n`).catch(() => {});
  return merged;
}

/**
 * Readiness checks spawn processes (gh, git) and /api/health is polled by the
 * page every few seconds, so each check is cached briefly. Saving an env change
 * takes effect within the TTL; a publish attempt always re-checks for real.
 */
function cached(ttlMs, fn) {
  let at = 0;
  let value = null;
  let pending = null;
  const wrapped = async ({ fresh = false } = {}) => {
    if (!fresh) {
      if (value && Date.now() - at < ttlMs) return value;
      if (pending) return pending;
    }
    const run = Promise.resolve()
      .then(() => fn())
      .then((result) => {
        value = result;
        at = Date.now();
        return result;
      })
      .finally(() => {
        if (pending === run) pending = null;
      });
    pending = run;
    return run;
  };
  return wrapped;
}

/* --------------------------------------------------------------------- sinks */

/** A GitHub gist, created once and updated in place, so the URL never changes. */
const gist = {
  id: 'gist',
  label: 'GitHub gist',
  ready: cached(120000, async () => {
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      /* A token may or may not carry the gist scope; only a real call knows. */
      return { ready: true, detail: 'using the GitHub token in the environment' };
    }
    const auth = await run('gh', ['auth', 'status'], { timeoutMs: 8000 });
    if (auth.code === 0) return { ready: true, detail: 'gh is logged in' };
    return { ready: false, detail: 'gh is not logged in' };
  }),
  async send(links) {
    const content = linksMarkdown(links);
    const file = path.join(DATA_DIR(), 'links-publish.md');
    await fsp.mkdir(DATA_DIR(), { recursive: true }).catch(() => {});
    await fsp.writeFile(file, content);

    const state = await readState();
    if (state.gistUrl) {
      const edit = await run('gh', ['gist', 'edit', state.gistUrl, '-f', file], { timeoutMs: 30000 });
      if (edit.code === 0) return { url: state.gistUrl, updated: true };
      /* The gist was deleted, or the token changed: fall through and make one. */
    }
    const create = await run('gh', ['gist', 'create', '--desc', 'Squeeze — share links', file], {
      timeoutMs: 30000,
    });
    const url = create.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^https:\/\/gist\.github\.com\//.test(line))
      .pop();
    if (create.code !== 0 || !url) {
      throw new Error(
        (create.stderr || create.stdout || 'gh gist create failed').split('\n').filter(Boolean).pop(),
      );
    }
    await writeState({ gistUrl: url });
    return { url, created: true };
  },
};

/** Commit LINKS.md to the repository this runs from, and push it. */
const repo = {
  id: 'repo',
  label: 'LINKS.md in the repository',
  ready: cached(120000, async () => {
    if (process.env.PUBLISH_REPO !== '1') {
      return { ready: false, detail: 'set PUBLISH_REPO=1 to commit the links to your repo' };
    }
    const cwd = REPO_ROOT();
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 5000 });
    if (inside.code !== 0) return { ready: false, detail: 'not inside a git repository' };
    const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 5000 });
    if (remote.code !== 0) return { ready: false, detail: 'no origin remote to push to' };
    return { ready: true, detail: remote.stdout.trim() };
  }),
  async send(links) {
    const root = REPO_ROOT();
    const file = path.join(root, 'LINKS.md');
    await fsp.writeFile(file, linksMarkdown(links));
    const add = await run('git', ['add', 'LINKS.md'], { cwd: root });
    if (add.code !== 0) throw new Error(add.stderr.trim() || 'git add failed');

    /* A machine with no git identity configured cannot commit at all — common
       on a fresh Codespace. Supply one for this commit only. */
    const identity = [];
    const email = await run('git', ['config', 'user.email'], { cwd: root });
    const name = await run('git', ['config', 'user.name'], { cwd: root });
    if (!email.stdout.trim()) identity.push('-c', 'user.email=squeeze@localhost');
    if (!name.stdout.trim()) identity.push('-c', 'user.name=Squeeze');

    /* --only: commit this file and nothing else that happens to be staged. */
    const commit = await run(
      'git',
      [...identity, 'commit', '-m', `Squeeze: ${links.length} share link(s)`, '--only', 'LINKS.md'],
      { cwd: root },
    );
    if (commit.code !== 0 && !/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
      throw new Error((commit.stderr || commit.stdout).trim().split('\n').pop());
    }
    const push = await run('git', ['push'], { cwd: root, timeoutMs: 90000 });
    if (push.code !== 0) throw new Error((push.stderr || push.stdout).trim().split('\n').pop() || 'git push failed');

    const remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd: root })).stdout.trim();
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).stdout.trim();
    const web = remote
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
      .replace(/\.git$/, '');
    const url = /^https:\/\/github\.com\//.test(web) ? `${web}/blob/${branch}/LINKS.md` : null;
    return { url, pushed: true };
  },
};

/** Any URL that takes a JSON POST: Discord, Slack, n8n, a home server. */
const webhook = {
  id: 'webhook',
  label: 'Webhook',
  async ready() {
    const url = process.env.PUBLISH_WEBHOOK || '';
    return url ? { ready: true, detail: url.replace(/\/\/[^/]+\//, '//…/') } : { ready: false, detail: 'set PUBLISH_WEBHOOK' };
  },
  async send(links, { reason } = {}) {
    const url = process.env.PUBLISH_WEBHOOK;
    const text = linksText(links, { reason });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      /* Both keys, so Discord (`content`) and Slack (`text`) work unchanged. */
      body: JSON.stringify({
        content: text,
        text,
        title: 'Squeeze share links',
        links: links.map((link) => ({
          name: link.name,
          url: link.url,
          provider: link.provider,
          sourceBytes: link.sourceBytes,
          outputBytes: link.outputBytes,
        })),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`the webhook answered HTTP ${res.status}`);
    return { url: null, posted: true };
  },
};

/** ntfy.sh: no account, a topic name, and the phone buzzes. */
const ntfy = {
  id: 'ntfy',
  label: 'ntfy push',
  async ready() {
    const topic = process.env.PUBLISH_NTFY || '';
    return topic ? { ready: true, detail: `topic ${topic}` } : { ready: false, detail: 'set PUBLISH_NTFY=<topic>' };
  },
  async send(links, { reason } = {}) {
    const topic = process.env.PUBLISH_NTFY;
    const base = (process.env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
    const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        title: `Squeeze: ${links.length} link${links.length === 1 ? '' : 's'} ready`,
        tags: 'package',
        /* Tapping the notification opens the first link. */
        ...(links[0] ? { click: links[0].url } : {}),
      },
      body: linksText(links, { reason }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
    return { url: links[0] ? links[0].url : null, posted: true };
  },
};

/** An anonymous paste service: no account, returns a URL. */
const paste = {
  id: 'paste',
  label: 'Anonymous paste',
  async ready() {
    if (process.env.PUBLISH_PASTE !== '1' && !process.env.PUBLISH) {
      return { ready: false, detail: 'set PUBLISH_PASTE=1 (links become a public paste)' };
    }
    return { ready: true, detail: process.env.PASTE_URL || 'https://0x0.st' };
  },
  async send(links, { reason } = {}) {
    const text = linksText(links, { reason });
    const base = (process.env.PASTE_URL || 'https://0x0.st').replace(/\/+$/, '');

    if (/paste\.rs$/i.test(base)) {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'user-agent': UA, 'content-type': 'text/plain' },
        body: text,
        signal: AbortSignal.timeout(20000),
      });
      const url = (await res.text()).trim();
      if (!res.ok || !/^https?:\/\//.test(url)) throw new Error(`paste.rs answered HTTP ${res.status}`);
      return { url, created: true };
    }

    /* 0x0.st wants a multipart file upload. */
    const form = new FormData();
    form.append('file', new Blob([text], { type: 'text/plain' }), 'squeeze-links.txt');
    const res = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'user-agent': UA },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    const url = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//.test(url)) {
      throw new Error(`${new URL(base).host} answered HTTP ${res.status}`);
    }
    return { url, created: true };
  },
};

const SINKS = { gist, repo, webhook, ntfy, paste };

/** The sinks to try, in order, from PUBLISH. */
function resolveChain() {
  const raw = (process.env.PUBLISH || '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'none') return [];
  if (raw) {
    return raw
      .split(/[,\s]+/)
      .map((id) => SINKS[id])
      .filter(Boolean);
  }
  /* Auto: everything that needs nothing, in the order that needs least. A
     configured webhook or topic jumps ahead of a gist, because the person
     chose it. */
  const chain = [];
  if (process.env.PUBLISH_WEBHOOK) chain.push(webhook);
  if (process.env.PUBLISH_NTFY) chain.push(ntfy);
  chain.push(gist);
  if (process.env.PUBLISH_REPO === '1') chain.push(repo);
  if (process.env.PUBLISH_PASTE === '1') chain.push(paste);
  return chain;
}

/**
 * Publish the links, first sink that works wins.
 * Never throws: callers are job stages and must not die because a gist failed.
 */
async function publish(links, { reason, quiet = false } = {}) {
  const list = (links || []).filter((link) => link && link.url);
  if (!list.length) return { ok: false, reason: 'nothing-to-publish' };

  const tried = [];
  for (const sink of resolveChain()) {
    /* Always a fresh answer here: a stale "not ready" would skip the sink the
       user just configured, and a stale "ready" would waste a request. */
    const state = await sink.ready({ fresh: true }).catch((err) => ({ ready: false, detail: err.message }));
    if (!state.ready) {
      tried.push({ sink: sink.id, skipped: state.detail });
      continue;
    }
    try {
      const result = await sink.send(list, { reason });
      const saved = await writeState({
        sink: sink.id,
        url: result.url || null,
        at: Date.now(),
        count: list.length,
        reason: reason || null,
      });
      if (!quiet) {
        console.log(`[publish] ${list.length} link(s) via ${sink.label}${result.url ? ` — ${result.url}` : ''}`);
      }
      return { ok: true, sink: sink.id, label: sink.label, url: result.url || null, count: list.length, tried, state: saved };
    } catch (err) {
      tried.push({ sink: sink.id, error: err.message });
      if (!quiet) console.warn(`[publish] ${sink.id} failed: ${err.message}`);
    }
  }
  return { ok: false, reason: 'no-sink-worked', tried };
}

/** What the UI and /api/health show. */
async function describe() {
  const chain = resolveChain();
  const ready = [];
  for (const [id, sink] of Object.entries(SINKS)) {
    let state = { ready: false, detail: '' };
    try {
      state = await sink.ready();
    } catch (err) {
      state = { ready: false, detail: err.message };
    }
    ready.push({
      id,
      label: sink.label,
      ready: state.ready,
      detail: state.detail,
      inChain: chain.some((entry) => entry.id === id),
    });
  }
  const state = await readState();
  return {
    chain: chain.map((sink) => sink.id),
    disabled: !chain.length,
    sinks: ready,
    last: state.sink
      ? { sink: state.sink, url: state.url || null, at: state.at || null, count: state.count || 0 }
      : null,
  };
}

/** The console floor: always available, no configuration at all. */
function banner(links, { reason } = {}) {
  const list = (links || []).filter((link) => link && link.url);
  if (!list.length) return '';
  const lines = ['', '─'.repeat(64), `  ${list.length} share link${list.length === 1 ? '' : 's'} ready`];
  if (reason) lines.push(`  ${reason}`);
  lines.push('─'.repeat(64));
  for (const link of list) {
    lines.push(`  ${link.name || 'video'}`);
    lines.push(`  ${link.url}`);
    lines.push('');
  }
  lines.push('  Also on the page (/api/links), in data/links.tsv and at /api/links.txt.');
  lines.push('─'.repeat(64), '');
  const text = lines.join('\n');
  console.log(text);
  return text;
}

module.exports = {
  publish,
  describe,
  banner,
  linksText,
  linksMarkdown,
  resolveChain,
  SINKS,
  STATE_PATH,
};
