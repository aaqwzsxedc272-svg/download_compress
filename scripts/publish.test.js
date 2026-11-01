'use strict';

/**
 * Publishing the links with no setup at all.
 *
 * Email needs an app password; this path needs nothing on a Codespace, and one
 * URL or one topic name anywhere else. What has to be true:
 *
 *   1. the console floor always works and always names every link;
 *   2. a gist is created once and *updated* afterwards, so the URL is stable;
 *   3. a gist that the token cannot create is reported, not swallowed, and the
 *      chain moves on to the next sink;
 *   4. a webhook receives the links as JSON (Discord/Slack shaped);
 *   5. an ntfy topic receives them as a notification;
 *   6. a paste service receives them and its URL is remembered;
 *   7. PUBLISH=off publishes nothing.
 *
 * The `gh` binary is faked on PATH and the HTTP sinks point at a local server,
 * so the test needs no account and no network.
 *
 *   npm run test:publish
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const LINKS = [
  {
    name: 'Kate Dalia - Lazy Day Off.mp4',
    url: 'https://pixeldrain.com/u/TestLink1',
    provider: 'pixeldrain',
    sourceBytes: 508 * 1024 ** 2,
    outputBytes: 341 * 1024 ** 2,
  },
  { name: 'Second.mp4', url: 'https://pixeldrain.com/u/TestLink2', provider: 'pixeldrain' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake `gh` on PATH. `mode` decides whether `gist create` works, which is
 * exactly the difference between a Codespace token with the gist scope and one
 * without.
 */
function fakeGh(dir, { canCreate = true } = {}) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, 'gh.log');
  const script = `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "auth status") echo "Logged in to github.com"; exit 0 ;;
  "gist create")
    ${canCreate ? 'echo "https://gist.github.com/aaqwzsxedc272-svg/deadbeefcafe"' : 'echo "Failed to create gist: HTTP 403: Resource not accessible by integration" >&2; exit 1'} ;;
  "gist edit")
    echo "edited $3" ;;
  *) exit 0 ;;
esac
`;
  const file = path.join(bin, 'gh');
  fs.writeFileSync(file, script, { mode: 0o755 });
  return { bin, log };
}

