'use strict';

/**
 * Browser-side connectivity report.
 *
 * The point is to answer "why didn't my link work" without guessing: the app
 * either needs the server to reach a host, or your browser to read it. Each
 * check below proves one of those hops.
 */

const rows = [];
const reportLines = [];

const CHECKS = [
  {
    id: 'app',
    label: 'This app is reachable',
    detail: 'The page loaded, so the server is up.',
    run: async () => {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return `presets: ${data.presets.length} · upload limit: ${data.maxUploadMb} MB · yt-dlp: ${data.platformDownloads ? 'yes' : 'no'}`;
    },
  },
  {
    id: 'server-net',
    label: 'The server has internet access',
    detail: 'If this fails, the server must rely on your browser to fetch files.',
    run: async () => {
      const res = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.serverCanFetch) throw new Error('no outbound route from the server');
      return 'server can fetch external URLs';
    },
  },
  {
    id: 'gofile-api',
    label: 'gofile (folder lookup) — your browser',
    detail: 'A guest account is required to list a gofile folder.',
    run: async () => {
      const res = await fetch('https://api.gofile.io/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => ({}));
      if (!data || data.status !== 'ok' || !data.data?.token) {
        throw new Error(`gofile refused a guest account (${data.status || res.status})`);
      }
      return 'guest account issued';
    },
  },
  {
    id: 'gofile-storage',
    label: 'gofile (file bytes) — your browser',
    detail: 'Download servers must allow cross-origin reads for automatic fetching.',
    run: async () => {
      const res = await fetch('https://store1.gofile.io/', { method: 'GET' });
      const exposed = res.headers.get('access-control-allow-origin');
      if (!exposed) throw new Error('no access-control-allow-origin header');
      return `CORS: ${exposed}`;
    },
  },
  {
    id: 'pixeldrain',
    label: 'pixeldrain — your browser',
    detail: 'pixeldrain serves its API with open CORS, so links can be read directly.',
    run: async () => {
      const res = await fetch('https://pixeldrain.com/api/file/probe0000/info');
      const exposed = res.headers.get('access-control-allow-origin');
      if (!exposed) throw new Error('no access-control-allow-origin header');
      return `CORS: ${exposed}`;
    },
  },
  {
    id: 'turbo',
    label: 'turbo.cr — your browser',
    detail: 'turbo needs a signing call, which it does not allow from other websites.',
    run: async () => {
      const res = await fetch('https://turbo.cr/api/sign?v=probe0000');
      const exposed = res.headers.get('access-control-allow-origin');
      if (!exposed) throw new Error('blocked: turbo.cr sends no CORS headers');
      return `CORS: ${exposed}`;
    },
  },
  {
    id: 'relay',
    label: 'Upload path (browser → this server)',
    detail: 'Files your browser fetches are streamed here. This sends junk bytes on purpose and expects a rejection.',
    run: async () => {
      const { token } = await (await fetch('/api/relay-token', { method: 'POST' })).json();
      const res = await fetch(`/api/relay/${token}?filename=probe.bin`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new TextEncoder().encode('not a video'),
      });
      // Reaching the endpoint at all is the success condition: a 415 means the
      // bytes arrived and were correctly rejected as non-video.
      if (res.status === 415 || res.status === 201) return `upload reached the server (HTTP ${res.status})`;
      throw new Error(`unexpected response HTTP ${res.status}`);
    },
  },
  {
    id: 'ffmpeg',
    label: 'Compression engine',
    detail: 'A tiny end-to-end encode proves ffmpeg works on this machine.',
    run: async () => {
      const created = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'sample', presetId: 'tiny' }),
      });
      if (!created.ok) throw new Error(`could not create a job (HTTP ${created.status})`);
      const { job } = await created.json();

      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1200));
        const state = await (await fetch(`/api/jobs/${job.id}`)).json();
        if (state.job.status === 'done') {
          const saved = Math.round((1 - state.job.outputBytes / state.job.sourceBytes) * 100);
          return `encoded ${formatMb(state.job.sourceBytes)} → ${formatMb(state.job.outputBytes)} (−${saved}%)`;
        }
        if (state.job.status === 'error') throw new Error(state.job.error || 'encode failed');
      }
      throw new Error('encode did not finish in 3 minutes');
    },
  },
];

function formatMb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function rowEl(check) {
  let el = document.getElementById(`row-${check.id}`);
  if (!el) {
    el = document.createElement('div');
    el.id = `row-${check.id}`;
    el.className = 'diag-row';
    el.innerHTML = '<span class="diag-icon">·</span><span class="diag-label"></span><span class="diag-time"></span>';
    document.getElementById('diagRows').append(el);
  }
  return el;
}

