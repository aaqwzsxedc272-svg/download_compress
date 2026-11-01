'use strict';

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);

const STORAGE = {
  preset: 'squeeze.preset',
  jobs: 'squeeze.jobs',
  autoHost: 'squeeze.autohost',
  noCompress: 'squeeze.nocompress',
};

const state = {
  health: null,
  presets: [],
  presetId: localStorage.getItem(STORAGE.preset) || 'auto',
  autoHost: localStorage.getItem(STORAGE.autoHost) !== '0',
  noCompress: localStorage.getItem(STORAGE.noCompress) === '1',
  serverHostTried: new Set(),
  browserHostTried: new Set(),
  jobs: new Map(), // id -> { el, data, es }
  mail: null,
  busy: 0,
};

const BROWSER_HOST_LIMIT = 1.5 * 1024 ** 3;

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

function showAlert(message, kind = 'error', { timeout = 0, href = null, hrefLabel = 'Open link' } = {}) {
  const el = $('#alert');
  if (!el) return;
  el.hidden = false;
  el.className = `alert ${kind === 'info' ? 'info' : ''}${kind === 'ok' ? 'ok' : ''}`;
  el.textContent = message;
  if (href) {
    const link = document.createElement('a');
    link.className = 'btn';
    link.style.marginLeft = '12px';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = hrefLabel;
    el.append(' ', link);
  }
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
  const previous = entry.data || {};
  entry.data = job;
  if (job.status === 'hosted' && previous.status !== 'hosted') {
    scheduleResultsRefresh();
    loadPublishInfo();
  }
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
    case 'fetching': {
      const speed = job.downloadSpeed ? `${formatBytes(job.downloadSpeed)}/s` : '';
      const left = job.downloadEta ? formatDuration(job.downloadEta) : '';
      statusText = job.progress > 0
        ? `Downloading video · ${pct}%${speed ? ` · ${speed}` : ''}${left ? ` · ${left} left` : ''}`
        : 'Downloading video';
      if (job.progress > 0) progressWrap.classList.remove('is-indeterminate');
      break;
    }
      if (job.progress <= 0) progressWrap.classList.add('is-indeterminate');
      break;
    case 'compressing':
      // Before the encoder has reported progress the stage says what is going on
      // ("Checking what is worth encoding"), which matters on a slow file.
      statusText = pct > 0 ? `Compressing · ${pct}%` : job.stage || 'Compressing';
      break;
    case 'done': {
      const before = job.sourceBytes || 0;
      const after = job.outputBytes || 0;
      const saved = before && after ? Math.max(0, 1 - after / before) : 0;
      statusText = job.usedOriginal
        ? `Already compressed · original kept · ${formatBytes(before)}`
        : `Compressed · ${formatBytes(before)} → ${formatBytes(after)}${saved > 0.02 ? ` (−${Math.round(saved * 100)}%)` : ''}`;
      statusEl.classList.add('is-done');
      showProgress = false;
      break;
    }
    case 'hosting':
      statusText = job.stage || 'Uploading to a file host…';
      progressWrap.classList.remove('is-indeterminate');
      break;
    case 'hosted': {
      const before = job.sourceBytes || 0;
      const after = job.outputBytes || 0;
      const saved = before && after ? Math.max(0, 1 - after / before) : 0;
      statusText = job.usedOriginal
        ? `Link ready · original kept · ${formatBytes(before)}`
        : `Link ready · ${formatBytes(before)} → ${formatBytes(after)}${saved > 0.02 ? ` (−${Math.round(saved * 100)}%)` : ''}`;
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
  bar.style.width = `${['done', 'hosted'].includes(job.status) ? 100 : pct}%`;

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
    // The size was predicted by probing before the real encode started, so the
    // estimate is worth showing while the long part runs.
    const proj = job.projection;
    if (proj && Number.isFinite(proj.projectedBytes) && proj.saving > 0.02) {
      bits.push(`projected ${formatBytes(proj.projectedBytes)} (−${Math.round(proj.saving * 100)}%)`);
    }
    if (proj && proj.crf && proj.crf !== preset.crf) bits.push(`CRF ${proj.crf}`);
  }
  if (['done', 'hosted'].includes(job.status) && job.outputSize && job.outputSize.width) {
    const sameAsSource = job.meta && job.meta.width === job.outputSize.width;
    if (!sameAsSource) bits.push(`${job.outputSize.width}×${job.outputSize.height} out`);
  }
  if (job.status === 'done' && job.sourceBytes && job.outputBytes) {
    const saved = Math.max(0, 1 - job.outputBytes / job.sourceBytes);
    if (saved > 0.02) bits.push(`<span class="saved">saved ${formatBytes(job.sourceBytes - job.outputBytes)}</span>`);
    else if (job.usedOriginal) bits.push('no smaller copy was possible');
    if (job.projection && job.projection.crf && job.projection.crf !== preset.crf) {
      bits.push(`CRF ${job.projection.crf}`);
    }
  }
  if (job.source === 'relay') bits.push('via your browser');
  metaEl.innerHTML = bits.join('<span style="opacity:.3">·</span>');
  metaEl.style.display = bits.length ? '' : 'none';

  // Why a file came back the size it did — especially when it could not shrink.
  const noteEl = $('[data-field="note"]', el);
  if (noteEl) {
    const note = job.status === 'error' ? '' : job.note || '';
    noteEl.textContent = note;
    noteEl.hidden = !note;
  }

  actions.innerHTML = '';

  // The share link is the point of the app, so it gets its own row.
  const oldHosted = el.querySelector('.hosted');
  if (oldHosted) oldHosted.remove();
  if (job.hostedUrl) {
    metaEl.insertAdjacentElement('beforebegin', hostedBlock(job));
  }

  if (job.status === 'hosted' && job.hasFile) {
    const play = document.createElement('a');
    play.className = 'btn';
    play.href = `/j/${job.id}`;
    play.textContent = 'Details';
    actions.append(play);
  } else if (job.status === 'done' && job.hasFile) {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'btn download';
    share.textContent = 'Get a share link';
    share.addEventListener('click', async () => {
      share.disabled = true;
      share.textContent = 'Uploading…';
      try {
        if (job.hostError) {
          await hostFromBrowser(job);
        } else {
          try {
            await hostOnServer(job);
          } catch {
            await hostFromBrowser(job);
          }
        }
      } catch (err) {
        showAlert(`Share link failed: ${err.message}`, 'error');
      } finally {
        hideTransfer();
        share.disabled = false;
        share.textContent = 'Get a share link';
      }
    });
    actions.append(share);
  }

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
  if (job.status === 'done' && !job.hostedUrl) ensureHosted(job);
  if (!entry.es && job.status !== 'done' && job.status !== 'error') {
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    entry.es = es;
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateCard(entry, data);
        if (data.status === 'error') {
          es.close();
          entry.es = null;
          persistJobs();
        } else if (data.status === 'hosted') {
          es.close();
          entry.es = null;
          persistJobs();
        } else if (data.status === 'done') {
          // Keep listening: the server may move straight on to hosting.
          if (state.autoHost && !data.hostedUrl) ensureHosted(data);
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
  /* The server is the source of truth, not this browser: a job started before
     the tab was closed (or from another tab) belongs in the list too. */
  try {
    const { jobs } = await api('/api/jobs');
    const serverIds = (jobs || []).slice(0, 12).map((job) => job.id);
    ids = [...new Set([...ids, ...serverIds])];
  } catch {
    /* offline: fall back to what this browser remembers */
  }
  for (const id of ids) {
    try {
      const { job } = await api(`/api/jobs/${id}`);
      if (!state.jobs.has(id)) trackJob(job);
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
  $('span', btn).textContent = state.busy > 0 ? 'Working…' : state.noCompress ? 'Download' : 'Squeeze';
}

const STORAGE_HOST = 'squeeze.host';

/** The upload-host preference, as a chain the server understands. */
function hostOrderChoice() {
  const value = localStorage.getItem(STORAGE_HOST) || 'auto';
  return value && value !== 'auto' ? [value] : [];
}

function currentOptions() {
  const targetRaw = $('#targetMb')?.value;
  const targetMb = Number(targetRaw) > 0 ? Math.round(Number(targetRaw)) : null;
  return {
    presetId: state.presetId,
    targetMb,
    hostOrder: hostOrderChoice(),
    ...(state.noCompress ? { noCompress: true } : {}),
  };
}

/**
 * "Just download it" turns the encoder off, so the quality controls stop
 * meaning anything. Grey them out rather than leave live-looking knobs that
 * do nothing.
 */
function syncComposerMode() {
  const on = state.noCompress;
  for (const sel of ['#quality', '#targetMb']) {
    const el = $(sel);
    if (!el) continue;
    el.classList.toggle('is-off', on);
    el.disabled = on;
    if (el.parentElement) el.parentElement.classList.toggle('is-off', on);
  }
  const go = $('#goBtn');
  if (go && !state.busy) $('span', go).textContent = on ? 'Download' : 'Squeeze';
  const note = $('#composerNote');
  if (note) {
    note.textContent = on
      ? 'The original file is handed back untouched — only re-wrapped to MP4 when the host stores it as something else.'
      : '';
    note.hidden = !on;
  }
}


/* ------------------------------------------------- chunked (resumable) upload */

const CHUNK_SIZE_FALLBACK = 8 * 1024 * 1024;
const CHUNKED_THRESHOLD = 48 * 1024 * 1024; // above this, chunk the transfer

/**
 * Send bytes to the server in slices, so a dropped connection or a proxy that
 * dislikes giant requests does not lose a multi-GB transfer.
 * `source` is either a Response (streamed body) or a Blob/File.
 */
async function chunkedUpload(source, { name, pageUrl, total, label }) {
  const opts = currentOptions();
  const init = await api('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: name,
      size: total || 0,
      presetId: opts.presetId,
      targetMb: opts.targetMb,
      url: pageUrl || null,
      noCompress: Boolean(opts.noCompress),
    }),
  });

  const chunkSize = init.chunkSize || CHUNK_SIZE_FALLBACK;
  const uploadId = init.uploadId;
  let index = 0;
  let sent = 0;

  const report = () => {
    showTransfer(
      label || 'Sending to the compressor…',
      total ? sent / total : null,
      total ? `${formatBytes(sent)} / ${formatBytes(total)}` : formatBytes(sent),
    );
  };

  const put = async (bytes) => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(`/api/upload/chunk/${uploadId}/${index}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        });
        if (res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) return; // already stored; move on
        lastError = new Error(data.error || `HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastError;
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw lastError || new Error('Upload failed.');
  };

  if (source instanceof Blob) {
    while (sent < source.size) {
      const slice = source.slice(sent, sent + chunkSize);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      await put(bytes);
      sent += bytes.length;
      index += 1;
      report();
    }
  } else {
    // Stream the response body and send each accumulated slice.
    const reader = source.body.getReader();
    let pending = new Uint8Array(chunkSize);
    let filled = 0;

    const flush = async () => {
      const bytes = pending.subarray(0, filled);
      await put(bytes);
      sent += filled;
      index += 1;
      filled = 0;
      report();
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.length) {
        const room = chunkSize - filled;
        const take = Math.min(room, value.length - offset);
        pending.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === chunkSize) await flush();
      }
    }
    if (filled > 0) await flush();
  }

  const res = await api(`/api/upload/finish/${uploadId}`, { method: 'POST' });
  return res.job;
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