/** A local stand-in for a webhook, ntfy and a paste service. */
function fakeHttp() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url.startsWith('/paste/')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('http://127.0.0.1/paste/abc123\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squeeze-publish-'));
  const dataDir = path.join(tmp, 'data');
  const gh = fakeGh(tmp);
  const http_ = await fakeHttp();

  /* A throwaway data dir and a fake gh: no state from a real run, no account. */
  process.env.DATA_DIR = dataDir;
  process.env.PATH = `${gh.bin}${path.delimiter}${process.env.PATH}`;
  for (const key of ['PUBLISH', 'PUBLISH_WEBHOOK', 'PUBLISH_NTFY', 'PUBLISH_PASTE', 'PUBLISH_REPO', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    delete process.env[key];
  }

  const publish = require('../server/publish');

  console.log('console floor');

  const text = publish.linksText(LINKS);
  check('every link is in the text', LINKS.every((link) => text.includes(link.url)));
  check('the size change is spelled out', /508 MB → 341 MB/.test(text), text.split('\n')[0]);
  const markdown = publish.linksMarkdown(LINKS);
  check('markdown is a table with both links', markdown.includes('| File | Size | Host | Link |') && LINKS.every((l) => markdown.includes(l.url)));
  check('nothing to publish is not an error', (await publish.publish([])).reason === 'nothing-to-publish');

  console.log('gist (nothing to configure)');

  const first = await publish.publish(LINKS, { reason: 'test' });
  check('a gist is created with no configuration at all', first.ok === true && first.sink === 'gist', JSON.stringify(first.tried || first.error));
  check('its URL comes back', /^https:\/\/gist\.github\.com\//.test(first.url || ''), first.url);
  const ghLog = fs.readFileSync(gh.log, 'utf8');
  check('gh gist create was called', /gist create/.test(ghLog), ghLog.trim().split('\n').pop());

  const second = await publish.publish(LINKS, { reason: 'second run' });
  const ghLog2 = fs.readFileSync(gh.log, 'utf8');
  check('the second run updates the same gist', /gist edit https:\/\/gist\.github\.com\//.test(ghLog2));
  check('and keeps the same URL', second.url === first.url, `${first.url} → ${second.url}`);
  check('the URL is remembered on disk', JSON.parse(fs.readFileSync(path.join(dataDir, 'published.json'), 'utf8')).sink === 'gist');

  console.log('a token that cannot make gists');

  const blocked = fakeGh(path.join(tmp, 'blocked'), { canCreate: false });
  const savedPath = process.env.PATH;
  process.env.PATH = `${blocked.bin}${path.delimiter}${savedPath}`;
  await fsp.rm(path.join(dataDir, 'published.json'), { force: true });
  const failedGist = await publish.publish(LINKS, { quiet: true });
  check('a refused gist is reported, not swallowed', failedGist.ok === false);
  check(
    'and the reason is the one GitHub gave',
    (failedGist.tried || []).some((entry) => /403|not accessible/i.test(entry.error || '')),
    JSON.stringify(failedGist.tried),
  );
  process.env.PATH = savedPath;

  console.log('a webhook needs one URL');

  process.env.PUBLISH_WEBHOOK = `${http_.base}/hook`;
  process.env.PUBLISH = 'webhook';
  await sleep(50);
  const hooked = await publish.publish(LINKS, { reason: 'queue finished' });
  check('the webhook sink succeeds', hooked.ok === true && hooked.sink === 'webhook', JSON.stringify(hooked));
  const post = http_.seen.find((entry) => entry.url === '/hook');
  const payload = JSON.parse(post.body);
  check('it posts every link', LINKS.every((link) => payload.text.includes(link.url)));
  check('the body is readable by Discord and Slack', typeof payload.content === 'string' && payload.content === payload.text);
  check('it carries the reason', /queue finished/.test(payload.text));
  check('and structured links', payload.links.length === 2 && payload.links[0].provider === 'pixeldrain');
  delete process.env.PUBLISH;

  console.log('ntfy needs one topic');

  process.env.PUBLISH_NTFY = 'squeeze-test-topic';
  process.env.NTFY_URL = http_.base;
  process.env.PUBLISH = 'ntfy';
  const pushed = await publish.publish(LINKS, { reason: 'queue finished' });
  const note = http_.seen.find((entry) => entry.url === '/squeeze-test-topic');
  check('the notification sink succeeds', pushed.ok === true && pushed.sink === 'ntfy', JSON.stringify(pushed));
  check('it goes to the topic with a title', Boolean(note) && /links ready/.test(note.headers.title || ''));
  check('the first link is one tap away', note.headers.click === LINKS[0].url, note.headers.click);
  check('the body lists every link', LINKS.every((link) => note.body.includes(link.url)));
  delete process.env.PUBLISH_NTFY;
  delete process.env.NTFY_URL;
  delete process.env.PUBLISH;

  console.log('a paste is opt-in');

  for (const key of ['PUBLISH_WEBHOOK', 'PUBLISH_NTFY']) delete process.env[key];
  const autoDescribe = await publish.describe();
  check('paste is not in the auto chain by default', autoDescribe.chain.includes('paste') === false, autoDescribe.chain.join(','));
  check('and it says why', /PUBLISH_PASTE/.test(autoDescribe.sinks.find((s) => s.id === 'paste').detail));

  process.env.PUBLISH_PASTE = '1';
  process.env.PASTE_URL = `${http_.base}/paste`;
  process.env.PUBLISH = 'paste';
  const pasted = await publish.publish(LINKS, { reason: 'queue finished' });
  check('the paste sink succeeds', pasted.ok === true && pasted.sink === 'paste', JSON.stringify(pasted));
  check('its URL is what the service returned', pasted.url === 'http://127.0.0.1/paste/abc123', pasted.url);
  const upload = http_.seen.filter((entry) => entry.url.startsWith('/paste')).pop();
  check('the upload is a file a service like 0x0.st accepts', /multipart\/form-data/.test(upload.headers['content-type'] || ''));
  check('with every link inside', LINKS.every((link) => upload.body.includes(link.url)));
  delete process.env.PUBLISH;
  delete process.env.PASTE_URL;

  console.log('turning it off');

  process.env.PUBLISH = 'off';
  const off = await publish.describe();
  check('PUBLISH=off empties the chain', off.chain.length === 0 && off.disabled === true);
  const nothing = await publish.publish(LINKS);
  check('and nothing is sent', nothing.ok === false);
  delete process.env.PUBLISH;

  console.log('LINKS.md in a repository (opt-in)');

  /* A throwaway repo with a real remote, so the commit and push are genuine. */
  const repoDir = path.join(tmp, 'notes');
  const remoteDir = path.join(tmp, 'notes-remote.git');
  const sh = (cmd, args, cwd) =>
    require('node:child_process').execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
    });
  fs.mkdirSync(repoDir, { recursive: true });
  sh('git', ['init', '--bare', '-b', 'main', remoteDir], tmp);
  sh('git', ['init', '-b', 'main'], repoDir);
  sh('git', ['remote', 'add', 'origin', remoteDir], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# notes\n');
  sh('git', ['add', 'README.md'], repoDir);
  sh('git', ['commit', '-m', 'start'], repoDir);
  sh('git', ['push', '-u', 'origin', 'main'], repoDir);

  for (const key of ['PUBLISH_WEBHOOK', 'PUBLISH_NTFY', 'PUBLISH_PASTE', 'PUBLISH']) delete process.env[key];
  process.env.PUBLISH = 'repo';
  process.env.PUBLISH_REPO_DIR = repoDir;
  const beforeRepo = await publish.describe();
  check('without the opt-in the repo sink stays off', beforeRepo.sinks.find((s) => s.id === 'repo').ready === false);

  process.env.PUBLISH_REPO = '1';
  const repoPublish = await publish.publish(LINKS, { reason: 'queue finished' });
  check('the opt-in commits and pushes', repoPublish.ok === true && repoPublish.sink === 'repo', JSON.stringify(repoPublish.tried || repoPublish));
  const committed = fs.readFileSync(path.join(repoDir, 'LINKS.md'), 'utf8');
  check('LINKS.md lists every link', LINKS.every((link) => committed.includes(link.url)));
  const log = String(sh('git', ['log', '--oneline', '-1'], repoDir)).trim();
  check('it is a real commit', /Squeeze: 2 share link/.test(log), log);
  const onRemote = String(sh('git', ['--git-dir', remoteDir, 'show', 'main:LINKS.md']));
  check('and it reached the remote', LINKS.every((link) => onRemote.includes(link.url)));

  /* A second run updates the same file: one commit per run, no duplicates. */
  await publish.publish(LINKS, { reason: 'second run' });
  const secondDoc = String(sh('git', ['--git-dir', remoteDir, 'show', 'main:LINKS.md']));
  check('the document replaces itself instead of growing', (secondDoc.match(/pixeldrain\.com/g) || []).length === LINKS.length);

  delete process.env.PUBLISH;
  delete process.env.PUBLISH_REPO;
  delete process.env.PUBLISH_REPO_DIR;

  console.log('discord');

  /* Discord's webhook shape: `content` only, 2000 characters max, and it names
     the reason in the error body when something is wrong. */
  delete process.env.PUBLISH_REPO;
  delete process.env.PUBLISH_REPO_DIR;
  process.env.PUBLISH_WEBHOOK = 'https://discord.com/api/webhooks/123456789/SECRET-token-value';
  process.env.PUBLISH = 'webhook';
  const discordDescribe = await publish.describe();
  const wh = discordDescribe.sinks.find((sink) => sink.id === 'webhook');
  check('a Discord webhook is recognised', /Discord/.test(wh.detail), wh.detail);
  check('the token is never handed back', !JSON.stringify(discordDescribe).includes('SECRET-token-value'), wh.detail);
  check('only the host is shown', /https:\/\/discord\.com\/…$/.test(wh.detail), wh.detail);

  /* Point the same sink at the local server, through a /webhook/ path. */
  const discordSeen = [];
  const discordServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      discordSeen.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
  const discordPort = discordServer.address().port;

  /* A real Discord URL cannot be used from a test, so the host detection is
     exercised above and the payload shape below against a local server with an
     explicit PUBLISH=webhook. */
  process.env.PUBLISH_WEBHOOK = `http://127.0.0.1:${discordPort}/api/webhooks/1/token`;
  const genericPost = await publish.publish(LINKS, { reason: 'queue finished' });
  check('a non-Discord webhook still gets Slack-shaped text', genericPost.ok === true);
  const genericBody = JSON.parse(discordSeen[0].body);
  check('with a text field', typeof genericBody.text === 'string' && genericBody.text.includes(LINKS[0].url));

  /* The chunker is what keeps Discord happy, and it is pure, so it can be
     tested on its own with the real limits. */
  const many = Array.from({ length: 60 }, (_, i) => ({
    name: `Episode ${String(i + 1).padStart(2, '0')}.mp4`,
    url: `https://pixeldrain.com/u/Episode${i + 1}`,
    provider: 'pixeldrain',
  }));
  const big = publish.linksText(many, { reason: 'The queue is finished.' });
  check('a long list is over the limit', big.length > 2000, `${big.length} chars`);
  const pieces = publish.chunkText(big);
  check('so it is split', pieces.length > 1, `${pieces.length} piece(s)`);
  check('every piece fits in a Discord message', pieces.every((piece) => piece.length <= 2000), pieces.map((p) => p.length).join(','));
  const rejoined = pieces.join('\n\n');
  check(
    'no link is lost or cut',
    many.every((link) => rejoined.includes(link.url)),
    `${many.filter((link) => !rejoined.includes(link.url)).length} missing`,
  );
  check('links are never cut in half', pieces.every((piece) => !/https:\/\/pixeldrain\.com\/u\/[A-Za-z]+$/.test(piece.replace(/\n[\s\S]*$/, ''))) );
  const absurd = publish.linksText(
    Array.from({ length: 400 }, (_, i) => ({ name: `F${i}.mp4`, url: `https://x.test/${i}`, provider: 'x' })),
  );
  const capped = publish.chunkText(absurd);
  check('an absurd queue is capped', capped.length <= 6, `${capped.length} message(s)`);
  check('and says so instead of dropping links silently', /more message\(s\) of links/.test(capped[capped.length - 1]));

  /* A failing Discord answers with {"message": "…"} — that must reach the user. */
  const failing = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }));
    });
  });
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
  process.env.PUBLISH_WEBHOOK = `http://127.0.0.1:${failing.address().port}/api/webhooks/1/token`;
  const broken = await publish.publish(LINKS, { quiet: true });
  check('a deleted webhook is reported', broken.ok === false);
  check(
    'with the service\'s own words',
    /Unknown Webhook/.test(JSON.stringify(broken.tried)),
    JSON.stringify(broken.tried),
  );
  discordServer.close();
  failing.close();
  delete process.env.PUBLISH;
  delete process.env.PUBLISH_WEBHOOK;

  console.log('the banner');

  const originalLog = console.log;
  let bannerText = '';
  console.log = (...args) => {
    bannerText += `${args.join(' ')}\n`;
  };
  publish.banner(LINKS, { reason: 'The queue is finished.' });
  console.log = originalLog;
  check('the console floor names every link', LINKS.every((link) => bannerText.includes(link.url)));
  check('it explains where else they are', /data\/links\.tsv/.test(bannerText));

  http_.server.close();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`Publish run crashed: ${err.message}`);
  process.exit(1);
});
