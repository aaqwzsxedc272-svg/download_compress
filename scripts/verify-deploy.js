'use strict';

/**
 * Prove a deployment actually works, from the outside.
 *
 * Runs against a deployed URL and checks the whole promise of the app:
 * the container is up, it has real internet, it can resolve a share link, it can
 * encode, and it hands back a live share link that a third party can download.
 *
 *   node scripts/verify-deploy.js https://user-squeeze.hf.space
 *   node scripts/verify-deploy.js --preset high https://my-host:3000
 */

const BASE = (() => {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const url = positional[0] || process.env.BASE_URL;
  if (!url) {
    console.error('usage: node scripts/verify-deploy.js <url> [--preset tiny|high|...] [--keep]');
    process.exit(64);
  }
  return url.replace(/\/$/, '');
})();

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PRESET = argValue('--preset', 'tiny');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const rows = [];

/**
 * Advisory checks describe the environment, not the deployment: a container with
 * no internet still compresses uploads correctly, so it must not fail the run.
 */
function record(name, ok, detail = '', { advisory = false } = {}) {
  rows.push({ name, ok, detail, advisory });
  if (!ok && !advisory) failures += 1;
  const tag = ok ? '[ ok ]' : advisory ? '[warn]' : '[FAIL]';
  console.log(`${tag} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function json(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { res, body, text };
}

async function waitForJob(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  process.stdout.write('       waiting');
  while (Date.now() < deadline) {
    const { body } = await json(`${BASE}/api/jobs/${id}`);
    last = body && body.job;
    if (!last) return null;
    if (['hosted', 'done', 'error'].includes(last.status)) {
      process.stdout.write('\n');
      return last;
    }
    process.stdout.write('.');
    await sleep(3000);
  }
  process.stdout.write('\n');
  return last;
}

(async () => {
  console.log(`Verifying ${BASE}\n`);

  // 1. Is it up, and what is it running?
  let health = null;
  try {
    const { res, body } = await json(`${BASE}/api/health`, { signal: AbortSignal.timeout(20000) });
    health = body;
    record('app is reachable', res.ok && body?.ok === true, `HTTP ${res.status}`);
    if (health) {
      record(
        'encoder reports presets',
        Array.isArray(health.presets) && health.presets.length >= 4,
        health.presets?.map((p) => p.id).join(', ') || 'none',
      );
      record(
        'output hosts configured',
        Array.isArray(health.hosters) && health.hosters.length > 0,
        (health.hosters || []).map((h) => h.id).join(' → ') || 'none',
      );
      record(
        'yt-dlp available for platform links',
        Boolean(health.platformDownloads),
        health.ytdlpVersion || 'not installed (YouTube/TikTok links will not resolve)',
        { advisory: true },
      );
    }
  } catch (err) {
    record('app is reachable', false, err.message);
    console.log('\nNothing else can be checked while the app is unreachable.');
    console.log('If this is a fresh Space, wait for the build to finish, then re-run.');
    process.exit(1);
  }

  // 2. Does the container itself have internet? This is what decides whether
  //    gofile / turbo / bunkr links can be resolved server-side.
  try {
    const { body } = await json(`${BASE}/api/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/' }),
      signal: AbortSignal.timeout(25000),
    });
    record(
      'container has outbound internet',
      Boolean(body?.serverCanFetch),
      body?.serverCanFetch
        ? 'reachable'
        : `blocked (${body?.reason || 'unknown'}) — browser upload still works`,
      { advisory: true },
    );
  } catch (err) {
    record('container has outbound internet', false, err.message, { advisory: true });
  }

  // 3. Can it actually resolve a consumer file host? A missing link is a
  //    plausible answer here, so only "the request blew up" counts as a failure.
  try {
    const { res, body } = await json(`${BASE}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://pixeldrain.com/u/definitelynotafile' }),
      signal: AbortSignal.timeout(30000),
    });
    // A missing file is a fine answer; a blocked request is not.
    const unreachableCodes = ['UNREACHABLE', 'BLOCKED', 'NETWORK', 'TIMEOUT', 'NEED_BROWSER'];
    const code = String(body?.code || '');
    const reachedHost = res.status !== 409 && !unreachableCodes.includes(code);
    record(
      'can talk to a consumer file host',
      reachedHost,
      reachedHost ? `host answered (${code || 'no such file'})` : `blocked (${code || `HTTP ${res.status}`})`,
      { advisory: true },
    );
  } catch (err) {
    record('can talk to a consumer file host', false, err.message, { advisory: true });
  }

  // 4. The whole pipeline: encode a clip, upload it, get a link.
  let job = null;
  try {
    const { res, body } = await json(`${BASE}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'sample', presetId: PRESET }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok || !body?.job?.id) throw new Error(body?.error || `HTTP ${res.status}`);
    job = await waitForJob(body.job.id, 15 * 60 * 1000);
    record('a video can be compressed', job?.status === 'done' || job?.status === 'hosted', job?.error || '');
  } catch (err) {
    record('a video can be compressed', false, err.message);
  }

  if (job && job.outputBytes) {
    const ratio = job.sourceBytes ? 1 - job.outputBytes / job.sourceBytes : 0;
    record(
      'compression produced a smaller file',
      job.outputBytes > 0 && job.outputBytes < job.sourceBytes,
      `${(job.sourceBytes / 1048576).toFixed(1)} MB → ${(job.outputBytes / 1048576).toFixed(2)} MB (−${Math.round(ratio * 100)}%)`,
    );
  }

  // 5. The point of the app: a share link that works for anyone.
  if (job) {
    const hosted = job.hostedUrl;
    record('a share link was created', Boolean(hosted), hosted || job.hostError || 'none');

    if (hosted) {
      try {
        const res = await fetch(hosted, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30000) });
        const type = res.headers.get('content-type') || '';
        const length = Number(res.headers.get('content-length') || 0);
        record(
          'the share link is publicly reachable',
          res.ok,
          `HTTP ${res.status}${type ? ` · ${type.split(';')[0]}` : ''}${length ? ` · ${(length / 1048576).toFixed(1)} MB` : ''}`,
        );
      } catch (err) {
        record('the share link is publicly reachable', false, err.message);
      }
    }
  }

  if (!KEEP && job?.id) {
    await fetch(`${BASE}/api/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
  }

  const passed = rows.filter((r) => r.ok).length;
  const warnings = rows.filter((r) => !r.ok && r.advisory);
  console.log(`\n${passed}/${rows.length} checks passed${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);

  if (failures) {
    console.log('\nSomething is wrong with the deployment:');
    for (const row of rows.filter((r) => !r.ok && !r.advisory)) console.log(`  - ${row.name}: ${row.detail}`);
    process.exit(1);
  }

  if (warnings.length) {
    console.log('\nWarnings (the environment, not the code):');
    for (const row of warnings) console.log(`  - ${row.name}: ${row.detail}`);
    if (warnings.some((r) => /outbound internet/.test(r.name))) {
      console.log('\nThis container has no internet, so links must be fetched by your browser.');
      console.log('For server-side fetching and hosting, deploy where outbound access is allowed');
      console.log('(Hugging Face Spaces does, free and without a card — see DEPLOY.md).');
    }
  }

  if (!failures && !warnings.length) {
    console.log('\nThis deployment does the whole job: link in, compressed file out on a share host.');
  }
})().catch((err) => {
  console.error(`\nVerification crashed: ${err.message}`);
  process.exit(1);
});