/**
 * The browser already knows (or can find) the real file URL, so it fetches the
 * bytes and streams them to the encoder. Used whenever the server itself has
 * no route to the host.
 */
async function relayBytes(directUrl, { pageUrl, filename } = {}) {
  const { token } = await api('/api/relay-token', { method: 'POST' });
  const opts = currentOptions();
  const label = filename || basename(directUrl);

  showTransfer(`Fetching ${label} in your browser…`, null, '');

  let response;
  try {
    response = await fetch(directUrl, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
  } catch {
    throw Object.assign(
      new Error(
        `${shortHost(directUrl) || 'That host'} won't let a browser read its files directly (cross-origin blocked). ` +
          'Open the link, download the file, then drop it on this page — the compression is identical.',
      ),
      { code: 'CORS_BLOCKED' },
    );
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(`The file host answered HTTP ${response.status}. It may be rate limited or need a login.`),
      { code: 'BAD_STATUS' },
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    throw Object.assign(
      new Error('That link returned a web page instead of a video file.'),
      { code: 'HTML_PAGE' },
    );
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const qs = new URLSearchParams({ filename: label, presetId: opts.presetId });
  if (pageUrl) qs.set('url', pageUrl);
  if (opts.targetMb) qs.set('targetMb', String(opts.targetMb));
  const endpoint = `/api/relay/${token}?${qs.toString()}`;

  const sentRef = { value: 0 };
  const progress = (sent) => {
    showTransfer(
      'Sending to the compressor…',
      total ? sent / total : null,
      total ? `${formatBytes(sent)} / ${formatBytes(total)}` : formatBytes(sent),
    );
  };

  // Multi-GB or unknown-size bodies go through the resumable chunked path, which
  // survives proxies that dislike a single enormous request.
  if (!total || total > CHUNKED_THRESHOLD) {
    return chunkedUpload(response, {
      name: label,
      pageUrl,
      total,
      label: 'Sending to the compressor…',
    });
  }

  const canStream = response.body && supportsStreamingUpload();

  if (canStream) {
    try {
      const job = await streamPut(response, endpoint, contentType, progress, sentRef);
      return job;
    } catch (err) {
      // Some proxies drop chunked uploads; fall back to a buffered send.
      if (err.code !== 'TRANSPORT') throw err;
      showTransfer('Retrying with a buffered upload…', null, '');
    }
  }

  // No streaming uploads (older Safari, or a proxy that refuses chunked bodies):
  // buffer, then send with progress events. The original body may already be
  // half-consumed by the failed stream, so pull a fresh copy.
  let blob;
  try {
    blob = await response.clone().blob();
  } catch {
    showTransfer('Re-reading the file…', null, '');
    const again = await fetch(directUrl, { mode: 'cors', credentials: 'omit' });
    if (!again.ok) throw Object.assign(new Error(`The host answered HTTP ${again.status} on retry.`), { code: 'BAD_STATUS' });
    blob = await again.blob();
  }
  if (blob.size > RELAY_BUFFER_LIMIT) {
    throw Object.assign(
      new Error(
        `This file is ${formatBytes(blob.size)}, which is too large to push through this preview in one piece. ` +
          'Download it and drop the file instead.',
      ),
      { code: 'TOO_LARGE' },
    );
  }
  return uploadBlob(blob, { endpoint, name: label });
}

const RELAY_BUFFER_LIMIT = 512 * 1024 * 1024;

async function streamPut(response, endpoint, contentType, progress, sentRef) {
  const counter = new TransformStream({
    transform(chunk, controller) {
      sentRef.value += chunk.length;
      progress(sentRef.value);
      controller.enqueue(chunk);
    },
  });

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'PUT',
      body: response.body.pipeThrough(counter),
      duplex: 'half',
      headers: { 'content-type': contentType || 'application/octet-stream' },
    });
  } catch {
    throw Object.assign(new Error('The upload stream was cut off.'), { code: 'TRANSPORT' });
  }

  const data = await res.json().catch(() => ({}));
  if (res.status >= 500) throw Object.assign(new Error(data.error || 'Server error'), { code: 'TRANSPORT' });
  if (!res.ok) throw Object.assign(new Error(data.error || `Upload failed (${res.status})`), { code: data.code });
  return data.job;
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

