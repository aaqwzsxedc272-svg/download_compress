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

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Squeeze/1.0 (diagnostics)';

const MB = (bytes) => (Number(bytes) > 0 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : 'size unknown');

/** "48 s" reads better than "0 min" for a short clip. */
const durationText = (seconds) => {
  const value = Number(seconds) || 0;
  if (value < 60) return `${Math.round(value)} s`;
  const minutes = Math.round(value / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
};

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

  /* Has this process survived something? A caught crash that nobody sees is a
     crash waiting to be reported again as "it stopped by itself". */
  steps.survived = (() => {
    try {
      const file = path.join(require('./jobs').DATA_DIR, 'crash.log');
      if (!fs.existsSync(file)) return { count: 0, last: null };
      const entries = fs.readFileSync(file, 'utf8').trim().split(/\n\n+/).filter(Boolean);
      const last = entries[entries.length - 1] || '';
      return { count: entries.length, last: last.split('\n').slice(0, 2).join(' · ').slice(0, 240) };
    } catch {
      return { count: 0, last: null };
    }
  })();

  /* The app registers its browser hooks at startup; a diagnostic that skipped
     this ran the resolver with no browser at all and reported a working link as
     broken. Same wiring, same answer. */
  const hooks = require('./browserhooks').install();
  steps.hooks = hooks;

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
    /* What matters is not whether the module is importable but whether the
       resolver has a browser behind it. Those differ when the hook was never
       installed — the bug that made an earlier doctor report lie. */
    steps.browser = {
      available: hooks.available,
      wired: hooks.available,
      /* playwright is not importable at all. "Not wired" and "not installed"
         are different faults: only the first one is a bug in this repo, and
         calling a missing browser a bug is the same kind of lie as the report
         that used to resolve links with no browser behind it. */
      module: false,
      why: hooks.available ? 'wired through the browser helper' : hooks.why || 'playwright is not installed (npm run browser:install)',
    };
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
    steps.browser = { available: Boolean(pw.chromium) && hooks.available, wired: hooks.available, module: true, ...launch };
  }

  /* 2. The plain request, with the headers the resolver really sends. */
  const page = await timed(async () => {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
      files: (result.files || []).map((file) => {
        /* Decided on the *unredacted* URL: a minted link is a long opaque
           token, a player page is name.mp4 with a short path. */
        const raw = (file.ref && file.ref.url) || '';
        let pathname = '';
        try {
          pathname = new URL(raw).pathname;
        } catch {
          /* not a URL */
        }
        const signed = /\/[A-Za-z0-9_-]{24,}$/.test(pathname);
        const playerish = !signed && /\.(mp4|m4v|webm|mov)$/i.test(pathname);
        return {
        name: file.name,
        size: file.size,
        signed,
        playerish,
        refUrl: redact(file.ref && file.ref.url),
        hasCookie: Boolean(file.ref && file.ref.cookie),
        cookieNames: String((file.ref && file.ref.cookie) || '')
          .split(';')
          .map((part) => part.split('=')[0].trim())
          .filter(Boolean),
        userAgent: (file.ref && file.ref.userAgent) || null,
        viaBrowser: Boolean(file.ref && file.ref.viaBrowser),
        /* A stream has no size until it is read: say which one was chosen and
           how long it is, because that is what decides whether the disk is
           big enough. */
        stream: file.ref && file.ref.resolver === 'stream',
        };
      }),
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
                  /* The same identity the real download would present. */
                  'user-agent': ref.userAgent || UA,
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

  /* 4b. A stream: which quality was chosen, how long it is, how big. This is
     the step that answers "it only found an ad" — it names the playlist that
     was picked and what is in it. */
  if (steps.resolve && steps.resolve.ok && steps.resolve.value.files.some((file) => file.stream)) {
    const { inspectPlaylist, resolve: resolveAgain } = require('../shared/resolve');
    const resolved = await resolveAgain(url).catch(() => null);
    const ref = resolved?.files?.[0]?.ref;
    steps.stream = await timed(async () => {
      const info = await inspectPlaylist(ref.url, {
        headers: {
          ...(ref.referer ? { referer: ref.referer } : {}),
          ...(ref.cookie ? { cookie: ref.cookie } : {}),
          ...(ref.userAgent ? { 'user-agent': ref.userAgent } : {}),
        },
      });
      return {
        quality: info.height ? `${info.height}p` : 'unknown',
        durationSeconds: Math.round(info.duration),
        estimatedBytes: info.estimatedBytes,
        segments: info.segments,
        chosen: redact(info.url),
        variants: (info.variants || []).map((variant) => ({
          quality: variant.height ? `${variant.height}p` : variant.name || 'unknown',
          bandwidth: variant.bandwidth,
        })),
        /* What the CDN accepted, in the same words the download will send.
           "resolve worked, the job failed" is almost always a cookie or a
           referer that was in one request and not the other. */
        accepted: (() => {
          const headers = ref && ref.streamHeaders;
          if (!headers || typeof headers !== 'object') return null;
          const cookie = String(headers.cookie || '');
          return {
            referer: headers.referer || null,
            origin: headers.origin || null,
            cookie: cookie ? cookie.split(';').map((part) => part.split('=')[0].trim()).filter(Boolean) : [],
          };
        })(),
        /* The playlists the page offered and how long each one runs — the
           difference between the film and the sample beside it. */
        candidates: (resolved.streamCandidates || []).map((entry) => ({
          durationSeconds: Math.round(entry.duration || 0),
          quality: entry.height ? `${entry.height}p` : 'unknown',
          preview: Boolean(entry.preview),
          chosen: ref && entry.url === ref.url,
          url: redact(entry.url),
        })),
      };
    });
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

  steps.verdict = verdictFor(steps);
  return { url: redact(url), ...steps, text: render({ url, steps }) };
}

/**
 * One sentence: what is wrong, and what to do about it.
 *
 * The stage-by-stage dump is for me; this line is for whoever is looking at the
 * link that does not work.
 */
function verdictFor(steps) {
  const browser = Boolean(steps.browser && steps.browser.available);
  const plain = steps.plainRequest && steps.plainRequest.ok ? steps.plainRequest.value : null;
  const resolve = steps.resolve;
  const files = resolve && resolve.ok ? resolve.value.files : [];
  const offered = files[0] && files[0].refUrl;

  if (!browser && plain && plain.challenge) {
    return 'This host is checking for a browser and this machine has none — run `npm run browser:install`.';
  }
  if (!resolve || !resolve.ok) {
    return `The page itself could not be read (${(resolve && resolve.error) || 'unknown error'}) — that needs fixing before anything else.`;
  }
  /* A minted link is a long opaque token; the player page is a name.mp4 with a
     short path. Telling them apart is the whole point of this report. */
  const looksPlayer = Boolean(files[0] && files[0].playerish);
  if (looksPlayer) {
    return browser
      ? 'The download button was not found even in a browser — the page may have changed. Send this whole block.'
      : 'The download button only appears in a real browser, and this machine has none — run `npm run browser:install`.';
  }
  if (steps.stream) {
    if (!steps.stream.ok) return `The stream was found but could not be read: ${steps.stream.error}. Send this block.`;
    const chosen = steps.stream.value;
    if (chosen.durationSeconds > 0 && chosen.durationSeconds < 90) {
      const others = (chosen.candidates || []).filter((entry) => !entry.chosen);
      return (
        `The stream this page offers is only ${durationText(chosen.durationSeconds)} long — that is a preview or ` +
        'a spot, not the film.' +
        (others.length
          ? ` The other playlists on the page were ${others.map((entry) => durationText(entry.durationSeconds)).join(', ')}.`
          : ' The page did not offer anything longer.') +
        ' Send this block.'
      );
    }
    return (
      `This page streams its video: the best quality on offer is ${chosen.quality}, ` +
      `${durationText(chosen.durationSeconds)}, ${MB(chosen.estimatedBytes)} — ` +
      'the app downloads exactly that and then compresses it.'
    );
  }
  const probes = steps.candidates && steps.candidates.ok ? steps.candidates.value : [];
  const refused = probes.filter((item) => item.ok && [403, 503, 401].includes(item.value.status));
  if (refused.length) {
    return 'The link was minted but the file host refused it — that is the clearance cookie or its user agent, not the page. Send this block.';
  }
  const served = probes.filter((item) => item.ok && item.value.status >= 200 && item.value.status < 300);
  if (served.length && !/text\/html/.test(String(served[0].value.contentType || ''))) {
    return 'This link resolves to a real file that answers correctly — it should download.';
  }
  if (!browser) {
    return 'Nothing here is obviously broken, but without a browser this report cannot judge hosts that need one — send this whole block.';
  }
  return 'Nothing here is obviously broken — send this whole block and it can be read in detail.';
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
  if (steps.survived && steps.survived.count > 0) {
    lines.push(
      `survived  ${steps.survived.count} error(s) that would have stopped the server — last: ${steps.survived.last}`,
    );
  }
  const browser = steps.browser;
  const wiredBug = browser.wired === false && browser.module === true;
  lines.push(
    `browser   ${yes(browser.available)}${browser.executablePath ? ` · ${browser.executablePath}` : ''}` +
      `${wiredBug ? ' · NOT WIRED INTO THE RESOLVER (bug)' : ''}` +
      `${!browser.available && !wiredBug ? ' · this report is running without one' : ''}`,
  );
  if (!browser.available && !wiredBug) {
    lines.push('          a host that needs a browser will look broken here and may still work in the app');
  }
  if (browser.why) lines.push(`          ${browser.why}`);
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
        lines.push(
          `            cookie: ${file.hasCookie ? file.cookieNames.join(', ') || 'yes' : 'none'}` +
            ` · via browser: ${file.viaBrowser ? 'yes' : 'no'}`,
        );
      }
      /* The single most useful line for a fileditch-style page: is the offered
         URL a *minted* link or the player page (which serves HTML)? */
      const offered = v.files[0] && v.files[0].refUrl;
      if (offered) {
        const looksStream = Boolean(v.files[0] && v.files[0].stream);
        const looksPlayer = /\.(mp4|m4v|webm|mov)(\b|$)/i.test(offered) && !/\/[A-Za-z0-9_-]{40,}$/.test(offered);
        lines.push(
          looksStream
            ? '          ✓ that is an HLS playlist — the video itself, served as segments'
            : looksPlayer
              ? '          ⚠ that is the player page, not a minted link: the download button was not found'
              : '          ✓ looks like a minted (signed) link, not the player page',
        );
      }
    }
  }

  if (steps.stream) {
    if (!steps.stream.ok) lines.push(`stream    FAILED — ${steps.stream.error}`);
    else {
      const v = steps.stream.value;
      lines.push(
        `stream    ${v.quality} · ${durationText(v.durationSeconds)} · ${MB(v.estimatedBytes)} · ` +
          `${v.segments} segments`,
      );
      lines.push(`          playing ${v.chosen}`);
      if (v.variants.length > 1) {
        lines.push(`          qualities offered: ${v.variants.map((variant) => variant.quality).join(', ')}`);
      }
      if (v.accepted) {
        lines.push(
          `          accepted: referer ${v.accepted.referer || '(none)'}` +
            `${v.accepted.origin ? ` · origin ${v.accepted.origin}` : ''}` +
            ` · cookie ${v.accepted.cookie.length ? v.accepted.cookie.join(', ') : 'none'}`,
        );
      }
      if (v.candidates && v.candidates.length > 1) {
        /* Which of the page's playlists won, and what it beat. A sample beside
           the feature is obvious here and invisible on the card. */
        lines.push('          playlists on the page:');
        for (const entry of v.candidates) {
          lines.push(
            `            ${entry.chosen ? '→' : ' '} ${durationText(entry.durationSeconds)} · ${entry.quality}` +
              `${entry.preview ? ' · a preview by name' : ''} · ${entry.url}`,
          );
        }
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
  if (steps.verdict) lines.push(`VERDICT   ${steps.verdict}`);
  if (steps.candidates && steps.candidates.ok) {
    const broken = steps.candidates.value.filter(
      (item) => !item.ok || (![200, 206].includes(item.value.status) && ![301, 302, 307, 308].includes(item.value.status)),
    );
    if (broken.length) {
      lines.push('');
      lines.push('What a non-200 on a candidate means:');
      lines.push('  403 / 503 → the CDN refused the minted link: the clearance cookie or its user agent, not the page');
      lines.push('  404       → the signed link expired between minting and the request (they last ~30 minutes)');
      lines.push('  text/html → that URL is a player page, not the file');
    }
  }
  return lines.join('\n');
}

module.exports = { diagnose, render, redact };
