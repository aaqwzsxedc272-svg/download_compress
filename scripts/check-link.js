#!/usr/bin/env node
/**
 * Say what a link actually resolves to, without downloading anything.
 *
 *   node scripts/check-link.js https://gofile.io/d/xxxx
 *
 * Prints one JSON object: the resolver that matched, the folder title and every
 * file it found. Exit code 1 means the link could not be read at all.
 */
'use strict';

const { resolve, setGofileBrowser } = require('../shared/resolve');

// If a headless browser is installed, let gofile fall back to it.
try {
  const browser = require('../server/browser');
  if (browser.available()) setGofileBrowser((code) => browser.gofileFolder(code));
} catch {
  /* optional */
}

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node scripts/check-link.js <url>');
    process.exit(64);
  }
  try {
    const result = await resolve(url);
    console.log(
      JSON.stringify(
        {
          ok: true,
          resolver: result.resolver,
          title: result.title,
          files: result.files.map((f) => ({
            name: f.name,
            size: f.size ? `${(f.size / 1073741824).toFixed(2)} GB` : 'unknown',
            kind: f.kind,
          })),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.log(JSON.stringify({ ok: false, code: err.code || null, message: err.message }, null, 2));
    process.exit(1);
  }
})();