/* ------------------------------------------------------------------ hosting */

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text).catch(() => {
    const box = document.createElement('textarea');
    box.value = text;
    document.body.append(box);
    box.select();
    try {
      document.execCommand('copy');
    } catch {
      /* nothing else to try */
    }
    box.remove();
  });
}

function hostedBlock(job) {
  const wrap = document.createElement('div');
  wrap.className = 'hosted';

  const label = document.createElement('span');
  label.className = 'hosted-label';
  label.textContent = job.hostProvider ? `on ${job.hostProvider}` : 'link';

  const link = document.createElement('a');
  link.className = 'hosted-url';
  link.href = job.hostedUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = job.hostedUrl;
  link.title = job.hostedUrl;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-btn';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    await copyToClipboard(job.hostedUrl);
    copy.textContent = 'Copied';
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1400);
  });

  wrap.append(label, link, copy);
  return wrap;
}

/** Ask the server to host the finished file. */
async function hostOnServer(job) {
  await fetch(`/api/jobs/${job.id}/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/**
 * Fetch the finished file back from this server and upload it from the browser.
 * This is the only route that works when the server itself has no outbound
 * network, because the browser usually does.
 */
async function hostFromBrowser(job) {
  if (!window.SqueezeHost) throw new Error('Browser uploader unavailable.');
  if (job.outputBytes > BROWSER_HOST_LIMIT) {
    throw Object.assign(
      new Error(
        `This file is ${formatBytes(job.outputBytes)}; uploading more than 1.5 GB from a browser is unreliable. ` +
          'Download it and upload it yourself, or deploy the app on a host with internet for automatic links.',
      ),
      { code: 'TOO_LARGE' },
    );
  }

  showTransfer(`Downloading the compressed file…`, null, formatBytes(job.outputBytes || 0));
  const res = await fetch(`/api/jobs/${job.id}/download`);
  if (!res.ok) throw new Error('Could not read the compressed file from the server.');
  const blob = await res.blob();

  showTransfer('Uploading to gofile…', 0, formatBytes(blob.size));
  const result = await window.SqueezeHost.upload(
    blob,
    { name: job.outputName || 'video.mp4' },
    {
      onProvider: (provider) => {
        showTransfer(`Uploading to ${provider}…`, 0, formatBytes(blob.size));
      },
      onProgress: ({ sent, total }) => {
        showTransfer('Uploading to a file host…', total ? sent / total : null,
          `${formatBytes(sent)} / ${formatBytes(total)}`);
      },
    },
  );

  await api(`/api/jobs/${job.id}/hosted`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: result.url, provider: result.provider }),
  });
  return result;
}

/** Make sure a finished job ends up with a share link, whichever route works. */
async function ensureHosted(job) {
  if (!state.autoHost || job.hostedUrl) return;
  if (job.status !== 'done' || !job.hasFile) return;

  // If the server already gave up (no outbound route to the hosts), fall back to
  // uploading from this browser, which usually does have a route.
  if (job.hostError) {
    if (state.browserHostTried.has(job.id)) return;
    state.browserHostTried.add(job.id);
    try {
      await hostFromBrowser(job);
    } catch (err) {
      showAlert(`Share link failed: ${err.message}`, 'error');
    } finally {
      hideTransfer();
    }
    return;
  }

  if (state.serverHostTried.has(job.id)) return;
  state.serverHostTried.add(job.id);
  try {
    await hostOnServer(job);
  } catch (err) {
    // The request itself failed; let the next poll try the browser route.
    state.serverHostTried.delete(job.id);
    showAlert(`Share link failed: ${err.message}`, 'error');
  } finally {
    hideTransfer();
  }
}

/* ------------------------------------------------------------------- picker */

const VIDEO_KIND_LABEL = { video: 'video', other: 'file' };

function clearPicker() {
  const existing = document.getElementById('pickerPanel');
  if (existing) existing.remove();
}

/**
 * Show the files found behind a link so one can be chosen.
 * mode 'server'  -> the server downloads it itself
 * mode 'browser' -> your browser fetches the bytes and streams them over
 */
async function startPickerFile(file, { pageUrl, mode, noCompress = false }) {
  if (mode === 'server') {
    const opts = currentOptions();
    const { job } = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'ref',
        ref: file.ref,
        name: file.name,
        pageUrl,
        ...opts,
        ...(noCompress ? { noCompress: true } : {}),
      }),
    });
    return job;
  }
  const direct = await window.SqueezeResolve.directUrl(file.ref);
  return relayBytes(direct, { pageUrl, filename: file.name });
}

/** Total of the sizes we actually know about, or 0 when the host hid them all. */
function knownTotal(files) {
  return files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
}

/**
 * Show the files found behind a link so any number of them can be chosen.
 * mode 'server'  -> the server downloads them itself
 * mode 'browser' -> your browser fetches the bytes and streams them over
 */
function showPicker({ pageUrl, resolver, title, files, mode }) {
  clearPicker();
  const panel = document.createElement('section');
  panel.id = 'pickerPanel';
  panel.className = 'card picker';

  let wantsOriginal = state.noCompress;

  const head = document.createElement('div');
  head.className = 'picker-head';
  const heading = document.createElement('div');
  heading.innerHTML = '<div class="picker-title"></div><div class="picker-sub"></div>';
  $('.picker-title', heading).textContent = title || shortHost(pageUrl) || 'Choose a file';
  const count = files.length;
  const total = knownTotal(files);
  const unknown = files.filter((file) => !Number(file.size)).length;
  $('.picker-sub', heading).textContent =
    `${count} file${count === 1 ? '' : 's'} found` +
    (total ? ` · ${formatBytes(total)} altogether` : '') +
    (unknown && unknown < count ? ` · ${unknown} without a size` : '') +
    ` · ${resolver}` +
    (mode === 'browser' ? ' · fetched through your browser' : '');
  head.append(heading);

  const tools = document.createElement('div');
  tools.className = 'picker-tools';
  const selectAll = document.createElement('button');
  selectAll.type = 'button';
  selectAll.className = 'btn tiny';
  selectAll.textContent = 'Select all';
  tools.append(selectAll);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn tiny';
  close.textContent = 'Dismiss';
  close.addEventListener('click', clearPicker);
  tools.append(close);
  head.append(tools);
  panel.append(head);
  panel.append(modeToggle());

  const list = document.createElement('div');
  list.className = 'picker-list';
  const boxes = [];
  const modeButtons = [];

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'picker-row';

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'picker-check';
    pick.setAttribute('aria-label', `Select ${file.name}`);
    pick.addEventListener('change', () => {
      row.classList.toggle('is-picked', pick.checked);
      updateFooter();
    });
    boxes.push({ pick, file, row });

    const info = document.createElement('div');
    info.className = 'picker-file';
    const name = document.createElement('div');
    name.className = 'picker-name';
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement('div');
    meta.className = 'picker-meta';
    const bits = [];
    /* The size is the thing that decides which file is worth queueing. When a
       host hides it the server probes it, so "unknown" should be rare. */
    bits.push(file.size ? formatBytes(file.size) : 'size unknown');
    bits.push(VIDEO_KIND_LABEL[file.kind] || 'file');
    if (mode === 'browser' && file.size > 1.5 * 1024 ** 3) {
      bits.push('large — your browser downloads it in full first');
    }
    meta.textContent = bits.join(' · ');
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'picker-actions';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn download';
    button.textContent = 'Compress';
    modeButtons.push(button);

    button.addEventListener('click', async () => {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'Starting…';
      setBusy(1);
      try {
        const job = await startPickerFile(file, { pageUrl, mode, noCompress: wantsOriginal });
        trackJob(job);
        clearPicker();
      } catch (err) {
        showAlert(err.message, 'error');
        button.disabled = false;
        button.textContent = original;
      } finally {
        hideTransfer();
        setBusy(-1);
      }
    });

    // Hosts that forbid cross-origin reads can still be fetched by the browser
    // as a normal download. Offer that as a one-click shortcut, then ask for the
    // file back via drag & drop.
    const saveFirst = document.createElement('button');
    saveFirst.type = 'button';
    saveFirst.className = 'btn';
    saveFirst.title = 'Save the original to your device, then drop it on this page';
    saveFirst.textContent = 'Save file';
    saveFirst.addEventListener('click', async () => {
      saveFirst.disabled = true;
      try {
        const direct = await window.SqueezeResolve.directUrl(file.ref);
        const link = document.createElement('a');
        link.href = direct;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.download = file.name || '';
        link.click();
        awaitAfterDownload(file, pageUrl);
      } catch (err) {
        showAlert(err.message, 'error');
      } finally {
        saveFirst.disabled = false;
      }
    });

    actions.append(button, saveFirst);
    row.append(pick, info, actions);
    list.append(row);
  }

  const footer = document.createElement('div');
  footer.className = 'picker-foot';
  const summary = document.createElement('span');
  summary.className = 'picker-count';
  const queueSelected = document.createElement('button');
  queueSelected.type = 'button';
  queueSelected.className = 'btn primary';
  queueSelected.disabled = true;

  /** The per-picker switch: same flag as the composer, kept in sync with it. */
  function modeToggle() {
    const wrap = document.createElement('div');
    wrap.className = 'picker-mode';
    const label = document.createElement('label');
    label.className = 'toggle';
    label.htmlFor = 'pickerNoCompress';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'pickerNoCompress';
    input.checked = wantsOriginal;
    const track = document.createElement('span');
    track.className = 'toggle-track';
    track.setAttribute('aria-hidden', 'true');
    track.innerHTML = '<span class="toggle-thumb"></span>';
    const text = document.createElement('span');
    text.className = 'toggle-text';
    label.append(input, track, text);

    const hint = document.createElement('span');
    hint.className = 'picker-mode-hint';

    const sync = () => {
      wantsOriginal = input.checked;
      text.textContent = wantsOriginal ? 'Just download — no re-encoding' : 'Compress to a smaller file';
      hint.textContent = wantsOriginal
        ? 'The file comes back exactly as the host has it, only re-wrapped to MP4 when it is not one already.'
        : 'Re-encoded to H.264 at 720p or better, and only kept when it is really smaller.';
      for (const button of modeButtons) button.textContent = wantsOriginal ? 'Download' : 'Compress';
      const composer = $('#noCompress');
      if (composer && composer.checked !== wantsOriginal) {
        composer.checked = wantsOriginal;
        state.noCompress = wantsOriginal;
        localStorage.setItem(STORAGE.noCompress, wantsOriginal ? '1' : '0');
        syncComposerMode();
      }
      updateFooter();
    };
    input.addEventListener('change', sync);

    wrap.append(label, hint);
    setTimeout(sync, 0);
    return wrap;
  }

  function updateFooter() {
    const picked = boxes.filter((b) => b.pick.checked);
    const pickedBytes = knownTotal(picked.map((b) => b.file));
    summary.textContent = picked.length
      ? `${picked.length} selected${pickedBytes ? ` · ${formatBytes(pickedBytes)}` : ''}` +
        (picked.length > 1 ? ' · they queue one after another' : '')
      : 'Tick the files you want';
    queueSelected.textContent = picked.length
      ? `${wantsOriginal ? 'Download' : 'Compress'} ${picked.length}`
      : wantsOriginal
        ? 'Download selected'
        : 'Compress selected';
    queueSelected.disabled = !picked.length;
    selectAll.textContent = picked.length === boxes.length ? 'Select none' : 'Select all';
  }

  selectAll.addEventListener('click', () => {
    const turnOn = boxes.some((b) => !b.pick.checked);
    boxes.forEach((b) => {
      b.pick.checked = turnOn;
      b.row.classList.toggle('is-picked', turnOn);
    });
    updateFooter();
  });

  queueSelected.addEventListener('click', async () => {
    const picked = boxes.filter((b) => b.pick.checked).map((b) => b.file);
    if (!picked.length) return;
    queueSelected.disabled = true;
    selectAll.disabled = true;
    setBusy(1);
    let started = 0;
    for (const file of picked) {
      queueSelected.textContent = `Starting ${started + 1}/${picked.length}…`;
      try {
        const job = await startPickerFile(file, { pageUrl, mode, noCompress: wantsOriginal });
        trackJob(job);
        started += 1;
      } catch (err) {
        showAlert(`${file.name}: ${err.message}`, 'error');
      }
    }
    setBusy(-1);
    hideTransfer();
    if (started) clearPicker();
    else {
      queueSelected.disabled = false;
      selectAll.disabled = false;
      updateFooter();
    }
  });

  footer.append(summary, queueSelected);
  panel.append(list, footer);
  updateFooter();
  $('#alert').insertAdjacentElement('beforebegin', panel);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * After the original starts downloading to the device, keep a drop target ready
 * so the user can hand it straight back for compression.
 */
function awaitAfterDownload(file, pageUrl) {
  const existing = document.getElementById('awaitPanel');
  if (existing) existing.remove();

  const panel = document.createElement('section');
  panel.id = 'awaitPanel';
  panel.className = 'card await';
  panel.innerHTML = `
    <div class="await-head">
      <span class="await-dot"></span>
      <span class="await-title">Saving <b></b> to your device…</span>
    </div>
    <div class="await-body">
      When it finishes, drag the file anywhere on this page (or
      <button type="button" class="linkish await-browse">browse</button>) and it will be
      compressed with <b class="await-preset"></b>.
    </div>`;
  panel.querySelector('b').textContent = file.name || 'the video';
  panel.querySelector('.await-preset').textContent = presetOf(currentOptions().presetId).label;
  panel.querySelector('.await-browse').addEventListener('click', () => $('#fileInput').click());
  $('#alert').insertAdjacentElement('beforebegin', panel);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Highlight the drop zone so the next step is obvious.
  $('#dropzone').classList.add('wants-drop');
}

function clearAwait() {
  const panel = document.getElementById('awaitPanel');
  if (panel) panel.remove();
  $('#dropzone')?.classList.remove('wants-drop');
}

/* ------------------------------------------------------------------ actions */

const NETWORKISH = new Set(['BLOCKED', 'NETWORK', 'TIMEOUT', 'UNREACHABLE', 'NEED_BROWSER', 'BOTH_FAILED']);

const PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch',
  'x.com', 'twitter.com', 'vimeo.com', 'dailymotion.com', 'reddit.com', 'twitch.tv',
];

function platformOf(url) {
  const host = shortHost(url);
  return PLATFORM_HOSTS.find((p) => host === p || host.endsWith(`.${p}`)) || null;
}

const firstSentence = (text) => String(text || '').split(/(?<=\.)\s/)[0].replace(/\.$/, '');
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Explain a failure using both the server's and the browser's point of view. */
function describeFailure(url, serverErr, browserErr) {
  const host = shortHost(url) || 'that host';
  const parts = [];

  if (serverErr) {
    parts.push(
      NETWORKISH.has(serverErr.code)
        ? `this server has no internet route to ${host}`
        : firstSentence(serverErr.message).toLowerCase(),
    );
  }
  if (browserErr) {
    parts.push(
      NETWORKISH.has(browserErr.code)
        ? 'your browser could not read it cross-origin either'
        : `your browser reported: ${firstSentence(browserErr.message).toLowerCase()}`,
    );
  }

  let sentence = parts.length === 2
    ? `${capitalise(parts[0])}, and ${parts[1]}.`
    : `${capitalise(parts[0] || 'That link could not be read')}.`;

  const platform = platformOf(url);
  if (platform && state.health && !state.health.platformDownloads) {
    sentence += ` ${capitalise(platform)} links need yt-dlp on the server, which this one does not have.`;
  }

  sentence += ' Open the link, download the file, then drop it here — the compression is identical.';
  return sentence;
}

/** Resolve with the server first, then fall back to resolving in the browser. */
async function resolveLink(url) {
  try {
    const result = await api('/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    return { ...result, mode: 'server' };
  } catch (serverErr) {
    // The server often cannot reach consumer file hosts; browsers usually can.
    if (!window.SqueezeResolve) throw serverErr;
    try {
      const result = await window.SqueezeResolve.resolve(url);
      return { ...result, mode: 'browser' };
    } catch (browserErr) {
      throw Object.assign(new Error(describeFailure(url, serverErr, browserErr)), {
        code: 'BOTH_FAILED',
        href: url,
      });
    }
  }
}

async function handleLink(raw) {
  const url = raw.trim();
  if (!url) return;

  showTransfer('Reading the link…', null, shortHost(url));
  let resolved;
  try {
    resolved = await resolveLink(url);
  } finally {
    hideTransfer();
  }

  const videos = resolved.files.filter((file) => file.kind === 'video');
  const files = videos.length ? videos : resolved.files;

  if (files.length > 1) {
    showPicker({ pageUrl: url, resolver: resolved.resolver, title: resolved.title, files, mode: resolved.mode });
    return;
  }

  const file = files[0];
  let job;
  if (resolved.mode === 'server') {
    ({ job } = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'ref', ref: file.ref, name: file.name, pageUrl: url, ...currentOptions() }),
    }));
  } else {
    const direct = await window.SqueezeResolve.directUrl(file.ref);
    job = await relayBytes(direct, { pageUrl: url, filename: file.name });
  }
  trackJob(job);
}

async function handleFile(file) {
  clearAwait();
  const opts = currentOptions();
  showTransfer(`Sending ${file.name}…`, 0, formatBytes(file.size));

  let job;
  if (file.size > CHUNKED_THRESHOLD) {
    // A 4 GB file as one request is fragile; slice it instead.
    job = await chunkedUpload(file, {
      name: file.name,
      total: file.size,
      label: `Sending ${file.name}…`,
    });
  } else {
    const qs = new URLSearchParams({ name: file.name, presetId: opts.presetId });
    if (opts.targetMb) qs.set('targetMb', String(opts.targetMb));
    if (opts.noCompress) qs.set('noCompress', '1');
    job = await uploadBlob(file, { endpoint: `/api/upload?${qs}`, method: 'POST', name: file.name });
  }

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
  clearPicker();
  clearAwait();
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
      { href: first.err.href || null, hrefLabel: first.err.href ? `Open ${shortHost(first.err.href)}` : undefined },
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
  if (!presets.some((p) => p.id === state.presetId)) {
    // A saved choice from an older version ("tiny", "original") no longer exists.
    state.presetId = presets.some((p) => p.id === 'auto') ? 'auto' : presets[0].id;
    localStorage.setItem(STORAGE.preset, state.presetId);
    for (const other of wrap.children) {
      other.setAttribute('aria-checked', String(other.dataset.preset === state.presetId));
    }
  }
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


/* ------------------------------------------------- disk, auto-stop, results */

const STORAGE_AUTOSTOP = 'squeeze.autoStop';

/** Fill the "Upload to" dropdown with the file hosts this server can reach. */
function renderHostChoices(providers) {
  const pick = $('#hostPick');
  if (!pick) return;
  const saved = localStorage.getItem(STORAGE_HOST) || 'auto';
  const list = Array.isArray(providers) ? providers : [];
  pick.textContent = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'Auto (first that works)';
  pick.append(auto);
  for (const provider of list) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    pick.append(option);
  }
  pick.value = [...pick.options].some((o) => o.value === saved) ? saved : 'auto';
  if (!list.length) pick.disabled = true;
}

function formatDisk(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

/** Header pill: how much room the machine has left. */
function renderDisk(disk) {
  const pill = $('#diskPill');
  const text = $('#diskText');
  if (!pill || !text) return;
  if (!disk || !disk.totalBytes) {
    text.textContent = 'disk unknown';
    return;
  }
  const free = disk.freeBytes;
  const pct = disk.percentFree;
  text.textContent = `${formatDisk(free)} free of ${formatDisk(disk.totalBytes)}`;
  const fill = $('#diskBarFill');
  if (fill) {
    const usedPct = pct == null ? 0 : Math.max(0, Math.min(100, 100 - pct));
    fill.style.width = `${usedPct}%`;
    fill.classList.toggle('is-low', pct != null && pct < 15);
    fill.classList.toggle('is-critical', pct != null && pct < 7);
  }
  pill.title = `${formatDisk(disk.usedBytes)} used · ${formatDisk(free)} free (${pct}%). ` +
    'A video needs about three times its own size while it encodes.';
  pill.classList.toggle('is-low', pct != null && pct < 15);
}

/** Countdown banner shown when the machine is about to stop itself. */
function renderStopBanner(autoStop) {
  let banner = document.getElementById('stopBanner');
  const pending = autoStop && autoStop.stopsAt;
  if (!pending) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'stopBanner';
    banner.className = 'stop-banner';
    banner.innerHTML =
      '<span>Machine stops in <b class="stop-in"></b> to save credit.</span>' +
      '<button type="button" class="btn tiny" id="cancelStop">Keep it running</button>';
    $('#alert').insertAdjacentElement('afterend', banner);
  }
  const seconds = Math.max(0, Math.round((pending - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  banner.querySelector('.stop-in').textContent = minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  const cancel = banner.querySelector('#cancelStop');
  if (cancel && !cancel.dataset.bound) {
    cancel.dataset.bound = '1';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try {
        const { autoStop: next } = await api('/api/auto-stop/cancel', { method: 'POST' });
        renderStopBanner(next);
        showAlert('Staying up. Nothing will stop the machine automatically.', 'ok');
      } catch (err) {
        showAlert(err.message, 'error');
      } finally {
        cancel.disabled = false;
      }
    });
  }
}

async function refreshStatus() {
  try {
    const health = await api('/api/health');
    state.health = health;
    renderDisk(health.disk);
    renderStopBanner(health.autoStop);
    if (health.autoStop) syncAutoStopToggle(health.autoStop);
  } catch {
    /* the server may be busy encoding; try again on the next tick */
  }
}

function syncAutoStopToggle(autoStop) {
  const toggle = $('#autoStop');
  if (!toggle) return;
  toggle.disabled = !autoStop.supported;
  if (document.activeElement !== toggle) toggle.checked = Boolean(autoStop.enabled);
  toggle.title = autoStop.supported
    ? `Runs: ${autoStop.command}`
    : 'No stop command on this machine (set AUTO_STOP_COMMAND or run in Codespaces).';
  $('.switch-text').textContent = autoStop.supported ? 'Stop when done' : 'Stop unavailable';
}

/* ---------------------------------------------------------------- results */

async function loadResults() {
  const section = $('#resultsSection');
  if (!section) return;
  let links = [];
  try {
    ({ links } = await api('/api/links'));
  } catch {
    return;
  }
  const list = $('#resultsList');
  const visible = localStorage.getItem('squeeze.resultsHidden') === '1';
  section.hidden = !links.length || visible;
  list.textContent = '';
  $('#resultsHint').textContent = links.length
    ? `${links.length} share link${links.length === 1 ? '' : 's'} saved · kept on this machine's disk, so they are still here after a restart, a closed tab or a stopped machine.`
    : '';

  for (const link of links) {
    const row = document.createElement('div');
    row.className = 'result-row';

    const main = document.createElement('div');
    main.className = 'result-main';
    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = link.name || 'video.mp4';
    name.title = link.name || '';
    const meta = document.createElement('div');
    meta.className = 'result-meta';
    const bits = [];
    if (link.sourceBytes && link.outputBytes) {
      bits.push(
        link.usedOriginal
          ? `${formatBytes(link.sourceBytes)} · already small, original kept`
          : `${formatBytes(link.sourceBytes)} → ${formatBytes(link.outputBytes)}`,
      );
    }
    const when = link.at ? new Date(link.at) : null;
    if (when && !Number.isNaN(when.getTime())) bits.push(when.toLocaleString());

    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.url;
    meta.append(...(bits.length ? [bits.join(' · ') + ' · '] : []), anchor);
    main.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'result-actions';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn tiny';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link.url);
        copy.textContent = 'Copied';
        setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1400);
      } catch {
        showAlert(link.url, 'ok');
      }
    });
    actions.append(copy);

    row.append(main, actions);
    list.append(row);
  }
}

