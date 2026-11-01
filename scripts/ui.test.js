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
    if (!/Holiday 720p\.mp4/.test(tab.textContent)) throw new Error(`tab title says "${tab.textContent}"`);
  });

  await test('"just download it" is offered on a running file and calls the server', async () => {
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
      (item) => item.textContent === 'Just download it',
    );
    if (!button) throw new Error('no “Just download it” next to a file being treated');
    button.dispatchEvent(new window.Event('click'));
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const call = eleventh.calls.find((entry) => entry.url.includes('/api/jobs/jobRun2/keep-original'));
    if (!call) throw new Error('the button never called the server');
    if (call.init.method !== 'POST') throw new Error(`used ${call.init.method}`);
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

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
