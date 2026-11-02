'use strict';
/**
 * "This link still does not work" — what exactly happens, step by step.
 *
 * Written for hosts behind a bot check, where every step can fail for a
 * different reason and the app can only show one line of it. This runs the same
 * code the app runs and reports each stage: the plain request and what came
 * back, whether that was a challenge, what the resolver found on the page, what
 * a real browser adds, and what every candidate URL actually answers.
 *
 * Used by `npm run doctor -- <url>` and by GET /api/diagnose-link.
 */

const UA = 'Squeeze/1.0 (diagnostics)';

const MB = (bytes) => `${(Number(bytes) / 1048576).toFixed(1)} MB`;

/** A signed link is a credential for ~30 minutes: show the shape, not the token. */
function redact(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const last = parts.pop() || '';
    const shortened = last.length > 18 ? `${last.slice(0, 6)}…${last.slice(-4)}` : last;
    return `${parsed.protocol}//${parsed.host}/${parts.join('/')}${parts.length ? '/' : ''}${shortened}`;
  } catch {
    return String(url);
  }
}

async function timed(fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - started, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: `${err.code || 'ERR'}: ${err.message}` };
  }
}

/**
 * @param {string} url  the link the user pasted
 * @returns {Promise<object>} every stage, with a text rendering attached
 */
async function diagnose(url, { browser } = {}) {
  const steps = {};
  const version = require('./version').describe();
  steps.version = version;

  /* 1. Is the browser helper actually usable here? "I installed it" and "the
        server can launch it" are different claims. */
  const pw = (() => {
    try {
      return require('playwright'); // eslint-disable-line global-require, import/no-unresolved
    } catch {
      return null;
    }
  })();
  if (!pw) {
    steps.browser = { available: false, why: 'playwright is not installed (npm run browser:install)' };
  } else {
    let launch = null;
    try {
      const chromium = require('playwright').chromium; // eslint-disable-line global-require
      const exec = chromium.executablePath();
      const fs = require('node:fs');
      launch = { executablePath: exec, exists: fs.existsSync(exec) };
      if (!launch.exists) launch.why = 'the browser binary is missing (npx playwright install chromium)';
    } catch (err) {
      launch = { why: err.message };
    }
    steps.browser = { available: Boolean(pw.chromium), ...launch };
  }

  /* 2. The plain request, with the headers the resolver really sends. */
  const page = await timed(async () => {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();
    const { pageTitleOf, isChallenge } = require('../shared/resolve');
    return {
      status: res.status,
      finalUrl: redact(res.url),
      contentType: res.headers.get('content-type'),
      server: res.headers.get('server'),
      cfMitigated: res.headers.get('cf-mitigated'),
      cfRay: res.headers.get('cf-ray'),
      bytes: html.length,
      title: pageTitleOf(html),
      challenge: isChallenge(res, html),
      looksLikeHtml: /<html|<!doctype/i.test(html),
    };
  });
  steps.plainRequest = page;

  /* 3. What the resolver makes of it, including a browser if it needs one. */
  const resolved = await timed(async () => {
    const { resolve } = require('../shared/resolve');
    const result = await resolve(url);
    return {
      resolver: result.resolver,
      title: result.title || null,
      pageTitle: result.pageTitle || null,
      files: (result.files || []).map((file) => ({
        name: file.name,
        size: file.size,
        refUrl: redact(file.ref && file.ref.url),
        hasCookie: Boolean(file.ref && file.ref.cookie),
        cookieNames: String((file.ref && file.ref.cookie) || '')
          .split(';')
          .map((part) => part.split('=')[0].trim())
          .filter(Boolean),
      })),
    };
  });
  steps.resolve = resolved;

  /* 4. The candidate URLs the downloader would try, and what each answers. */
  if (resolved.ok && resolved.value.files.length) {
    const { directCandidates } = require('../shared/resolve');
    const { resolve } = require('../shared/resolve');
    const first = await resolve(url).catch(() => null);
    const ref = first && first.files && first.files[0] && first.files[0].ref;
    steps.candidates = ref
      ? await timed(async () => {
          const list = await directCandidates(ref);
          const out = [];
          for (const candidate of list.slice(0, 6)) {
            const probe = await timed(async () => {
              const res = await fetch(candidate, {
                headers: {
                  'user-agent': UA,
                  /* A range of one byte: enough to see the answer without
                     pulling a 1.7 GB file through a diagnostic. */
                  range: 'bytes=0-0',
                  accept: '*/*',
                  ...(ref.referer ? { referer: ref.referer } : {}),
                  ...(ref.cookie ? { cookie: ref.cookie } : {}),
                },
                redirect: 'follow',
              });
              res.body?.cancel().catch(() => {});
              return {
                status: res.status,
                contentType: res.headers.get('content-type'),
                contentRange: res.headers.get('content-range'),
                length: res.headers.get('content-length'),
                server: res.headers.get('server'),
                cfMitigated: res.headers.get('cf-mitigated'),
              };
            });
            out.push({ url: redact(candidate), ...probe });
          }
          return out;
        })
      : { ok: false, error: 'no reference' };
  }

  /* 5. What a real browser sees, when one is available. */
  if (steps.browser.available && browser !== 'skip') {
    const captured = await timed(async () => {
      const helper = require('./browser');
      if (!helper.available()) throw new Error('the browser helper reports unavailable');
      const dom = await helper.capturePage(url, { waitFor: 'a[href], video, source', timeoutMs: 45000 });
      const media = await helper.captureMedia(url, { timeoutMs: 45000 });
      return {
        title: dom.title,
        challenged: dom.challenged,
        htmlBytes: (dom.html || '').length,
        cookies: String(dom.cookie || '')
          .split(';')
          .map((part) => part.split('=')[0].trim())
          .filter(Boolean),
        anchors: (dom.html || '').match(/<a\b[^>]*href=/gi)?.length || 0,
        media: (media.media || []).slice(0, 6).map((item) => ({
          url: redact(item.url),
          contentType: item.contentType,
          size: item.size,
          hasCookie: Boolean(item.cookie),
        })),
      };
    });
    steps.browserResult = captured;
  }

  return { url: redact(url), ...steps, text: render({ url, steps }) };
}