/**
 * Mail the saved share links to the address the server was set up with.
 *
 * The point of this button is the unattended run: start a queue, tick "stop
 * the machine", close the laptop, and read the links on your phone later. When
 * SMTP is not configured the server hands back a ready-made mailto: so the
 * links still leave the machine, in whatever mail app you already have.
 */
async function emailLinks() {
  const button = $('#emailLinks');
  if (!button || button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const result = await api('/api/links/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (result.ok && result.sent) {
      const count = result.count || 0;
      button.textContent = `Sent · ${count} link${count === 1 ? '' : 's'}`;
      showAlert(`The links are on the way to ${result.to}.`, 'ok', { timeout: 6000 });
    } else if (result.needsConfig && result.mailto) {
      /* No SMTP on this server: open the user's own mail app with the body
         already filled in, and point at the one-time setup that would make the
         mail automatic from now on. Nothing is silently swallowed. */
      const note = $('#emailNote');
      if (note) {
        note.hidden = false;
        const setup = $('#mailSetup');
        if (setup) setup.open = true;
        setMailStatus(result.hint || 'Set this up once and the links are mailed on their own.', '');
      }
      window.location.href = result.mailto;
      button.textContent = 'Opened your mail app';
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 2600);
      return;
    } else if (result.skipped) {
      button.textContent = 'No new links';
      showAlert('Nothing has been hosted since the last mail.', 'ok', { timeout: 5000 });
    } else {
      throw new Error(result.error || 'The mail could not be sent.');
    }
  } catch (err) {
    showAlert(err.message, 'error');
    button.textContent = original;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      if (button.textContent !== original && button.textContent !== 'Sent · 0 links') {
        // leave the confirmation on screen briefly, then restore the label
        setTimeout(() => {
          button.textContent = original;
        }, 2600);
      }
    }, 0);
  }
}

