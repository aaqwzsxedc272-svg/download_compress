'use strict';

/**
 * Browser-side smoke test, in jsdom.
 *
 * The frontend is plain DOM code, so it can run headless: load the real
 * index.html, stub fetch, execute app.js, then click the things a person
 * clicks. That catches the failures unit tests miss — a missing element id, a
 * handler wired to nothing, a label that never changes.
 *
 *   node scripts/ui.test.js          (needs jsdom: npm i --no-save jsdom)
 */

const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('jsdom is not installed — skipping the browser smoke test.');
  console.log('  npm install --no-save jsdom');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(` FAIL  ${name}\n         ${err.message}`);
  }
}

const HEALTH = {
  ok: true,
  disk: { totalBytes: 31.3 * 1024 ** 3, freeBytes: 9.6 * 1024 ** 3 },
  autoStop: { supported: true, enabled: false, stopsAt: null },
  maxUploadMb: 6144,
  presets: [
    { id: 'auto', label: 'Recommended', hint: 'best quality it can afford' },
    { id: 'high', label: 'High quality', hint: 'full resolution' },
  ],
  defaultPreset: 'auto',
  hosters: [{ id: 'pixeldrain', label: 'pixeldrain' }],
  platformDownloads: false,
  email: { configured: true, to: 'aaqwzsxedc272@gmail.com' },
  version: {
    commit: 'c911021',
    version: '1.0.0',
    startedAt: '2026-11-04T03:00:00.000Z',
    features: { resumableEncode: true, cloudflareBrowser: true },
    browser: { available: true },
    /* This checkout is one commit behind the published branch — the state that
       cost a day of "it still does not work". */
    update: { branch: 'arena/e992889e-download-compress', head: 'c911021', latest: '2e11725', behind: true },
  },
};

const LINKS = {
  links: [
    {
      url: 'https://pixeldrain.com/u/TestLink1',
      name: 'Kate Dalia - Lazy Day Off.mp4',
      sourceBytes: 508 * 1024 ** 2,
      outputBytes: 341 * 1024 ** 2,
      at: new Date().toISOString(),
    },
  ],
};

const STORAGE = {
  disk: { totalBytes: 32 * 1024 ** 3, freeBytes: 12 * 1024 ** 3, usedBytes: 20 * 1024 ** 3, percentFree: 38 },
  totals: {
    dataBytes: 6 * 1024 ** 3,
    jobsBytes: 5.5 * 1024 ** 3,
    otherDataBytes: 0.5 * 1024 ** 3,
    projectBytes: 0.4 * 1024 ** 3,
    homeBytes: 0.2 * 1024 ** 3,
    extrasBytes: 0.6 * 1024 ** 3,
    squeezeBytes: 6 * 1024 ** 3,
    restOfMachineBytes: 13.4 * 1024 ** 3,
  },
  breakdown: [
    { label: 'Videos (jobs)', bytes: 5.5 * 1024 ** 3, kind: 'jobs' },
    { label: 'Temp uploads', bytes: 0.4 * 1024 ** 3, kind: 'tmp', deletable: true },
    { label: 'Records (links, meter)', bytes: 4096, kind: 'records' },
  ],
  jobs: [
    {
      id: 'jobBig',
      name: 'Holiday film.mp4',
      status: 'hosted',
      stage: 'Ready',
      createdAt: Date.now(),
      hostedUrl: 'https://pixeldrain.com/u/abc',
      hostProvider: 'pixeldrain',
      pinLocal: true,
      active: false,
      bytes: 4 * 1024 ** 3,
      autoDeletesInSeconds: 3600,
      files: [
        {
          part: 'source',
          label: 'Original download',
          bytes: 3 * 1024 ** 3,
          download: '/api/jobs/jobBig/original/Holiday%20film.mp4',
          note: 'kept so a resume does not download it again',
        },
        {
          part: 'output',
          label: 'Compressed result',
          bytes: 1 * 1024 ** 3,
          download: '/api/jobs/jobBig/download/Holiday%20film.mp4',
          note: 'also uploaded — this copy is a spare',
        },
      ],
    },
    {
      id: 'jobLive',
      name: 'Long one.mp4',
      status: 'compressing',
      stage: 'Encoding',
      createdAt: Date.now(),
      hostedUrl: null,
      pinLocal: false,
      active: true,
      bytes: 512 * 1024 ** 2,
      autoDeletesInSeconds: null,
      files: [
        {
          part: 'source',
          label: 'Original download',
          bytes: 512 * 1024 ** 2,
          download: '/api/jobs/jobLive/original/Long%20one.mp4',
          note: 'this file is in use',
        },
      ],
    },
  ],
  extras: [{ label: 'Project (node_modules, ffmpeg)', bytes: 0.4 * 1024 ** 3, kind: 'project' }],
  reclaimable: { finished: 4 * 1024 ** 3, hosted: 4 * 1024 ** 3, tmp: 0.4 * 1024 ** 3, sample: 0 },
  limits: { hostedLocalMinutes: 120, finishedMinutes: 180, unfinishedHours: 24 },
  at: Date.now(),
};

const USAGE = {
  meter: {
    source: 'local',
    file: 'data/usage.json',
    countsOnlyWhileRunning: true,
    note:
      'Measured by this app while it is running: time × cores, and the size of data/ sampled every minute. ' +
      'GitHub does not publish remaining Codespaces hours to the machine, so this is a meter, not a reading.',
  },
  settings: {
    plan: 'free',
    planLabel: 'GitHub Free',
    quotaCoreHours: 120,
    quotaStorageGb: 15,
    idleMinutes: 30,
    cores: 2,
    plans: [
      { id: 'free', label: 'GitHub Free', coreHours: 120, storageGb: 15 },
      { id: 'pro', label: 'GitHub Pro', coreHours: 180, storageGb: 20 },
      { id: 'custom', label: 'Set by hand', coreHours: 120, storageGb: 15 },
    ],
  },
  session: {
    startedAt: Date.now() - 3600000,
    elapsedSeconds: 3600,
    coreHours: 2,
    cores: 2,
    idleMinutes: 30,
    idleStopsAt: Date.now() + 1800000,
    idleSecondsLeft: 1800,
    awake: true,
  },
  month: {
    key: '2026-11',
    resetAt: Date.UTC(2026, 11, 1),
    resetsInHours: 600,
    hoursInMonth: 720,
    coreHours: 48,
    quotaCoreHours: 120,
    remainingCoreHours: 72,
    machineHoursLeft: 36,
    percent: 40,
    projectedCoreHours: 100,
    sessions: 3,
  },
  storage: {
    bytesNow: 6 * 1024 ** 3,
    peakBytes: 8 * 1024 ** 3,
    gbMonths: 3.2,
    quotaGb: 15,
    remainingGb: 11.8,
    percent: 21.3,
    projectedGbMonths: 6.4,
  },
  history: [],
  at: Date.now(),
};

