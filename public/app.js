'use strict';

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);

const STORAGE = {
  preset: 'squeeze.preset',
  jobs: 'squeeze.jobs',
};

const state = {
  health: null,
  presets: [],
  presetId: localStorage.getItem(STORAGE.preset) || 'balanced',
  jobs: new Map(), // id -> { el, data, es }
  busy: 0,
};

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m}m ${String(rem).padStart(2, '0')}s` : `${rem}s`;
}

function shortHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function basename(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : shortHost(url);
  } catch {
    return 'Video';
  }
}

function presetOf(id) {
  return state.presets.find((p) => p.id === id) || state.presets.find((p) => p.id === 'balanced') || { id, label: id };
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), {
      code: data.code,
      status: res.status,
    });
  }
  return data;
}

/* ------------------------------------------------------------------- alerts */

function showAlert(message, kind = 'error', { html = false, timeout = 0 } = {}) {
  const el = $('#alert');
  if (!el) return;
  el.hidden = false;
  el.className = `alert ${kind === 'info' ? 'info' : ''}`;
  if (html) el.innerHTML = message;
  else el.textContent = message;
  clearTimeout(el._timer);
  if (timeout) el._timer = setTimeout(() => hideAlert(), timeout);
}

function hideAlert() {
  const el = $('#alert');
  if (el) el.hidden = true;
}

/* --------------------------------------------------------------- transfers */

/** Small panel showing progress before a job exists (browser fetching/uploading). */
function transferPanel() {
  let el = document.getElementById('transferPanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'transferPanel';
    el.className = 'card transfer';
    el.style.cssText = 'margin-top:16px;padding:14px 16px;display:none';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:9px">
        <span class="t-status" style="font-size:13.5px;color:var(--muted)"></span>
        <span class="t-amount" style="font-family:var(--mono);font-size:12.5px;color:var(--dim)"></span>
      </div>
      <div class="progress"><div class="progress-bar" style="width:0%"></div></div>`;
    $('#alert').insertAdjacentElement('beforebegin', el);
  }
  return el;
}

function showTransfer(status, progress, amount) {
  const el = transferPanel();
  el.style.display = 'block';
  $('.t-status', el).textContent = status;
  const bar = $('.progress-bar', el);
  if (progress == null) {
    $('.progress', el).classList.add('is-indeterminate');
  } else {
    $('.progress', el).classList.remove('is-indeterminate');
    bar.style.width = `${Math.round(progress * 100)}%`;
  }
  $('.t-amount', el).textContent = amount || '';
}

function hideTransfer() {
  const el = document.getElementById('transferPanel');
  if (el) el.style.display = 'none';
}

/* -------------------------------------------------------------------- jobs */

function jobsSectionShown() {
  const section = $('#jobsSection');
  if (section) section.hidden = false;
  const clear = $('#clearDone');
  if (clear) clear.hidden = false;
}