/* -------------------------------------------------- posting the links */

/**
 * Where the links go without email: a gist, a webhook, an ntfy topic or a
 * paste. The button only appears when the server found a sink that works, so it
 * never offers something that cannot succeed.
 */
function renderPublish(info) {
  const note = $('#publishNote');
  const button = $('#publishLinks');
  if (!note || !button) return;
  const ready = (info?.sinks || []).filter((sink) => sink.ready && sink.inChain);
  const last = info?.last;

  if (!ready.length) {
    button.hidden = true;
    /* Nothing to post with: say the one line that would enable it, rather than
       leaving the feature invisible. */
    if (!last?.url && info && info.disabled !== true && $('#resultsList')?.children.length) {
      note.hidden = false;
      note.textContent =
        'Tip: set PUBLISH_WEBHOOK=<your Discord or Slack webhook URL> in .env to have these posted to a channel on every run.';
      return;
    }
    if (last?.url) {
      note.hidden = false;
      note.textContent = '';
      const label = document.createElement('span');
      label.textContent = 'Last posted to ';
      const anchor = document.createElement('a');
      anchor.href = last.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = last.url;
      note.append(label, anchor);
    } else {
      note.hidden = true;
    }
    return;
  }

  button.hidden = false;
  button.title = `Posts every saved link to ${ready.map((sink) => sink.label).join(' or ')}`;
  note.hidden = false;
  note.textContent = '';
  if (last?.url) {
    const label = document.createElement('span');
    label.textContent = 'Already posted to ';
    const anchor = document.createElement('a');
    anchor.href = last.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = last.url;
    note.append(label, anchor);
  } else {
    note.textContent = `Ready to post them to ${ready.map((sink) => sink.label).join(' or ')} on every run.`;
  }
}