/** A DOM with app.js already running and fetch answering the read-only calls. */
async function boot({
  links = LINKS,
  email = { ok: true, sent: true, count: 1, to: 'aaqwzsxedc272@gmail.com' },
  resolved = null,
  mailSettings = { configured: false, to: 'aaqwzsxedc272@gmail.com', port: 587, hasPassword: false, source: 'none' },
  publishInfo = {
    chain: [],
    disabled: true,
    sinks: [],
    last: null,
    settings: { hasWebhook: false, webhook: null, ntfy: null, paste: false, repo: false, saved: false },
  },
  publishResult = { ok: true, sink: 'gist', label: 'GitHub gist', url: 'https://gist.github.com/x/deadbeef', count: 1 },
  /* What the server answers to "just download it" — a view of the same job. */
  keepOriginal = { job: { id: 'job1', status: 'queued' } },
  /* What the server answers to "save the original": the file, and the job as it
     still stands (encoding). */
  saveOriginal = { ok: true, ready: false, gone: false, download: null, job: { id: 'job1', status: 'compressing' } },
  storage = STORAGE,
  usage = USAGE,
  cleanResult = { ok: true, freedBytes: 2 * 1024 ** 3, removedJobs: 1, kept: [] },
  deleteResult = { ok: true, freedBytes: 3 * 1024 ** 3, job: { id: 'jobBig' } },
  usageSettings = null,
} = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://squeeze.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  /* Server-side state the panel mutates, so a save is visible to the next read
     the way it is in the real app. */
  let liveSettings = { ...publishInfo.settings };

  window.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    let body = {};
    if (target.includes('/api/health')) body = HEALTH;
    else if (target.includes('/api/links/email')) body = email;
    else if (target.includes('/api/email/settings')) {
      body = init.method === 'POST'
        ? {
            settings: {
              ...mailSettings,
              configured: true,
              host: JSON.parse(init.body).host,
              to: JSON.parse(init.body).to,
              source: 'saved',
              hasPassword: true,
            },
          }
        : { settings: mailSettings };
    } else if (target.includes('/api/email/test')) body = { ok: true, to: 'aaqwzsxedc272@gmail.com' };
    else if (target.includes('/api/links/publish')) body = publishResult;
    else if (target.includes('/api/publish/test')) body = { ok: true, sink: 'webhook', label: 'Discord', url: null };
    else if (target.includes('/api/publish/settings') && init.method === 'POST') {
      const sent = JSON.parse(init.body);
      liveSettings = {
        ...liveSettings,
        hasWebhook: Boolean(sent.webhook) || liveSettings.hasWebhook,
        webhook: sent.webhook ? 'https://discord.com/…' : liveSettings.webhook,
        webhookKind: sent.webhook ? 'Discord' : liveSettings.webhookKind,
        ntfy: sent.ntfy || liveSettings.ntfy,
        saved: true,
      };
      body = { settings: liveSettings, publish: { ...publishInfo, settings: liveSettings } };
    }
    else if (target.includes('/api/publish')) body = { publish: { ...publishInfo, settings: liveSettings } };
    else if (target.includes('/api/links')) body = links;
    else if (target.includes('/api/resolve') && resolved) body = resolved;
    else if (target.includes('/api/storage/clean')) body = cleanResult;
    else if (target.includes('/api/storage/jobs/') && init.method === 'DELETE') body = deleteResult;
    else if (target.includes('/api/storage')) body = storage;
    else if (target.includes('/api/usage/settings')) {
      body = { ok: true, settings: usageSettings || usage.settings, usage };
    } else if (target.includes('/api/usage')) body = { usage };
    else if (target.includes('/save-original')) body = saveOriginal;
    else if (target.includes('/keep-original')) body = keepOriginal;
    else if (target.includes('/retry')) body = { ok: true, job: { ...keepOriginal.job, status: 'queued', canRetry: false } };
    else if (target.includes('/api/jobs') && init.method === 'POST') body = { job: { id: 'job1', status: 'queued' } };
    else if (target.includes('/api/jobs')) body = { jobs: [] };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  window.addEventListener('error', (event) => {
    calls.push({ error: String(event.error || event.message) });
  });

  /* app.js is evaluated as a strict-mode eval, so its top-level functions do not
     leak into the window. Handing the few the tests drive back out keeps those
     names out of production code. */
  const source = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  window.eval(`${source}\nwindow.__app = { trackJob, updateCard, renderRecovery, state };`);
  await new Promise((resolve) => window.setTimeout(resolve, 60));
  return { dom, window, doc: window.document, calls };
}

