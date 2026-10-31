#!/usr/bin/env node
/**
 * Show what gofile actually sends back, so the parser can be fixed against
 * reality instead of guesses.
 *
 *   node scripts/inspect-gofile.js yl6viZms
 */
'use strict';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

(async () => {
  const raw = process.argv[2] || '';
  const code = (raw.match(/[A-Za-z0-9_-]{6,}/g) || []).pop();
  if (!code) {
    console.error('usage: node scripts/inspect-gofile.js <folder-code or link>');
    process.exit(64);
  }

  const url = `https://gofile.io/d/${code}`;
  console.log(`GET ${url}`);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  const html = await res.text();
  console.log(`status ${res.status} · ${html.length} bytes`);

  const links = [...new Set(html.match(/download\/web\/[A-Za-z0-9-]+\/[^"'<>\\ ]+/g) || [])];
  console.log(`\ndownload/web URLs in the HTML: ${links.length}`);
  links.slice(0, 12).forEach((l) => console.log('  ' + l));

  const inlineWt = html.match(/\bwt\b["']?\s*[:=]\s*["']([A-Za-z0-9]{8,64})["']/);
  console.log(`\ninline wt token: ${inlineWt ? inlineWt[1] : 'none'}`);

  for (const key of ['__NUXT__', '__NEXT_DATA__', '__sveltekit', 'application/json', 'api.gofile.io']) {
    console.log(`${key}: ${html.includes(key) ? 'yes' : 'no'}`);
  }

  const at = html.search(/download\/web/);
  if (at >= 0) {
    const context = html.slice(Math.max(0, at - 400), at + 400).replace(/\s+/g, ' ');
    console.log(`\ncontext around the first match:\n${context}`);
  } else {
    console.log('\n(no download/web URL at all — the page is rendered by JavaScript)');
  }
})().catch((err) => {
  console.error('request failed:', err.message);
  process.exit(1);
});