async function loadPublishInfo() {
  try {
    const { publish: info } = await api('/api/publish');
    state.publish = info;
    renderPublish(info);
    return info;
  } catch {
    return null;
  }
}

async function postLinks() {
  const button = $('#publishLinks');
  if (!button || button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Posting…';
  try {
    const result = await api('/api/links/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (result.ok) {
      button.textContent = 'Posted';
      showAlert(
        result.url ? `The links are at ${result.url}` : `The links went out via ${result.label}.`,
        'ok',
        { timeout: 8000, href: result.url || null, hrefLabel: result.url ? 'Open them' : undefined },
      );
      await loadPublishInfo();
    } else if (result.reason === 'nothing-to-publish') {
      button.textContent = 'Nothing yet';
      showAlert('There are no saved links to post yet.', 'ok', { timeout: 5000 });
    } else {
      throw new Error(
        (result.tried || []).map((entry) => entry.error || entry.skipped).filter(Boolean).join(' · ') ||
          'No place to post the links was available.',
      );
    }
  } catch (err) {
    showAlert(err.message, 'error');
    button.textContent = original;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      if (button.textContent !== original) {
        setTimeout(() => {
          button.textContent = original;
        }, 3000);
      }
    }, 0);
  }
}

/* ------------------------------------------------------------ mail setup */

