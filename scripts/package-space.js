'use strict';

/**
 * Build a Hugging Face Space bundle.
 *
 * A Space is a git repo whose README.md starts with YAML metadata describing the
 * runtime. This assembles exactly the files the app needs, drops the tests and
 * docs, and writes that README, so a push to a Space repository just works.
 *
 *   node scripts/package-space.js [outDir]
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'hf-space'));

const INCLUDE = [
  'server',
  'public',
  'shared',
  'package.json',
  'package-lock.json',
  'Dockerfile',
  '.dockerignore',
];

const SKIP_DIRS = new Set(['node_modules', 'data', 'dist', '.git']);

function spaceReadme(repoUrl) {
  return `---
title: Squeeze
emoji: 🗜️
colorFrom: green
colorTo: gray
sdk: docker
app_port: 3000
pinned: false
short_description: Compress videos from a link and get a share link back
---

# Squeeze

Paste a video link, walk away, come back to a share link.

This Space runs the app from ${repoUrl}. It downloads the video, re-encodes it with
libx264 at the quality setting you pick, uploads the result to a free anonymous file
host (gofile, then pixeldrain, then catbox) and shows the link.

- \`/diagnostics\` reports what this container can reach — useful after a first deploy.
- \`AUTO_HOST=0\` turns the automatic re-hosting off.
- \`HOSTERS=gofile,pixeldrain\` controls the order hosts are tried.

Free CPU Basic hardware is fine: set **MAX_CONCURRENT=1** in the Space settings.
`;
}

async function copyTree(from, to) {
  const stat = await fsp.stat(from);
  if (stat.isFile()) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    return 1;
  }
  if (!stat.isDirectory() || SKIP_DIRS.has(path.basename(from))) return 0;

  let count = 0;
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from)) {
    if (entry === '.DS_Store') continue;
    count += await copyTree(path.join(from, entry), path.join(to, entry));
  }
  return count;
}

async function main() {
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));

  let repoUrl = 'https://github.com/aaqwzsxedc272-svg/download_compress';
  try {
    const gitConfig = await fsp.readFile(path.join(ROOT, '.git', 'config'), 'utf8');
    const match = /url = git@github\.com:([^/]+)\/(.+?)(?:\.git)?$|url = https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/m.exec(
      gitConfig,
    );
    if (match) {
      const owner = match[1] || match[3];
      const repo = (match[2] || match[4] || '').replace(/\.git$/, '');
      if (owner && repo) repoUrl = `https://github.com/${owner}/${repo}`;
    }
  } catch {
    /* keep the default */
  }

  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });

  let files = 0;
  const present = [];
  for (const entry of INCLUDE) {
    const from = path.join(ROOT, entry);
    if (!fs.existsSync(from)) continue;
    files += await copyTree(from, path.join(OUT, entry));
    present.push(entry);
  }

  await fsp.writeFile(path.join(OUT, 'README.md'), spaceReadme(repoUrl));

  // Fail loudly rather than shipping a broken Space.
  const required = ['Dockerfile', 'package.json', 'package-lock.json', 'server/server.js', 'public/index.html'];
  const missing = required.filter((rel) => !fs.existsSync(path.join(OUT, rel)));
  const leaked = ['node_modules', 'data'].filter((rel) => fs.existsSync(path.join(OUT, rel)));

  if (missing.length) {
    console.error(`Space bundle is missing: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (leaked.length) {
    console.error(`Space bundle should not contain: ${leaked.join(', ')}`);
    process.exit(1);
  }

  // The README metadata is what makes the Space boot; verify it parses.
  const readme = await fsp.readFile(path.join(OUT, 'README.md'), 'utf8');
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(readme);
  const meta = frontMatter ? frontMatter[1] : '';
  for (const key of ['sdk: docker', 'app_port: 3000']) {
    if (!meta.includes(key)) {
      console.error(`Space README is missing "${key}"`);
      process.exit(1);
    }
  }

  const bytes = await du(OUT);
  console.log(`Space bundle ready: ${OUT}`);
  console.log(`  ${files} files, ${(bytes / 1024).toFixed(0)} KB, includes: ${present.join(', ')}`);
  console.log('  README metadata: sdk: docker, app_port: 3000');
  console.log(`  app version: ${pkg.version}`);
}

async function du(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await du(full);
    else total += (await fsp.stat(full)).size;
  }
  return total;
}

main().catch((err) => {
  console.error('Could not build the Space bundle:', err.message);
  process.exit(1);
});
