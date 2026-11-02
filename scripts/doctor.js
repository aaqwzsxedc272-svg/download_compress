#!/usr/bin/env node
/**
 * "This link still does not work."
 *
 *   npm run doctor -- https://theditch.st/qhygxukd
 *
 * Runs the real resolver against the real host, prints every stage, and says
 * what the answer means. It does not need the app to be running, and it touches
 * nothing in data/.
 */
'use strict';

const { diagnose } = require('../server/diagnose');

const url = process.argv.slice(2).find((arg) => /^https?:\/\//i.test(arg));

(async () => {
  if (!url) {
    console.log('usage: npm run doctor -- <link>');
    console.log('example: npm run doctor -- https://theditch.st/qhygxukd');
    process.exit(1);
  }
  const result = await diagnose(url);
  console.log(result.text);
  process.exit(0);
})().catch((err) => {
  console.error(`doctor failed: ${err.stack || err.message}`);
  process.exit(1);
});