/** Paint what the server says about mail into the panel and the results note. */
function renderMail(settings) {
  const summary = $('#mailSummary');
  const chevron = $('.mail-chevron', $('#mailSetup') || document.createElement('div'));
  const note = $('#emailNote');
  const configured = Boolean(settings && settings.configured);

  if (summary) {
    summary.textContent = configured
      ? `Mail: links go to ${settings.to}${settings.source === 'saved' ? '' : ' (from the environment)'}`
      : 'Mail: not set up';
    $('.mail-setup')?.classList.toggle('is-on', configured);
  }
  if (chevron) chevron.textContent = configured ? 'Change' : 'Set up';
  if (note) note.hidden = configured;

  /* Never the password: the form only needs to know that one is stored. */
  if (settings) {
    const host = $('#mailHost');
    if (host && !host.value) host.value = settings.host || '';
    const port = $('#mailPort');
    if (port && settings.port) port.value = String(settings.port);
    const user = $('#mailUser');
    if (user && !user.value) user.value = settings.user || '';
    const to = $('#mailTo');
    if (to && !to.value) to.value = settings.to || '';
    const pass = $('#mailPass');
    if (pass) {
      pass.value = '';
      pass.placeholder = settings.hasPassword
        ? 'saved — leave blank to keep it'
        : 'abcd efgh ijkl mnop';
    }
  }
}

async function loadMailSettings() {
  try {
    const { settings } = await api('/api/email/settings');
    state.mail = settings;
    renderMail(settings);
    return settings;
  } catch {
    return null;
  }
}