function paint(check, state, detail, elapsed) {
  const el = rowEl(check);
  el.className = `diag-row ${state}`;
  const icon = state === 'ok' ? '✓' : state === 'fail' ? '✗' : '·';
  el.querySelector('.diag-icon').textContent = icon;
  el.querySelector('.diag-label').textContent = check.label;
  if (detail) {
    const span = document.createElement('span');
    span.className = 'diag-detail';
    span.textContent = detail;
    el.querySelector('.diag-label').append(span);
  }
  el.querySelector('.diag-time').textContent = elapsed != null ? `${elapsed} ms` : '';
}

async function run() {
  document.getElementById('diagRows').innerHTML = '';
  document.getElementById('verdictCard').hidden = true;
  rows.length = 0;
  reportLines.length = 0;

  const results = {};

  for (const check of CHECKS) {
    paint(check, 'run', check.detail, null);
    const started = performance.now();
    try {
      const detail = await check.run();
      const elapsed = Math.round(performance.now() - started);
      paint(check, 'ok', detail, elapsed);
      results[check.id] = { ok: true, detail };
      reportLines.push(`PASS  ${check.id}: ${detail}`);
    } catch (err) {
      const elapsed = Math.round(performance.now() - started);
      const message = err && err.message ? err.message : String(err);
      paint(check, 'fail', message, elapsed);
      results[check.id] = { ok: false, detail: message };
      reportLines.push(`FAIL  ${check.id}: ${message}`);
    }
  }

  document.getElementById('verdict').replaceChildren(verdictFor(results));
  document.getElementById('verdictCard').hidden = false;

  // Signals are cumulative: the encoder and upload path are what actually gate everything else.
  if (!results.ffmpeg?.ok) {
    document.getElementById('verdict').textContent =
      'The encoder is not working, so nothing can be compressed on this server right now.';
  }
}

function verdictFor(results) {
  const frag = document.createDocumentFragment();
  const add = (text, tone) => {
    const p = document.createElement('p');
    p.style.margin = '0 0 10px';
    if (tone === 'good') p.style.color = 'var(--accent)';
    if (tone === 'bad') p.style.color = 'var(--danger)';
    p.textContent = text;
    frag.append(p);
  };

  if (!results.ffmpeg?.ok) {
    add('Compression is unavailable on this server — everything else is blocked behind it.', 'bad');
    return frag;
  }
  add('Compression works: files you drop in or upload are encoded correctly.', 'good');

  if (results['server-net']?.ok) {
    add('The server has internet access, so pasted links are downloaded and compressed without extra steps.', 'good');
  } else {
    add(
      'The server has no outbound internet. Links therefore only work if your browser can read the file ' +
        'and stream it here — which needs the host to allow cross-origin reads.',
    );
  }

  if (results.gofile?.ok && results['gofile-storage']?.ok) {
    add('gofile links work automatically: folder listing and file bytes are both readable from your browser.', 'good');
  } else if (results['gofile-storage']?.ok) {
    add('gofile storage is readable, but folder listing failed — paste a direct file link if you have one.');
  } else {
    add('gofile cannot be read automatically here. Use the "Download, then drop" option instead.');
  }

  if (results.pixeldrain?.ok) add('pixeldrain links work automatically.', 'good');
  else add('pixeldrain is not readable from this browser right now.');

  if (results.turbo?.ok) add('turbo.cr links work automatically.', 'good');
  else {
    add(
      'turbo.cr (also bunkr and filester) block cross-origin reads. For those, use "Download, then drop": ' +
        'one click saves the file to your device, then drag it onto the page.',
    );
  }

  if (!results.relay?.ok) {
    add('Uploads from your browser are failing, so even drag & drop may not work. Try a smaller file first.', 'bad');
  }

  return frag;
}

async function copyReport() {
  const header = `Squeeze diagnostics — ${new Date().toISOString()}\nua: ${navigator.userAgent}`;
  const text = `${header}\n\n${reportLines.join('\n')}`;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('copy');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch {
    // Clipboard blocked: show the report so it can be selected by hand.
    const box = document.createElement('textarea');
    box.value = text;
    box.style.cssText = 'width:100%;height:140px;margin-top:12px;background:#0b1011;color:#e9eeeb;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px;font-family:monospace;font-size:12px';
    document.getElementById('verdict').append(box);
    box.select();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('rerun').addEventListener('click', run);
  document.getElementById('copy').addEventListener('click', copyReport);
  run();
});