/** The same thing for a human to read in a terminal. */
function render({ url, steps }) {
  const lines = [];
  const yes = (value) => (value ? 'yes' : 'no');
  lines.push(`Squeeze diagnostics — ${url}`);
  lines.push(
    `build     ${steps.version.version || '?'}${steps.version.commit ? ` · ${steps.version.commit}` : ' · no commit (not a git checkout?)'}`,
  );
  lines.push(`node      ${steps.version.node} · resumable encode ${yes(steps.version.features.resumableEncode)}`);
  lines.push(`browser   ${yes(steps.browser.available)}${steps.browser.executablePath ? ` · ${steps.browser.executablePath}` : ''}`);
  if (steps.browser.why) lines.push(`          ${steps.browser.why}`);
  if (steps.browser.exists === false) lines.push('          the browser binary is missing: npx playwright install chromium');

  const plain = steps.plainRequest;
  if (plain) {
    if (!plain.ok) {
      lines.push(`request   FAILED (${plain.ms} ms) — ${plain.error}`);
    } else {
      const v = plain.value;
      lines.push(`request   HTTP ${v.status} · ${v.contentType || 'no type'} · ${v.bytes} bytes · ${plain.ms} ms`);
      lines.push(`          server: ${v.server || '—'} · cf-mitigated: ${v.cfMitigated || '—'} · cf-ray: ${v.cfRay || '—'}`);
      lines.push(`          title: ${v.title || '—'} · challenge: ${yes(v.challenge)}`);
    }
  }

  const resolved = steps.resolve;
  if (resolved) {
    if (!resolved.ok) lines.push(`resolve   FAILED — ${resolved.error}`);
    else {
      const v = resolved.value;
      lines.push(`resolve   ${v.resolver} · ${v.files.length} file(s) · page title: ${v.pageTitle || '—'}`);
      for (const file of v.files.slice(0, 4)) {
        lines.push(`          ${file.name}${file.size ? ` · ${MB(file.size)}` : ''} → ${file.refUrl}`);
        lines.push(`            cookie: ${file.hasCookie ? file.cookieNames.join(', ') || 'yes' : 'none'}`);
      }
    }
  }

  if (steps.candidates) {
    if (!steps.candidates.ok) lines.push(`candidates FAILED — ${steps.candidates.error}`);
    else {
      lines.push('candidates');
      for (const item of steps.candidates.value) {
        if (!item.ok) {
          lines.push(`          ${item.url} → ${item.error}`);
          continue;
        }
        const v = item.value;
        lines.push(
          `          HTTP ${v.status} · ${v.contentType || 'no type'} · ${v.server || '—'} → ${item.url}`,
        );
      }
    }
  }

  if (steps.browserResult) {
    const b = steps.browserResult;
    if (!b.ok) lines.push(`browser   FAILED — ${b.error}`);
    else {
      const v = b.value;
      lines.push(`browser   “${v.title}” · challenged: ${yes(v.challenged)} · ${v.htmlBytes} bytes · ${v.anchors} anchors`);
      lines.push(`          cookies: ${v.cookies.join(', ') || 'none'}`);
      for (const item of v.media) {
        lines.push(`          media ${item.contentType || '?'} ${item.size ? MB(item.size) : ''} ${item.hasCookie ? '(cookie)' : ''} ${item.url}`);
      }
    }
  }

  lines.push('');
  lines.push('What the lines mean:');
  lines.push('  challenge: yes + browser: no   → Cloudflare needs the browser helper on this machine');
  lines.push('  challenge: yes + browser: yes  → the browser is installed but could not pass it (check the browser block)');
  lines.push('  candidates 403                → the link was minted but the CDN refused it: cookie or referer, not the page');
  lines.push('  resolve FAILED                → the page itself was not readable: send this whole block');
  return lines.join('\n');
}

module.exports = { diagnose, render, redact };
