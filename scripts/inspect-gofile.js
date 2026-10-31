#!/usr/bin/env node
/**
 * Work out how gofile wants to be talked to right now: which scripts the page
 * loads, whether any of them carries the `wt` token, and what the contents API
 * answers with each candidate token.
 *
 *   node scripts/inspect-gofile.js yl6viZms
 */
'use strict';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const get = (url, init = {}) => fetch(url, { headers: { 'user-agent': UA, ...(init.headers || {}) }, ...init });

function candidateTokens(text) {
  const out = new Set();
  const patterns = [
    /\bwt\b["']?\s*[:=]\s*["']([A-Za-z0-9]{8,64})["']/g,
    /wt["']?\s*:\s*["']([A-Za-z0-9]{8,64})["']/g,
    /["']wt["']\s*,\s*["']([A-Za-z0-9]{8,64})["']/g,
    /wt=([A-Za-z0-9]{8,64})/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) out.add(m[1]);
  }
  return [...out];
}

(async () => {
  const raw = process.argv[2] || '';
  const code = (raw.match(/[A-Za-z0-9_-]{6,}/g) || []).pop();
  if (!code) {
    console.error('usage: node scripts/inspect-gofile.js <folder-code or link>');
    process.exit(64);
  }

  console.log('=== 1. share page ===');
  const page = await get(`https://gofile.io/d/${code}`, { headers: { accept: 'text/html' } });
  const html = await page.text();
  console.log(`status ${page.status} · ${html.length} bytes`);
  console.log('first 900 chars of the shell:');
  console.log(html.slice(0, 900).replace(/\s+/g, ' '));

  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log(`\nscript tags: ${scripts.length}`);
  scripts.forEach((s) => console.log('  ' + s));

  console.log('\n=== 2. hunting the wt token in the bundles ===');
  const found = [];
  for (const src of scripts.slice(0, 8)) {
    const url = new URL(src, 'https://gofile.io/').href;
    try {
      const res = await get(url);
      const js = await res.text();
      const tokens = candidateTokens(js);
      console.log(`${url} → ${res.status} · ${js.length} bytes · ${tokens.length} candidate(s)`);
      tokens.slice(0, 3).forEach((t) => {
        console.log('    token: ' + t);
        found.push(t);
      });
    } catch (err) {
      console.log(`${url} → failed: ${err.message}`);
    }
  }
  if (!found.length) console.log('no wt token found in the bundles');

  console.log('\n=== 3. what the API answers ===');
  const account = await get('https://api.gofile.io/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const accountData = await account.json().catch(() => ({}));
  const guest = accountData && accountData.data ? accountData.data.token : null;
  console.log('guest account: ' + (guest ? `${guest.slice(0, 10)}…` : 'refused'));

  const tries = [];
  if (found[0]) tries.push(['fresh token from bundle', `https://api.gofile.io/contents/${code}?wt=${found[0]}&cache=true`]);
  tries.push(['old hardcoded token', `https://api.gofile.io/contents/${code}?wt=4fd6sg89d7s6&cache=true`]);
  tries.push(['no wt at all', `https://api.gofile.io/contents/${code}?cache=true`]);

  for (const [label, url] of tries) {
    try {
      const res = await get(url, { headers: guest ? { authorization: `Bearer ${guest}` } : {} });
      const body = await res.text();
      let status = body.slice(0, 160);
      try {
        const parsed = JSON.parse(body);
        status = `${parsed.status} · keys: ${Object.keys(parsed.data || {}).slice(0, 6).join(',') || 'none'}`;
      } catch {
        /* not json */
      }
      console.log(`${label}: HTTP ${res.status} · ${status}`);
    } catch (err) {
      console.log(`${label}: failed — ${err.message}`);
    }
  }
})().catch((err) => {
  console.error('request failed:', err.message);
  process.exit(1);
});