(async () => {
  console.log('composer');

  const { window, doc, calls } = await boot();

  await test('the header fills in from /api/health', async () => {
    const disk = doc.getElementById('diskText').textContent;
    if (!/GB/.test(disk)) throw new Error(`disk pill says "${disk}"`);
    if (!/encoder ready/.test(doc.getElementById('engineText').textContent)) {
      throw new Error('engine pill did not update');
    }
  });

  await test('the footer says when this checkout is behind the published branch', async () => {
    const build = doc.getElementById('buildInfo');
    if (!/build c911021/.test(build.textContent)) throw new Error(`build not named: "${build.textContent}"`);
    if (!/git pull/.test(build.textContent)) throw new Error(`no pull hint: "${build.textContent}"`);
    if (!build.classList.contains('is-stale')) throw new Error('the stale build looks like any other');
    if (!/here: c911021/.test(build.title) || !/2e11725/.test(build.title)) {
      throw new Error(`the tooltip does not carry both hashes: "${build.title}"`);
    }
  });

  await test('the quality presets are rendered as buttons', async () => {
    const count = doc.querySelectorAll('#quality button').length;
    if (count !== HEALTH.presets.length) throw new Error(`rendered ${count} presets`);
  });

  await test('"just download it" turns the encoder controls off', async () => {
    const toggle = doc.getElementById('noCompress');
    if (!toggle) throw new Error('no noCompress toggle in the composer');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    if (!doc.getElementById('targetMb').disabled) throw new Error('size target still editable');
    if (!doc.getElementById('targetMb').classList.contains('is-off')) throw new Error('size target not dimmed');
    const label = doc.querySelector('#goBtn span').textContent;
    if (label !== 'Download') throw new Error(`button says "${label}"`);
    if (doc.getElementById('composerNote').hidden) throw new Error('nothing explains the mode');
    if (window.localStorage.getItem('squeeze.nocompress') !== '1') throw new Error('choice not remembered');
    // and back
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change'));
    if (doc.getElementById('targetMb').disabled) throw new Error('size target stayed locked');
  });

  console.log('results panel');

  await test('every saved link is listed with its size change', async () => {
    const rows = doc.querySelectorAll('#resultsList .result-row');
    if (rows.length !== LINKS.links.length) throw new Error(`listed ${rows.length} links`);
    const text = doc.getElementById('resultsList').textContent;
    if (!/508 MB → 341 MB/.test(text)) throw new Error(`sizes missing: ${text.slice(0, 160)}`);
  });

  await test('"Email them to me" mails the links and says so', async () => {
    const button = doc.getElementById('emailLinks');
    if (!button) throw new Error('no email button');
    button.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    const post = calls.find((call) => call.url.includes('/api/links/email'));
    if (!post) throw new Error('the button never called the server');
    if (post.init.method !== 'POST') throw new Error(`used ${post.init.method}`);
    const alert = doc.getElementById('alert');
    if (alert.hidden) throw new Error('no confirmation shown');
    if (!/aaqwzsxedc272@gmail\.com/.test(alert.textContent)) {
      throw new Error(`confirmation does not name the address: "${alert.textContent}"`);
    }
  });

  await test('a server with no mail setup opens a mailto instead', async () => {
    const second = await boot({
      email: {
        ok: false,
        sent: false,
        needsConfig: true,
        mailto: 'mailto:aaqwzsxedc272@gmail.com?subject=Squeeze',
      },
      links: LINKS,
    });
    const button = second.doc.getElementById('emailLinks');
    button.dispatchEvent(new second.window.Event('click'));
    await new Promise((resolve) => second.window.setTimeout(resolve, 60));
    const note = second.doc.getElementById('emailNote');
    if (!note || note.hidden) throw new Error('the fallback is not explained on screen');
    if (!/Opened your mail app/.test(button.textContent)) {
      throw new Error(`button says "${button.textContent}" — the mailto was not followed`);
    }
  });

  await test('a page with several files gets a picker that shows every size', async () => {
    const third = await boot({
      links: { links: [] },
      resolved: {
        resolver: 'gofile',
        title: 'yl6viZms',
        files: [
          { id: 'a', name: 'Big Clip.mp4', size: 4_200_000_000, kind: 'video', ref: { resolver: 'direct', url: 'https://x/1.mp4' } },
          { id: 'b', name: 'Short.mp4', size: 2_600_000_000, kind: 'video', ref: { resolver: 'direct', url: 'https://x/2.mp4' } },
          { id: 'c', name: 'No Size.mp4', size: 0, kind: 'video', ref: { resolver: 'direct', url: 'https://x/3.mp4' } },
        ],
      },
    });
    third.doc.getElementById('urlInput').value = 'https://gofile.io/d/yl6viZms';
    third.doc.getElementById('goBtn').dispatchEvent(new third.window.Event('click'));
    for (let i = 0; i < 40 && !third.doc.getElementById('pickerPanel'); i += 1) {
      await new Promise((resolve) => third.window.setTimeout(resolve, 25));
    }
    const panel = third.doc.getElementById('pickerPanel');
    if (!panel) throw new Error('no picker appeared');

    const text = panel.textContent;
    if (!/3\.9 GB/.test(text)) throw new Error(`total size missing: ${text.slice(0, 200)}`);
    if (!/4\.2 GB|3\.9 GB/.test(text)) throw new Error('per-file sizes missing');
    if (!/size unknown/.test(text)) throw new Error('a file without a size is not called out');

    /* The picker's own switch flips the buttons to plain downloads. */
    const toggle = panel.querySelector('#pickerNoCompress');
    if (!toggle) throw new Error('no mode switch in the picker');
    toggle.checked = true;
    toggle.dispatchEvent(new third.window.Event('change'));
    const labels = [...panel.querySelectorAll('.picker-actions .btn.download')].map((b) => b.textContent);
    if (labels.some((label) => label !== 'Download')) throw new Error(`buttons say ${JSON.stringify(labels)}`);
    if (!/Just download/.test(panel.textContent)) throw new Error('the switch is not labelled');

    /* Starting one of them sends the flag to the server. */
    panel.querySelector('.picker-actions .btn.download').dispatchEvent(new third.window.Event('click'));
    await new Promise((resolve) => third.window.setTimeout(resolve, 80));
    const start = third.calls.find((call) => call.url.endsWith('/api/jobs') && call.init.method === 'POST');
    if (!start) throw new Error('nothing was queued');
    const sent = JSON.parse(start.init.body);
    if (sent.noCompress !== true) throw new Error(`noCompress not sent: ${start.init.body}`);
  });

  console.log('mail setup');

  await test('an unconfigured machine says so and points at its own mail app', async () => {
    const fourth = await boot({ links: LINKS });
    const note = fourth.doc.getElementById('emailNote');
    if (note.hidden) throw new Error('the fallback is not explained');
    if (!/not set up/.test(fourth.doc.getElementById('mailSummary').textContent)) {
      throw new Error(`summary says "${fourth.doc.getElementById('mailSummary').textContent}"`);
    }
    if (!/Set up/.test(fourth.doc.querySelector('.mail-chevron').textContent)) throw new Error('no call to action');
  });

  await test('the form saves once and proves itself with a test mail', async () => {
    const fifth = await boot({ links: LINKS });
    const doc = fifth.doc;
    if (!doc.querySelector('#mailForm')) throw new Error('no setup form');
    doc.getElementById('mailHost').value = 'smtp.gmail.com';
    doc.getElementById('mailPort').value = '587';
    doc.getElementById('mailUser').value = 'owner@gmail.com';
    doc.getElementById('mailPass').value = 'abcd efgh ijkl mnop';
    doc.getElementById('mailTo').value = 'aaqwzsxedc272@gmail.com';
    doc.getElementById('mailForm').dispatchEvent(new fifth.window.Event('submit'));
    await new Promise((resolve) => fifth.window.setTimeout(resolve, 120));

    const save = fifth.calls.find((call) => call.url.endsWith('/api/email/settings') && call.init.method === 'POST');
    if (!save) throw new Error('the form never posted the settings');
    const sent = JSON.parse(save.init.body);
    if (sent.host !== 'smtp.gmail.com' || sent.to !== 'aaqwzsxedc272@gmail.com') {
      throw new Error(`posted ${save.init.body}`);
    }
    const testMail = fifth.calls.find((call) => call.url.endsWith('/api/email/test'));
    if (!testMail) throw new Error('saving did not try a real mail');
    const status = doc.getElementById('mailStatus').textContent;
    if (!/Working — a test mail is on its way/.test(status)) throw new Error(`status says "${status}"`);
    if (!/Mail: links go to aaqwzsxedc272@gmail\.com/.test(doc.getElementById('mailSummary').textContent)) {
      throw new Error('the summary did not update');
    }
    if (!doc.getElementById('emailNote').hidden) throw new Error('the fallback note is still showing');
    if (doc.getElementById('mailPass').value !== '') throw new Error('the password is left in the field');
  });

  console.log('posting the links without email');

  await test('with no sink available the post button stays hidden', async () => {
    const sixth = await boot({ links: LINKS, publishInfo: { chain: [], disabled: true, sinks: [], last: null } });
    if (!sixth.doc.getElementById('publishLinks').hidden) throw new Error('offered a button that cannot work');
  });

  await test('a ready sink is offered and posting reports the URL', async () => {
    const seventh = await boot({
      links: LINKS,
      publishInfo: {
        chain: ['gist'],
        disabled: false,
        sinks: [{ id: 'gist', label: 'GitHub gist', ready: true, detail: 'gh is logged in', inChain: true }],
        last: null,
      },
      publishResult: { ok: true, sink: 'gist', label: 'GitHub gist', url: 'https://gist.github.com/aaq/deadbeef', count: 1 },
    });
    const doc = seventh.doc;
    const button = doc.getElementById('publishLinks');
    if (button.hidden) throw new Error('a working sink is not offered');
    if (!/GitHub gist/.test(doc.getElementById('publishNote').textContent)) {
      throw new Error(`note says "${doc.getElementById('publishNote').textContent}"`);
    }
    button.dispatchEvent(new seventh.window.Event('click'));
    await new Promise((resolve) => seventh.window.setTimeout(resolve, 80));
    const post = seventh.calls.find((call) => call.url.endsWith('/api/links/publish'));
    if (!post || post.init.method !== 'POST') throw new Error('nothing was posted');
    const alert = doc.getElementById('alert');
    if (!/gist\.github\.com/.test(alert.textContent)) throw new Error(`alert says "${alert.textContent}"`);
  });

  console.log('posting setup panel');

  await test('the panel saves a webhook and proves it with a test post', async () => {
    const eighth = await boot({ links: LINKS });
    const doc = eighth.doc;
    if (!doc.getElementById('postForm')) throw new Error('no posting panel');
    if (!/not set up/.test(doc.getElementById('postSummary').textContent)) {
      throw new Error(`summary says "${doc.getElementById('postSummary').textContent}"`);
    }
    doc.getElementById('postWebhook').value = 'https://discord.com/api/webhooks/1/abc';
    doc.getElementById('postForm').dispatchEvent(new eighth.window.Event('submit'));
    await new Promise((resolve) => eighth.window.setTimeout(resolve, 120));

    const save = eighth.calls.find((call) => call.url.endsWith('/api/publish/settings') && call.init.method === 'POST');
    if (!save) throw new Error('the form never saved');
    if (JSON.parse(save.init.body).webhook !== 'https://discord.com/api/webhooks/1/abc') throw new Error('wrong payload');
    const test = eighth.calls.find((call) => call.url.endsWith('/api/publish/test'));
    if (!test) throw new Error('saving did not send a test message');
    const status = doc.getElementById('postStatus').textContent;
    if (!/Posted/.test(status)) throw new Error(`status says "${status}"`);
    if (!/Post the links to: Discord/.test(doc.getElementById('postSummary').textContent)) {
      throw new Error(`summary says "${doc.getElementById('postSummary').textContent}"`);
    }
    if (doc.getElementById('postWebhook').value !== '') throw new Error('the URL is left in the field');
    if (doc.getElementById('postWebhook').type !== 'password') throw new Error('the URL is shown in clear text');
  });

  await test('an empty form does not overwrite what is saved', async () => {
    const ninth = await boot({
      links: LINKS,
      publishInfo: {
        chain: ['webhook'],
        disabled: false,
        sinks: [{ id: 'webhook', label: 'Webhook', ready: true, detail: 'Discord · https://discord.com/…', inChain: true }],
        last: null,
        settings: { hasWebhook: true, webhook: 'https://discord.com/…', webhookKind: 'Discord', ntfy: null, paste: false, repo: false, saved: true },
      },
    });
    const doc = ninth.doc;
    if (!/Post the links to: Discord/.test(doc.getElementById('postSummary').textContent)) {
      throw new Error('a saved webhook is not shown');
    }
    doc.getElementById('postForm').dispatchEvent(new ninth.window.Event('submit'));
    await new Promise((resolve) => ninth.window.setTimeout(resolve, 80));
    if (ninth.calls.some((call) => call.url.endsWith('/api/publish/settings') && call.init.method === 'POST')) {
      throw new Error('an empty form posted and would have cleared the setting');
    }
    if (!/Paste a webhook URL/.test(doc.getElementById('postStatus').textContent)) {
      throw new Error(`status says "${doc.getElementById('postStatus').textContent}"`);
    }
  });

  console.log('a file while it runs');

  await test('it shows the link it came from and the name a browser tab will use', async () => {
    const tenth = await boot({ links: LINKS });
    const { window, doc } = tenth;
    /* jsdom has no event streams; the card only needs close(). */
    window.EventSource = class {
      constructor() {
        this.readyState = 0;
      }
      close() {}
    };
    window.__app.trackJob({
      id: 'jobRun',
      status: 'fetching',
      progress: 0.42,
      name: 'Holiday.mp4',
      url: 'https://theditch.st/qhygxukd',
      /* What the linked page's own tab says — not the result file's name. */
      sourceTitle: 'WlVHBYDPhhHcSTmGUcvy.mp4 — fileditch',
      tabTitle: 'Holiday 720p.mp4',
      downloadPath: '/api/jobs/jobRun/download/Holiday%20720p.mp4',
      source: 'url',
      hasFile: false,
    });
    const card = doc.querySelector('[data-job-id="jobRun"]');
    if (!card) throw new Error('no card was rendered for a running job');
    const row = card.querySelector('[data-field="source"]');
    if (!row || row.hidden) throw new Error('the link is not shown under a running file');
    const link = card.querySelector('[data-field="sourceUrl"]');
    if (link.textContent !== 'https://theditch.st/qhygxukd') throw new Error(`link says "${link.textContent}"`);
    if (link.getAttribute('href') !== 'https://theditch.st/qhygxukd') throw new Error('the link is not clickable');
    if (link.getAttribute('target') !== '_blank') throw new Error('the link would replace the app');
    const tab = card.querySelector('[data-field="tabTitle"]');
    if (!/WlVHBYDPhhHcSTmGUcvy\.mp4 — fileditch/.test(tab.textContent)) {
      throw new Error(`tab title says "${tab.textContent}"`);
    }
    if (/720p/.test(tab.textContent)) throw new Error('the tab line is showing the output name, not the link');
  });

  await test('"save the original" is offered on a running file and keeps the encode going', async () => {
    const eleventh = await boot({ links: LINKS });
    const { window, doc } = eleventh;
    window.EventSource = class {
      close() {}
    };
    window.__app.trackJob({
      id: 'jobRun2',
      status: 'compressing',
      progress: 0.3,
      name: 'Long One.mp4',
      url: 'https://pixeldrain.com/u/abc',
      tabTitle: 'Long One.mp4',
      source: 'url',
      hasFile: false,
    });
    const card = doc.querySelector('[data-job-id="jobRun2"]');
    const button = [...card.querySelectorAll('.job-actions button')].find(
      (item) => item.textContent === 'Save the original too',
    );
    if (!button) throw new Error('no “Save the original too” next to a file being treated');
    button.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const call = eleventh.calls.find((entry) => entry.url.includes('/api/jobs/jobRun2/save-original'));
    if (!call) throw new Error('the button never called the server');
    if (call.init.method !== 'POST') throw new Error(`used ${call.init.method}`);
    /* It must never touch the old "stop encoding" route: the encode is the
       point of the job. */
    if (eleventh.calls.some((entry) => entry.url.includes('/keep-original'))) {
      throw new Error('the button stopped the encoder instead of saving the file');
    }
  });

  await test('a file that was already downloaded as-is says so', async () => {
    const twelfth = await boot({ links: LINKS });
    const { window, doc } = twelfth;
    window.EventSource = class {
      close() {}
    };
    window.__app.trackJob({
      id: 'jobCopy',
      status: 'hosted',
      name: 'Long One.mp4',
      outputName: 'Long One.mp4',
      noCompress: true,
      sourceBytes: 300 * 1024 ** 2,
      outputBytes: 300 * 1024 ** 2,
      hostedUrl: 'https://pixeldrain.com/u/Copy1',
      hasFile: true,
      source: 'url',
    });
    const card = doc.querySelector('[data-job-id="jobCopy"]');
    const status = card.querySelector('[data-field="status"]').textContent;
    if (!/as downloaded/.test(status)) throw new Error(`status says "${status}"`);
    if (/Compressed/.test(status)) throw new Error(`a copy is reported as compressed: "${status}"`);
  });

  await test('a long encode says which part it is on', async () => {
    const parts = await boot({ links: LINKS });
    const { window, doc } = parts;
    window.EventSource = class {
      close() {}
    };
    window.__app.trackJob({
      id: 'jobParts',
      status: 'compressing',
      progress: 0.4,
      name: 'Long One.mp4',
      url: 'https://pixeldrain.com/u/abc',
      source: 'url',
      segmentsDone: 4,
      segmentsTotal: 12,
      hasFile: false,
    });
    const card = doc.querySelector('[data-job-id="jobParts"]');
    const meta = card.querySelector('[data-field="meta"]').textContent;
    if (!/part 5\/12 kept/.test(meta)) throw new Error(`meta says "${meta}"`);
  });

  await test('a restart is announced, with what was picked up', async () => {
    const thirteenth = await boot({ links: LINKS });
    const { window, doc } = thirteenth;
    window.__app.renderRecovery({ resumedSinceStart: 2, interruptedNow: 0 });
    const note = doc.getElementById('recoveryNote');
    if (note.hidden) throw new Error('nothing is said after a restart');
    if (!/2 files were picked up/.test(note.textContent)) throw new Error(`note says "${note.textContent}"`);
    window.__app.renderRecovery({ resumedSinceStart: 0, interruptedNow: 1 });
    if (!/being picked up/.test(note.textContent)) throw new Error(`note says "${note.textContent}"`);
    window.__app.renderRecovery({ resumedSinceStart: 0, interruptedNow: 0 });
    if (!note.hidden) throw new Error('the note stays after a clean start');
  });

  console.log('a finished file can actually be taken home');

  await test('a hosted file still offers its download, not only "Details"', async () => {
    const app = await boot();
    const { window, doc } = app;
    window.EventSource = class { close() {} };
    window.__app.trackJob({
      id: 'jobHosted',
      status: 'hosted',
      progress: 1,
      name: 'Holiday.mp4',
      source: 'url',
      hasFile: true,
      hostedUrl: 'https://pixeldrain.com/u/abc123',
      hostProvider: 'pixeldrain',
    });
    const card = doc.querySelector('[data-job-id="jobHosted"]');
    const links = [...card.querySelectorAll('.job-actions a')];
    const download = links.find((item) => /Download$/.test(item.textContent.trim()));
    if (!download) throw new Error(`no download on a hosted card: ${links.map((l) => l.textContent).join(', ')}`);
    if (!/\/api\/jobs\/jobHosted\/download/.test(download.getAttribute('href'))) {
      throw new Error(`download points at ${download.getAttribute('href')}`);
    }
    if (!links.some((item) => item.textContent === 'Details')) throw new Error('no way to the share link');
  });

  await test('a deleted local copy points at the host instead of a dead button', async () => {
    const app = await boot();
    const { window, doc } = app;
    window.EventSource = class { close() {} };
    window.__app.trackJob({
      id: 'jobGone',
      status: 'hosted',
      progress: 1,
      name: 'Holiday.mp4',
      source: 'url',
      hasFile: false,
      localDeleted: true,
      hostedUrl: 'https://pixeldrain.com/u/abc123',
      hostProvider: 'pixeldrain',
    });
    const card = doc.querySelector('[data-job-id="jobGone"]');
    const links = [...card.querySelectorAll('.job-actions a')];
    if (links.some((item) => /\/api\/jobs\/jobGone\/download/.test(item.getAttribute('href') || ''))) {
      throw new Error('a button that answers 410 was left on the card');
    }
    const remote = links.find((item) => /Download from pixeldrain/.test(item.textContent));
    if (!remote) throw new Error(`no link to the uploaded copy: ${links.map((l) => l.textContent).join(', ')}`);
    if (remote.getAttribute('href') !== 'https://pixeldrain.com/u/abc123') {
      throw new Error(`points at ${remote.getAttribute('href')}`);
    }
  });

  console.log('the file itself, not just the decision');

  await test('"save the original too" saves the file immediately when it is whole, and leaves the job running', async () => {
    const app = await boot({
      saveOriginal: {
        ok: true,
        ready: true,
        gone: false,
        download: '/api/jobs/jobWhole/original/Holiday.mp4',
        job: { id: 'jobWhole', status: 'compressing', name: 'Holiday.mp4', originalReady: true, originalName: 'Holiday.mp4' },
      },
    });
    const { window, doc } = app;
    window.EventSource = class { close() {} };
    window.__app.trackJob({
      id: 'jobWhole',
      status: 'compressing',
      progress: 0.2,
      name: 'Holiday.mp4',
      source: 'url',
      hasFile: false,
      originalReady: false,
    });
    const card = doc.querySelector('[data-job-id="jobWhole"]');
    const button = [...card.querySelectorAll('.job-actions button')].find((item) => item.textContent === 'Save the original too');
    if (!button) throw new Error('no \u201cSave the original too\u201d button');

    /* The browser's own download is an anchor click; record it instead of
       letting jsdom try to navigate. */
    const saved = [];
    const realClick = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function record() {
      saved.push(this.getAttribute('href'));
    };
    try {
      button.dispatchEvent(new window.Event('click'));
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    } finally {
      window.HTMLAnchorElement.prototype.click = realClick;
    }
    if (!saved.length) throw new Error('pressing it saved nothing \u2014 the file has to arrive, not just the promise of it');
    if (!/\/api\/jobs\/jobWhole\/original\/Holiday\.mp4$/.test(saved[0])) throw new Error(`saved from ${saved[0]}`);
    /* And the encode is untouched: no "stop encoding" call, no status change. */
    if (app.calls.some((entry) => entry.url.includes('/keep-original'))) {
      throw new Error('saving the original stopped the encoder');
    }
    if (app.calls.some((entry) => /disconnect|cancel/.test(entry.url))) throw new Error('the job was cancelled');
  });

  await test('a file that is still downloading starts saving on its own when it lands', async () => {
    const app = await boot({
      saveOriginal: {
        ok: true,
        ready: false,
        gone: false,
        download: null,
        job: { id: 'jobLate', status: 'fetching', name: 'Big.mkv', originalReady: false, originalBytes: 12 * 1024 ** 2 },
      },
    });
    const { window, doc } = app;
    window.EventSource = class { close() {} };
    window.__app.trackJob({
      id: 'jobLate',
      status: 'fetching',
      progress: 0.4,
      name: 'Big.mkv',
      source: 'url',
      hasFile: false,
      originalReady: false,
    });
    const card = doc.querySelector('[data-job-id="jobLate"]');
    const button = [...card.querySelectorAll('.job-actions button')].find((item) => item.textContent === 'Save the original too');
    const saved = [];
    const realClick = window.HTMLAnchorElement.prototype.click;
    window.HTMLAnchorElement.prototype.click = function record() {
      saved.push(this.getAttribute('href'));
    };
    try {
      button.dispatchEvent(new window.Event('click'));
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      if (saved.length) throw new Error('half a download was handed to the browser');
      /* The download finishes while the tab is still open. */
      window.__app.trackJob({
        id: 'jobLate',
        status: 'compressing',
        progress: 0.1,
        name: 'Big.mkv',
        source: 'url',
        hasFile: false,
        originalReady: true,
        originalName: 'Big.mkv',
      });
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    } finally {
      window.HTMLAnchorElement.prototype.click = realClick;
    }
    if (!saved.length) throw new Error('the file landed and nothing was saved');
    if (!/\/api\/jobs\/jobLate\/original\/Big\.mkv$/.test(saved[0])) throw new Error(`saved from ${saved[0]}`);
  });

  await test('a failed job that kept its work offers "Try again"', async () => {
    const app = await boot();
    const { window, doc } = app;
    window.EventSource = class { close() {} };
    window.__app.trackJob({
      id: 'jobFail',
      status: 'error',
      progress: 0.91,
      name: 'Long one.mkv',
      source: 'url',
      hasFile: false,
      canRetry: true,
      error: 'The encoder finished a part of this file but the file was gone.',
    });
    const card = doc.querySelector('[data-job-id="jobFail"]');
    const again = [...card.querySelectorAll('.job-actions button')].find((item) => item.textContent === 'Try again');
    if (!again) throw new Error('a failure with hours of work behind it offered no way to carry on');
    again.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const call = app.calls.find((entry) => entry.url.includes('/api/jobs/jobFail/retry'));
    if (!call) throw new Error('the button never asked the server to carry on');
    if (call.init.method !== 'POST') throw new Error(`used ${call.init.method}`);
  });

  await test('a job with nothing left to carry on from does not offer "Try again"', async () => {
    const app = await boot();
    const { window, doc } = app;
    window.EventSource = class { close() {} };
    window.__app.trackJob({
      id: 'jobDead',
      status: 'error',
      progress: 0.02,
      name: 'Gone.mp4',
      source: 'url',
      hasFile: false,
      canRetry: false,
      error: 'That link did not return a video.',
    });
    const card = doc.querySelector('[data-job-id="jobDead"]');
    const again = [...card.querySelectorAll('.job-actions button')].find((item) => item.textContent === 'Try again');
    if (again) throw new Error('a button that could only fail was offered anyway');
  });

  console.log('storage and session');

  await test('the disk pill is a button that opens the storage panel', async () => {
    const app = await boot();
    const { window, doc } = app;
    const button = doc.getElementById('storageBtn');
    if (!button) throw new Error('the disk pill is not a button');
    if (button.tagName !== 'BUTTON') throw new Error(`the disk pill is a <${button.tagName.toLowerCase()}>`);
    button.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const panel = doc.getElementById('storagePanel');
    if (!panel) throw new Error('clicking it opened nothing');
    if (panel.getAttribute('role') !== 'dialog') throw new Error('the panel is not announced as a dialog');
    if (!app.calls.some((entry) => entry.url.includes('/api/storage'))) throw new Error('the panel never asked the server what is on disk');
  });

  await test('the panel lists every job with its files, sizes and what they are', async () => {
    const app = await boot();
    const { window, doc } = app;
    doc.getElementById('storageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const rows = doc.querySelectorAll('.storage-job');
    if (rows.length !== STORAGE.jobs.length) throw new Error(`listed ${rows.length} of ${STORAGE.jobs.length} jobs`);
    const first = doc.querySelector('[data-job-id="jobBig"]');
    const text = first.textContent;
    if (!/Holiday film\.mp4/.test(text)) throw new Error('the name is missing');
    if (!/4\.00 GB/.test(text)) throw new Error(`the size is missing: ${text.slice(0, 120)}`);
    if (!/Original download/.test(text) || !/Compressed result/.test(text)) throw new Error('the files are not split by kind');
    if (!/also uploaded/.test(text)) throw new Error('a spare copy is not described');
    /* Where the space went, and that the rows add up. */
    const breakdown = doc.querySelector('.ssize-list').textContent;
    for (const label of ['Videos (jobs)', 'Temp uploads', 'Project (node_modules, ffmpeg)', 'Everything else on the machine']) {
      if (!breakdown.includes(label)) throw new Error(`breakdown is missing "${label}"`);
    }
  });

  await test('a file can be downloaded from the panel, and a running one cannot be deleted', async () => {
    const app = await boot();
    const { window, doc } = app;
    doc.getElementById('storageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    const big = doc.querySelector('[data-job-id="jobBig"]');
    const links = [...big.querySelectorAll('.storage-file-actions a')];
    const original = links.find((link) => /Download original/.test(link.textContent));
    if (!original) throw new Error('no download link for the original');
    if (!/\/api\/jobs\/jobBig\/original\//.test(original.getAttribute('href'))) {
      throw new Error(`it points at ${original.getAttribute('href')}`);
    }
    const compressed = links.find((link) => link.textContent === 'Download');
    if (!compressed) throw new Error('no download link for the compressed file');

    /* The job that is working right now: its delete buttons are disabled. */
    const live = doc.querySelector('[data-job-id="jobLive"]');
    const liveDeletes = [...live.querySelectorAll('.storage-file-actions button')];
    if (!liveDeletes.length) throw new Error('no delete button at all');
    if (!liveDeletes.every((button) => button.disabled)) throw new Error('a running job can be deleted from the panel');
    if (!/In use/.test(live.textContent)) throw new Error('nothing says why it cannot be deleted');
  });

  await test('deleting a file asks first, then tells the server and reloads', async () => {
    const app = await boot();
    const { window, doc } = app;
    const asked = [];
    window.confirm = (message) => {
      asked.push(message);
      return true;
    };
    doc.getElementById('storageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    const big = doc.querySelector('[data-job-id="jobBig"]');
    const remove = [...big.querySelectorAll('.storage-file-actions button')].find((button) => button.textContent === 'Delete');
    remove.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 120));

    if (!asked.length) throw new Error('it deleted without asking');
    if (!/Original download/.test(asked[0])) throw new Error(`the question does not say what: ${asked[0]}`);
    const call = app.calls.find((entry) => entry.url.includes('/api/storage/jobs/jobBig/') && entry.init.method === 'DELETE');
    if (!call) throw new Error('the server was never told');
    if (!/\/source$/.test(call.url)) throw new Error(`deleted ${call.url}`);
    const alert = doc.getElementById('alert');
    if (!/3\.00 GB freed/.test(alert.textContent)) throw new Error(`no report of what was freed: ${alert.textContent}`);
  });

  await test('deleting the only copy warns that it is the only copy', async () => {
    const app = await boot({
      storage: {
        ...STORAGE,
        jobs: [
          {
            ...STORAGE.jobs[0],
            id: 'jobOnly',
            hostedUrl: null,
            files: [
              {
                part: 'output',
                label: 'Compressed result',
                bytes: 1024 ** 3,
                download: '/api/jobs/jobOnly/download/x.mp4',
                note: 'the only copy until it is uploaded',
              },
            ],
          },
        ],
      },
    });
    const { window, doc } = app;
    const asked = [];
    window.confirm = (message) => {
      asked.push(message);
      return false;
    };
    doc.getElementById('storageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const remove = [...doc.querySelectorAll('.storage-file-actions button')].find((button) => button.textContent === 'Delete');
    remove.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    if (!/only copy/.test(asked[0] || '')) throw new Error(`the warning does not mention the only copy: ${asked[0]}`);
    /* Answering "no" must not call the server. */
    if (app.calls.some((entry) => entry.url.includes('/api/storage/jobs/jobOnly') && entry.init.method === 'DELETE')) {
      throw new Error('it deleted after being told not to');
    }
  });

  await test('a job can be pinned so the sweeper leaves it alone', async () => {
    const app = await boot();
    const { window, doc } = app;
    doc.getElementById('storageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const pinned = doc.querySelector('[data-job-id="jobBig"]');
    const pin = pinned.querySelector('[data-pin]');
    if (!pin) throw new Error('no pin button');
    if (pin.textContent !== 'Unpin') throw new Error(`a pinned job offers "${pin.textContent}"`);
    if (!/Pinned/.test(pinned.textContent)) throw new Error('nothing says it is pinned');
    pin.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const call = app.calls.find((entry) => entry.url.includes('/api/jobs/jobBig/pin') && entry.init.method === 'POST');
    if (!call) throw new Error('the server was never told');
    if (JSON.parse(call.init.body).pinned !== false) throw new Error('unpinning sent the wrong value');
  });

  await test('the bulk clean asks, sends what was asked for, and reports the result', async () => {
    const app = await boot();
    const { window, doc } = app;
    const asked = [];
    window.confirm = (message) => {
      asked.push(message);
      return true;
    };
    doc.getElementById('storageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const temp = doc.querySelector('[data-clean="tmp"]');
    if (!temp) throw new Error('no button for the temp uploads');
    temp.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const call = app.calls.find((entry) => entry.url.includes('/api/storage/clean'));
    if (!call) throw new Error('nothing was sent');
    if (JSON.parse(call.init.body).what !== 'tmp') throw new Error(`sent ${call.init.body}`);
    if (!/Freed 2\.00 GB/.test(doc.getElementById('alert').textContent)) throw new Error('the result was not reported');
    if (!asked.length) throw new Error('it cleaned without asking');
  });

  await test('the usage tab shows the month, the session and where the numbers come from', async () => {
    const app = await boot();
    const { window, doc } = app;
    doc.getElementById('usageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const body = doc.getElementById('storageBody');
    if (!body) throw new Error('the usage pill opened nothing');
    if (body.dataset.tab !== 'usage') throw new Error(`opened on "${body.dataset.tab}"`);
    const text = body.textContent;
    if (!/48\.0 core-hours/.test(text)) throw new Error('the month used is missing');
    if (!/120/.test(text)) throw new Error('the quota is missing');
    if (!/36 more hours/.test(text)) throw new Error(`the machine-hours left is missing: ${text.slice(0, 200)}`);
    if (!/3\.20 GB-months/.test(text)) throw new Error('the storage allowance is missing');
    if (!/This session: 1h 0m/.test(text)) throw new Error('the session length is missing');
    if (!/until GitHub stops it for being idle/i.test(text)) throw new Error('no tracker for the time left in the session');
    if (!/30 min/.test(text)) throw new Error('the idle window is missing');
    if (!/not a reading|meter/i.test(text)) throw new Error('it does not admit what it is');
    if (!/monthly/i.test(text) || !/no weekly cap/i.test(text)) throw new Error('the monthly/weekly answer is missing');
    const link = [...body.querySelectorAll('a')].find((a) => /settings\/billing/.test(a.getAttribute('href') || ''));
    if (!link) throw new Error('no link to the real billing page');
    const bars = body.querySelectorAll('.meter-fill');
    if (bars.length < 2) throw new Error('no bars to read at a glance');
  });

  await test('the header pill says how many hours are left, not a bare count', async () => {
    const app = await boot();
    const { window, doc } = app;
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const text = doc.getElementById('usageText').textContent;
    if (!/36\.0 h left/.test(text)) throw new Error(`the pill says "${text}"`);
    const pill = doc.getElementById('usageBtn');
    if (!/48\.0 of 120 core-hours/.test(pill.title)) throw new Error(`the tooltip says "${pill.title}"`);
  });

  await test('the plan can be changed from the panel and the new quota is used', async () => {
    const app = await boot();
    const { window, doc } = app;
    doc.getElementById('usageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const form = doc.getElementById('usageForm');
    if (!form) throw new Error('no plan form');
    const plan = doc.getElementById('usagePlan');
    if (plan.options.length !== 3) throw new Error(`the plan list has ${plan.options.length} options`);
    plan.value = 'pro';
    plan.dispatchEvent(new window.Event('change'));
    if (doc.getElementById('usageCoreHours').value !== '180') throw new Error('choosing Pro did not fill in its quota');
    form.dispatchEvent(new window.Event('submit'));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const call = app.calls.find((entry) => entry.url.includes('/api/usage/settings'));
    if (!call) throw new Error('the plan was not saved');
    const sent = JSON.parse(call.init.body);
    if (sent.plan !== 'pro' || sent.coreHours !== 180) throw new Error(`sent ${call.init.body}`);
  });

  await test('closing the panel stops it refreshing in the background', async () => {
    const app = await boot();
    const { window, doc } = app;
    doc.getElementById('storageBtn').dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    doc.getElementById('storageClose').dispatchEvent(new window.Event('click'));
    if (doc.getElementById('storagePanel')) throw new Error('the panel did not close');
    if (app.window.__app.state.storageTimer) throw new Error('the refresh timer is still running');
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
