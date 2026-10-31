'use strict';

/* ------------------------------------------------------------------ helpers */

const $ = (sel, root = document) => root.querySelector(sel);

const STORAGE = {
  preset: 'squeeze.preset',
  jobs: 'squeeze.jobs',
  autoHost: 'squeeze.autohost',
};

const state = {
  health: null,
  presets: [],
  presetId: localStorage.getItem(STORAGE.preset) || 'high',
  autoHost: localStorage.getItem(STORAGE.autoHost) !== '0',
  hostedAttempts: new Set(),
  jobs: new Map(), // id -> { el, data, es }
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
  el.className = `alert ${kind === 'info' ? 'info' : ''}`;
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
      statusText = `Compressed · ${formatBytes(before)} → ${formatBytes(after)}${saved > 0.02 ? ` (−${Math.round(saved * 100)}%)` : ''}`;
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
      statusText = `Link ready · ${formatBytes(before)} → ${formatBytes(after)}${saved > 0.02 ? ` (−${Math.round(saved * 100)}%)` : ''}`;
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
  }
  if (job.status === 'done' && job.sourceBytes && job.outputBytes) {
    const saved = Math.max(0, 1 - job.outputBytes / job.sourceBytes);
    if (saved > 0.02) bits.push(`<span class="saved">saved ${formatBytes(job.sourceBytes - job.outputBytes)}</span>`);
  }
  if (job.source === 'relay') bits.push('via your browser');
  metaEl.innerHTML = bits.join('<span style="opacity:.3">·</span>');
  metaEl.style.display = bits.length ? '' : 'none';

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
        await hostOnServer(job);
      } catch {
        try {
          await hostFromBrowser(job);
        } catch (err) {
          showAlert(err.message, 'error');
        }
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
  if (!state.autoHost || job.hostedUrl || state.hostedAttempts.has(job.id)) return;
  if (job.status !== 'done' || !job.hasFile) return;

  state.hostedAttempts.add(job.id);
  try {
    // The server may already be able to do it itself.
    if (state.health?.autoHost && !job.hostError) {
      await hostOnServer(job);
      return;
    }
    if (job.hostError || state.health?.autoHost === false) {
      await hostFromBrowser(job);
    } else {
      await hostOnServer(job);
    }
  } catch (err) {
    state.hostedAttempts.delete(job.id);
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
function showPicker({ pageUrl, resolver, title, files, mode }) {
  clearPicker();
  const panel = document.createElement('section');
  panel.id = 'pickerPanel';
  panel.className = 'card picker';

  const head = document.createElement('div');
  head.className = 'picker-head';
  const heading = document.createElement('div');
  heading.innerHTML = '<div class="picker-title"></div><div class="picker-sub"></div>';
  $('.picker-title', heading).textContent = title || shortHost(pageUrl) || 'Choose a file';
  const count = files.length;
  $('.picker-sub', heading).textContent =
    `${count} file${count === 1 ? '' : 's'} found · ${resolver}` +
    (mode === 'browser' ? ' · fetched through your browser' : '');
  head.append(heading);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn tiny';
  close.textContent = 'Dismiss';
  close.addEventListener('click', clearPicker);
  head.append(close);
  panel.append(head);

  const list = document.createElement('div');
  list.className = 'picker-list';

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'picker-row';

    const info = document.createElement('div');
    info.className = 'picker-file';
    const name = document.createElement('div');
    name.className = 'picker-name';
    name.textContent = file.name;
    name.title = file.name;
    const meta = document.createElement('div');
    meta.className = 'picker-meta';
    const bits = [];
    if (file.size) bits.push(formatBytes(file.size));
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

    button.addEventListener('click', async () => {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'Starting…';
      setBusy(1);
      try {
        let job;
        if (mode === 'server') {
          const opts = currentOptions();
          ({ job } = await api('/api/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              source: 'ref',
              ref: file.ref,
              name: file.name,
              pageUrl,
              ...opts,
            }),
          }));
        } else {
          const direct = await window.SqueezeResolve.directUrl(file.ref);
          job = await relayBytes(direct, { pageUrl, filename: file.name });
        }
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
    row.append(info, actions);
    list.append(row);
  }

  panel.append(list);
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