function setMailStatus(text, kind = '') {
  const el = $('#mailStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = `mail-status${kind ? ` is-${kind}` : ''}`;
}

/**
 * Save the form, then prove it works by sending a test mail — saving an app
 * password that silently does not authenticate is the failure this panel exists
 * to prevent, and only a real conversation with the server can tell.
 */
async function saveMailSettings({ test = true } = {}) {
  const payload = {
    host: $('#mailHost').value.trim(),
    port: Number($('#mailPort').value) || 587,
    user: $('#mailUser').value.trim(),
    to: $('#mailTo').value.trim(),
    pass: $('#mailPass').value,
  };
  if (!payload.host) {
    setMailStatus('A mail server is needed (smtp.gmail.com for Gmail).', 'error');
    $('#mailHost').focus();
    return null;
  }
  if (!payload.to) {
    setMailStatus('An address to send the links to is needed.', 'error');
    $('#mailTo').focus();
    return null;
  }
  setMailStatus('Saving…');
  let settings;
  try {
    ({ settings } = await api('/api/email/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  } catch (err) {
    setMailStatus(err.message, 'error');
    return null;
  }
  state.mail = settings;
  renderMail(settings);
  if (!test) {
    setMailStatus('Saved.', 'ok');
    return settings;
  }
  setMailStatus('Saved. Sending a test mail…');
  try {
    const result = await api('/api/email/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: settings.to }),
    });
    setMailStatus(`Working — a test mail is on its way to ${result.to}.`, 'ok');
  } catch (err) {
    setMailStatus(`Saved, but the test failed: ${err.message}`, 'error');
  }
  return settings;
}

/** The links panel is the durable record: refresh it whenever something lands. */
let resultsRefresh = null;
function scheduleResultsRefresh() {
  if (resultsRefresh) clearTimeout(resultsRefresh);
  resultsRefresh = setTimeout(() => {
    resultsRefresh = null;
    loadResults();
  }, 1200);
}

function bindStickyHeader() {
  const header = $('#siteHeader');
  if (!header) return;
  const onScroll = () => header.classList.toggle('is-compact', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

async function boot() {
  bindDropzone();
  bindStickyHeader();
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
  const modeToggle = $('#noCompress');
  if (modeToggle) {
    modeToggle.checked = state.noCompress;
    modeToggle.addEventListener('change', () => {
      state.noCompress = modeToggle.checked;
      localStorage.setItem(STORAGE.noCompress, state.noCompress ? '1' : '0');
      syncComposerMode();
    });
    syncComposerMode();
  }

  $('#emailLinks')?.addEventListener('click', emailLinks);
  $('#publishLinks')?.addEventListener('click', postLinks);

  const mailForm = $('#mailForm');
  mailForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#mailSave');
    if (button) button.disabled = true;
    try {
      await saveMailSettings({ test: true });
    } finally {
      if (button) button.disabled = false;
    }
  });
  $('#mailTest')?.addEventListener('click', async () => {
    const button = $('#mailTest');
    if (button) button.disabled = true;
    setMailStatus('Sending a test mail…');
    try {
      const result = await api('/api/email/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: $('#mailTo').value.trim() || undefined }),
      });
      setMailStatus(`A test mail is on its way to ${result.to}.`, 'ok');
    } catch (err) {
      setMailStatus(err.message, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  });
  $('#mailForget')?.addEventListener('click', async () => {
    setMailStatus('Removing…');
    try {
      const { settings } = await api('/api/email/settings', { method: 'DELETE' });
      state.mail = settings;
      renderMail(settings);
      setMailStatus('Removed. The links panel falls back to your own mail app.', 'ok');
    } catch (err) {
      setMailStatus(err.message, 'error');
    }
  });

  const autoToggle = $('#autoHost');
  autoToggle.checked = state.autoHost;
  autoToggle.addEventListener('change', () => {
    state.autoHost = autoToggle.checked;
    localStorage.setItem(STORAGE.autoHost, autoToggle.checked ? '1' : '0');
  });

  $('#targetMb').addEventListener('blur', () => {
    const v = Number($('#targetMb').value);
    if (v > 0) $('#targetMb').value = Math.max(1, Math.min(2000, Math.round(v)));
  });

  try {
    const health = await api('/api/health');
    state.health = health;
    if (!localStorage.getItem(STORAGE.preset) && health.defaultPreset) state.presetId = health.defaultPreset;
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
    renderHostChoices(health.hosters);
  } catch {
    renderPresets([
      { id: 'auto', label: 'Recommended', hint: 'best quality it can afford' },
      { id: 'high', label: 'High quality', hint: 'full resolution' },
      { id: 'balanced', label: 'Smaller', hint: 'up to 1080p' },
      { id: 'small', label: 'Smallest', hint: 'up to 720p' },
    ]);
    $('#engineText').textContent = 'engine unavailable';
  }

  // Disk meter, auto-stop countdown, mail setup and the results list.
  await refreshStatus();
  await loadMailSettings();
  await loadResults();
  await loadPublishInfo();
  setInterval(refreshStatus, Number(localStorage.getItem('squeeze.statusMs')) || 15000);
  setInterval(loadResults, 30000);

  const hostPick = $('#hostPick');
  if (hostPick) {
    hostPick.addEventListener('change', () => {
      localStorage.setItem(STORAGE_HOST, hostPick.value);
      showAlert(
        hostPick.value === 'auto'
          ? 'Finished files go to the first host that accepts them.'
          : `Finished files go to ${hostPick.options[hostPick.selectedIndex].textContent}.`,
        'ok',
      );
    });
  }

  const autoStopToggle = $('#autoStop');
  if (autoStopToggle) {
    autoStopToggle.addEventListener('change', async () => {
      autoStopToggle.disabled = true;
      try {
        const { autoStop } = await api('/api/auto-stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: autoStopToggle.checked }),
        });
        localStorage.setItem(STORAGE_AUTOSTOP, autoStopToggle.checked ? '1' : '0');
        syncAutoStopToggle(autoStop);
        renderStopBanner(autoStop);
        showAlert(
          autoStop.enabled
            ? `The machine will stop ${autoStop.delaySeconds}s after the queue finishes.`
            : 'Auto-stop is off.',
          'ok',
        );
      } catch (err) {
        autoStopToggle.checked = !autoStopToggle.checked;
        showAlert(err.message, 'error');
      } finally {
        autoStopToggle.disabled = false;
      }
    });
  }

  const copyAll = $('#copyAllLinks');
  if (copyAll) {
    copyAll.addEventListener('click', async () => {
      try {
        const text = await (await fetch('/api/links.txt')).text();
        if (!text.trim()) return showAlert('No share links yet — a link appears here once a video is uploaded.', 'error');
        await navigator.clipboard.writeText(text);
        showAlert('All share links copied.', 'ok');
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });
  }

  const saveLinks = $('#saveLinks');
  if (saveLinks) {
    saveLinks.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = '/api/links.txt';
      link.download = 'squeeze-links.txt';
      link.click();
    });
  }

  const toggleResults = $('#toggleResults');
  if (toggleResults) {
    toggleResults.addEventListener('click', () => {
      const hidden = localStorage.getItem('squeeze.resultsHidden') === '1';
      localStorage.setItem('squeeze.resultsHidden', hidden ? '0' : '1');
      loadResults();
      if (!$('#resultsSection').hidden) $('#resultsSection').scrollIntoView({ behavior: 'smooth' });
    });
  }

  if (localStorage.getItem(STORAGE_AUTOSTOP) === '1' && $('#autoStop') && !$('#autoStop').disabled) {
    $('#autoStop').checked = true;
  }

  restoreJobs();
}

document.addEventListener('DOMContentLoaded', boot);
