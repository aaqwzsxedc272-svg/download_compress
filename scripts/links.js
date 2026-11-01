#!/usr/bin/env node
/**
 * Print every share link this machine has produced — no server needed.
 *
 *   npm run links            # one line per link
 *   npm run links -- --save  # also write squeeze-links.txt next to the data dir
 *
 * Useful when the Codespace was restarted and you just want the links back.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ledger = require('../server/ledger');

(async () => {
  const args = process.argv.slice(2);
  const links = await ledger.list();
  if (!links.length) {
    console.log('No share links yet. Run `npm start`, paste a link, and the finished file gets one.');
    return;
  }

  console.log(`${links.length} saved share link${links.length === 1 ? '' : 's'}:\n`);
  for (const link of links) {
    const when = link.at ? new Date(link.at).toLocaleString() : '';
    const size = link.outputBytes ? `${(link.outputBytes / 1048576).toFixed(0)} MB` : '';
    console.log(link.url);
    console.log(`   ${[link.name, size, when].filter(Boolean).join(' · ')}\n`);
  }

  if (args.includes('--save') || args.includes('-s')) {
    const out = path.join(process.cwd(), 'squeeze-links.txt');
    fs.writeFileSync(out, `${links.map((link) => `${link.url}\t${link.name || ''}`).join('\n')}\n`);
    console.log(`Wrote ${links.length} link(s) to ${out}`);
  }
  console.log(`Ledger: ${ledger.LEDGER_PATH}`);
})();