function cardFor(id, job = {}) {
  const tpl = $('#jobCardTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.jobId = id;
  const entry = { el, data: job };
  $('#jobList').prepend(el);
  jobsSectionShown();
  return entry;
}

function updateCard(entry, job) {
  entry.data = job;
  const el = entry.el;
  const name = job.name || (job.url ? basename(job.url) : 'Video');
  $('[data-field="name"]', el).textContent = name;
  $('[data-field="name"]', el).title = job.url || name;

  const preset = presetOf(job.presetId);
  $('[data-field="badge"]', el).textContent = job.targetMb ? `${job.targetMb} MB target` : preset.label;

  const statusEl = $('[data-field="status"]', el);
  const progressWrap = $('[data-field="progressWrap"]', el);
  const bar = $('[data-field="progressBar"]', el);
  const metaEl = $('[data-field="meta"]', el);
  const actions = $('[data-field="actions"]', el);

  statusEl.className = 'job-status';
  progressWrap.classList.remove('is-indeterminate');

  const pct = Math.round((job.progress || 0) * 100);
  let statusText = job.stage || 'Working';
  let showProgress = true;

  switch (job.status) {
    case 'queued':
      statusText = 'Queued';
      progressWrap.classList.add('is-indeterminate');
      break;
    case 'fetching':
      statusText = job.progress > 0 ? `Downloading video · ${pct}%` : 'Downloading video';
      if (job.progress <= 0) progressWrap.classList.add('is-indeterminate');
      break;
    case 'compressing':
      statusText = `Compressing · ${pct}%`;
      break;
    case 'done': {
      const before = job.sourceBytes || 0;
      const after = job.outputBytes || 0;
      const saved = before && after ? Math.max(0, 1 - after / before) : 0;
      statusText = `Ready · ${formatBytes(before)} → ${formatBytes(after)}${saved > 0.02 ? ` (−${Math.round(saved * 100)}%)` : ''}`;
      statusEl.classList.add('is-done');
      showProgress = false;
      break;
    }
    case 'error':
      statusText = job.error || 'Failed';
      statusEl.classList.add('is-error');
      showProgress = false;
      break;
    default:
      break;
  }

  statusEl.textContent = statusText;
  progressWrap.style.display = showProgress ? '' : 'none';
  bar.style.width = `${job.status === 'done' ? 100 : pct}%`;

  // thumbnail (generated by the server once the source is probed)
  const thumb = $('.job-thumb', el);
  const fallback = $('.thumb-fallback', thumb);
  if (job.hasThumb && !thumb.querySelector('img')) {
    const img = document.createElement('img');
    img.src = `/api/jobs/${job.id}/thumb`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('load', () => {
      fallback.style.display = 'none';
    });
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  }
  thumb.style.cursor = job.status === 'done' ? 'pointer' : 'default';
  thumb.onclick = () => {
    if (job.status === 'done') location.href = `/j/${job.id}`;
  };

  // meta line
  const bits = [];
  if (job.meta) {
    if (job.meta.width && job.meta.height) bits.push(`${job.meta.width}×${job.meta.height}`);
    const dur = formatDuration(job.meta.duration);
    if (dur) bits.push(dur);
  }
  if (job.status === 'compressing') {
    if (job.speed) bits.push(`${job.speed.toFixed(1)}×`);
    const eta = formatDuration(job.etaSeconds);
    if (eta) bits.push(`${eta} left`);
  }
  if (job.status === 'done' && job.sourceBytes && job.outputBytes) {
    const saved = Math.max(0, 1 - job.outputBytes / job.sourceBytes);
    if (saved > 0.02) bits.push(`<span class="saved">saved ${formatBytes(job.sourceBytes - job.outputBytes)}</span>`);
  }
  if (job.source === 'relay') bits.push('via your browser');
  metaEl.innerHTML = bits.join('<span style="opacity:.3">·</span>');
  metaEl.style.display = bits.length ? '' : 'none';

  actions.innerHTML = '';
  if (job.status === 'done' && job.hasFile) {
    const dl = document.createElement('a');
    dl.className = 'btn download';
    dl.href = `/api/jobs/${job.id}/download`;
    dl.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Download`;
    actions.append(dl);

    const play = document.createElement('a');
    play.className = 'btn';
    play.href = `/j/${job.id}`;
    play.textContent = 'Details';
    actions.append(play);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn tiny';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => removeJob(job.id));
  actions.append(remove);
}

function trackJob(job) {
  const existing = state.jobs.get(job.id);
  const entry = existing || cardFor(job.id, job);
  state.jobs.set(job.id, entry);
  updateCard(entry, job);
  persistJobs();
  if (!entry.es && job.status !== 'done' && job.status !== 'error') {
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    entry.es = es;
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateCard(entry, data);
        if (data.status === 'done' || data.status === 'error') {
          es.close();
          entry.es = null;
          persistJobs();
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      /* EventSource reconnects on its own */
    };
  }
  return entry;
}

async function removeJob(id) {
  const entry = state.jobs.get(id);
  if (entry?.es) entry.es.close();
  state.jobs.delete(id);
  entry?.el.remove();
  persistJobs();
  try {
    await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
  } catch {
    /* offline: card is already gone */
  }
}

let lastPersisted = '';

function persistJobs() {
  const ids = [...state.jobs.values()]
    .filter((e) => e.data.status !== 'error')
    .map((e) => e.data.id)
    .slice(0, 20);
  const serialized = JSON.stringify(ids);
  if (serialized === lastPersisted) return;
  lastPersisted = serialized;
  try {
    localStorage.setItem(STORAGE.jobs, serialized);
  } catch {
    /* storage full/blocked */
  }
}

async function restoreJobs() {
  let ids = [];
  try {
    ids = JSON.parse(localStorage.getItem(STORAGE.jobs) || '[]');
  } catch {
    ids = [];
  }
  for (const id of ids) {
    try {
      const { job } = await api(`/api/jobs/${id}`);
      trackJob(job);
    } catch {
      /* job expired */
    }
  }
}

/* ------------------------------------------------------------------ probing */

function setBusy(delta) {
  state.busy = Math.max(0, state.busy + delta);
  const btn = $('#goBtn');
  if (!btn) return;
  btn.disabled = state.busy > 0;
  btn.classList.toggle('is-busy', state.busy > 0);
  $('span', btn).textContent = state.busy > 0 ? 'Working…' : 'Squeeze';
}

function currentOptions() {
  const targetRaw = $('#targetMb')?.value;
  const targetMb = Number(targetRaw) > 0 ? Math.round(Number(targetRaw)) : null;
  return { presetId: state.presetId, targetMb };
}

/* ------------------------------------------------------------- browser relay */

function supportsStreamingUpload() {
  try {
    // eslint-disable-next-line no-new
    new Request('/', { method: 'PUT', body: new ReadableStream(), duplex: 'half' });
    return true;
  } catch {
    return false;
  }
}

async function relayThroughBrowser(url, { platform } = {}) {
  const { token } = await api('/api/relay-token', { method: 'POST' });
  const opts = currentOptions();

  showTransfer(`Fetching video in your browser…`, null, shortHost(url));

  let response;
  try {
    response = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
  } catch (err) {
    throw Object.assign(
      new Error(
        platform
          ? `This server can't extract ${platform} links (no yt-dlp installed), and your browser can't fetch the video directly. Download the video, then drop the file here.`
          : `Your browser couldn't fetch that link (the site blocks cross-origin requests). Save the video to your device, then drag the file here — compression works exactly the same.`,
      ),
      { code: 'BROWSER_FETCH' },
    );
  }

  if (!response.ok) {
    throw new Error(`The link returned HTTP ${response.status}. If it needs a login, download it first and drop the file here.`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw new Error('That link is a web page, not a video file. Open it, save the video, then drop the file here.');
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const qs = new URLSearchParams({
    url,
    filename: basename(url),
    presetId: opts.presetId,
  });
  if (opts.targetMb) qs.set('targetMb', String(opts.targetMb));
  const endpoint = `/api/relay/${token}?${qs.toString()}`;

  let sent = 0;
  const progress = () => {
    const p = total ? sent / total : null;
    showTransfer(
      total ? 'Sending to the compressor…' : 'Sending to the compressor…',
      p,
      total ? `${formatBytes(sent)} / ${formatBytes(total)}` : formatBytes(sent),
    );
  };

  if (response.body && supportsStreamingUpload()) {
    const counter = new TransformStream({
      transform(chunk, controller) {
        sent += chunk.length;
        progress();
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(endpoint, {
      method: 'PUT',
      body: response.body.pipeThrough(counter),
      duplex: 'half',
      headers: { 'content-type': contentType || 'application/octet-stream' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Upload failed (${res.status})`), { code: data.code });
    return data.job;
  }

  // Fallback: buffer the whole file, then upload with progress events.
  const blob = await response.blob();
  const job = await uploadBlob(blob, {
    endpoint,
    name: basename(url),
    url,
  });
  return job;
}

function uploadBlob(blob, { endpoint, name, url, method = 'PUT' }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, endpoint);
    xhr.setRequestHeader('content-type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) showTransfer('Sending to the compressor…', e.loaded / e.total, `${formatBytes(e.loaded)} / ${formatBytes(e.total)}`);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.job);
      else reject(Object.assign(new Error(data.error || `Upload failed (${xhr.status})`), { code: data.code }));
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
    xhr.send(blob);
  });
}

/* ------------------------------------------------------------------ actions */

async function handleLink(raw) {
  const url = raw.trim();
  if (!url) return;

  const probe = await api('/api/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (probe.serverCanFetch) {
    const opts = currentOptions();
    const { job } = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'url', url: probe.url, ...opts }),
    });
    trackJob(job);
    return;
  }

  showTransfer('Opening the link in your browser…', null, shortHost(probe.url));
  const job = await relayThroughBrowser(probe.url, { platform: probe.platform });
  hideTransfer();
  trackJob(job);
}

async function handleFile(file) {
  const opts = currentOptions();
  const qs = new URLSearchParams({ name: file.name, presetId: opts.presetId });
  if (opts.targetMb) qs.set('targetMb', String(opts.targetMb));
  showTransfer(`Sending ${file.name}…`, 0, formatBytes(file.size));
  const job = await uploadBlob(file, { endpoint: `/api/upload?${qs}`, method: 'POST', name: file.name });
  hideTransfer();
  trackJob(job);
}

async function squeeze() {
  const raw = $('#urlInput').value;
  const files = [...($('#fileInput').files || [])];
  const links = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);

  if (!links.length && !files.length) {
    showAlert('Paste a video link or drop a file first.', 'error');
    return;
  }

  hideAlert();
  setBusy(1);
  const failures = [];

  for (const link of links) {
    try {
      await handleLink(link);
    } catch (err) {
      failures.push({ link, err });
    } finally {
      hideTransfer();
    }
  }

  for (const file of files) {
    try {
      await handleFile(file);
    } catch (err) {
      failures.push({ link: file.name, err });
    } finally {
      hideTransfer();
    }
  }

  setBusy(-1);
  if ($('#urlInput').value.trim() && !failures.length) $('#urlInput').value = '';
  $('#fileInput').value = '';

  if (failures.length) {
    const first = failures[0];
    showAlert(
      `${failures.length === 1 ? '' : `${failures.length} items failed. `}${first.err.message}`,
      'error',
    );
  }
}

async function squeezeSample() {
  hideAlert();
  setBusy(1);
  try {
    const opts = currentOptions();
    const { job } = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'sample', ...opts }),
    });
    trackJob(job);
  } catch (err) {
    showAlert(err.message, 'error');
  } finally {
    setBusy(-1);
  }
}

/* --------------------------------------------------------------------- init */

function renderPresets(presets) {
  state.presets = presets;
  const wrap = $('#quality');
  wrap.innerHTML = '';
  for (const preset of presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.dataset.preset = preset.id;
    btn.textContent = preset.label;
    btn.title = preset.hint;
    btn.setAttribute('aria-checked', String(preset.id === state.presetId));
    btn.addEventListener('click', () => {
      state.presetId = preset.id;
      localStorage.setItem(STORAGE.preset, preset.id);
      for (const other of wrap.children) other.setAttribute('aria-checked', String(other === btn));
    });
    wrap.append(btn);
  }
  if (!presets.some((p) => p.id === state.presetId)) state.presetId = 'balanced';
}

function bindDropzone() {
  const dz = $('#dropzone');
  const input = $('#fileInput');
  let depth = 0;

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ['dragenter', 'dragover'].forEach((evt) =>
    dz.addEventListener(evt, (e) => {
      stop(e);
      if (evt === 'dragenter') depth += 1;
      if (e.dataTransfer?.types?.includes('Files')) dz.classList.add('is-dragging');
    }),
  );

  dz.addEventListener('dragleave', (e) => {
    stop(e);
    depth = Math.max(0, depth - 1);
    if (depth === 0) dz.classList.remove('is-dragging');
  });

  dz.addEventListener('drop', async (e) => {
    stop(e);
    depth = 0;
    dz.classList.remove('is-dragging');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v|ogv)$/i.test(f.name));
    if (!files.length) {
      showAlert('Those files are not videos. Drop an mp4, mov, mkv, webm or avi file.', 'error');
      return;
    }
    hideAlert();
    setBusy(1);
    const failures = [];
    for (const file of files) {
      try {
        await handleFile(file);
      } catch (err) {
        failures.push(err);
      } finally {
        hideTransfer();
      }
    }
    setBusy(-1);
    if (failures.length) showAlert(failures[0].message, 'error');
  });

  $('#browseBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.length) squeeze();
  });
}

async function boot() {
  bindDropzone();
  $('#goBtn').addEventListener('click', squeeze);
  $('#sampleBtn').addEventListener('click', squeezeSample);
  $('#clearDone').addEventListener('click', () => {
    for (const [id, entry] of [...state.jobs]) {
      if (entry.data.status === 'done') removeJob(id);
    }
  });
  $('#urlInput').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') squeeze();
  });
  $('#targetMb').addEventListener('blur', () => {
    const v = Number($('#targetMb').value);
    if (v > 0) $('#targetMb').value = Math.max(1, Math.min(2000, Math.round(v)));
  });

  try {
    const health = await api('/api/health');
    state.health = health;
    renderPresets(health.presets);
    const pill = $('#enginePill');
    pill.classList.add('is-ok');
    $('#engineText').textContent = health.platformDownloads
      ? 'encoder ready · all links'
      : 'encoder ready · direct links';
    $('#enginePill').title = health.platformDownloads
      ? 'yt-dlp is installed, so YouTube / TikTok / Instagram links work too.'
      : 'No yt-dlp on this server: direct video links and file uploads work. Platform links fall back to your browser.';
    $('#limitNote').textContent = `uploads up to ${health.maxUploadMb >= 1024 ? `${Math.round(health.maxUploadMb / 1024)} GB` : `${health.maxUploadMb} MB`}`;
  } catch {
    renderPresets([
      { id: 'tiny', label: 'Tiny', hint: '' },
      { id: 'small', label: 'Small', hint: '' },
      { id: 'balanced', label: 'Balanced', hint: '' },
      { id: 'high', label: 'High', hint: '' },
      { id: 'original', label: 'Original res', hint: '' },
    ]);
    $('#engineText').textContent = 'engine unavailable';
  }

  restoreJobs();
}

document.addEventListener('DOMContentLoaded', boot);
