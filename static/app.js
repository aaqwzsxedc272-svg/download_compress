const form = document.querySelector('#video-form');
const urlInput = document.querySelector('#url');
const submit = document.querySelector('#submit');
const message = document.querySelector('#message');
const panel = document.querySelector('#job-panel');
const inspectButton = document.querySelector('#inspect');
const previewPanel = document.querySelector('#preview-panel');
let previewData = [];
let pollTimer;

function escapeHTML(value) {
  const node = document.createElement('div');
  node.textContent = value;
  return node.innerHTML;
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function showError(text) { message.textContent = text; message.hidden = false; }

document.querySelector('#paste').addEventListener('click', async () => {
  try { urlInput.value = await navigator.clipboard.readText(); urlInput.dispatchEvent(new Event('input', {bubbles: true})); urlInput.focus(); }
  catch { showError('Clipboard access is unavailable. Paste your link into the field instead.'); urlInput.focus(); }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearTimeout(pollTimer);
  message.hidden = true;
  panel.hidden = true;
  const urls = urlInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!urls.length || urls.length > 20) { showError('Enter between 1 and 20 links, one per line.'); return; }
  submit.disabled = true;
  inspectButton.disabled = true;
  submit.querySelector('span').textContent = 'Getting things ready…';
  if (urls.length > 1) { await runBatch(urls, new FormData(form).get('preset')); return; }
  try {
    const response = await fetch('/api/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: urls[0], preset: new FormData(form).get('preset')})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start your video.');
    sessionStorage.setItem('clipwell-job', data.id);
    renderJob(data);
    poll(data.id);
  } catch (error) { showError(error.message); resetButton(); }
});
inspectButton.addEventListener('click', async () => {
  const urls = urlInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!urls.length || urls.length > 20) { showError('Enter between 1 and 20 links, one per line.'); return; }
  message.hidden = true;
  inspectButton.disabled = true;
  submit.disabled = true;
  previewData = [];
  previewPanel.hidden = false;
  try {
    for (let i = 0; i < urls.length; i++) {
      previewPanel.innerHTML = `<p>Checking video ${i + 1} of ${urls.length}…</p>`;
      const response = await fetch('/api/inspect', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: urls[i], preset: new FormData(form).get('preset')})});
      const data = await response.json();
      previewData.push(response.ok ? data : {error: data.error || 'Preview unavailable.'});
    }
    renderPreviews();
  } catch (error) { showError('Could not check the links. You can still try processing them.'); }
  finally { inspectButton.disabled = false; submit.disabled = false; }
});
form.querySelectorAll('[name="preset"]').forEach(input => input.addEventListener('change', () => { if (previewData.length) renderPreviews(); }));
urlInput.addEventListener('input', () => { previewData = []; previewPanel.hidden = true; });

function estimateScenario(info, preset) {
  const ranges = {high: [0.08, 0.20], balanced: [0.035, 0.12], small: [0.018, 0.065]};
  const width = info.width, height = info.height, duration = info.duration;
  const fps = info.fps || 30;
  if (![width, height, duration, fps].every(value => Number.isFinite(value) && value > 0) || width > 16384 || height > 16384 || fps > 240 || duration > 604800) return null;
  return ranges[preset].map(bpp => (width * height * fps * bpp + 192000) * duration / 8);
}
function renderPreviews() {
  const preset = new FormData(form).get('preset');
  const labels = {high: 'Highest quality · CRF 18', balanced: 'Balanced · CRF 23', small: 'Smallest file · CRF 28'};
  previewPanel.innerHTML = previewData.map((info, index) => {
    if (info.error) return `<div class="preview-card"><strong>Video ${index + 1}</strong><p>${escapeHTML(info.error)}</p></div>`;
    const resolution = info.width && info.height ? `${info.width} × ${info.height}` : info.height ? `${info.height}p` : 'Not available';
    const scenario = estimateScenario(info, preset);
    const estimate = scenario ? `${formatBytes(scenario[0])} – ${formatBytes(scenario[1])}` : 'Not enough metadata to estimate';
    return `<div class="preview-card"><div class="preview-kicker">VIDEO ${index + 1}</div><h3>${escapeHTML(info.title || 'Video')}</h3><div class="preview-grid"><span>Source size<strong>${formatBytes(info.source_size)}${info.source_size_approx ? ' (approx.)' : ''}</strong></span><span>Source quality<strong>${escapeHTML(resolution)} · ${escapeHTML(info.codec || 'Codec unknown')}</strong></span><span>Duration<strong>${info.duration ? formatTime(info.duration) : 'Not available'}</strong></span></div><div class="preview-estimate"><span>Potential output · ${labels[preset]}</span><strong>${estimate}</strong><p>${scenario ? `Illustrative bitrate scenario${info.fps ? '' : ', assuming 30 fps'}—not a CRF prediction. The final file can be outside this range or larger than the source.` : 'Resolution and duration are needed for a scenario. Final size is known after encoding.'}</p></div></div>`;
  }).join('');
}

function resetButton() { submit.disabled = false; inspectButton.disabled = false; submit.querySelector('span').textContent = 'Make my video smaller'; }
async function poll(id) {
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    const job = await response.json();
    if (!response.ok) {
      if (response.status === 404) sessionStorage.removeItem('clipwell-job');
      throw new Error(job.error || 'Could not check progress.');
    }
    renderJob(job);
    if (job.stage !== 'done' && job.stage !== 'error') pollTimer = setTimeout(() => poll(id), 1500);
    else {
      if (job.stage === 'error') sessionStorage.removeItem('clipwell-job');
      resetButton();
    }
  } catch (error) { showError(error.message); resetButton(); }
}
function renderJob(job, target = panel) {
  panel.hidden = false;
  if (job.stage === 'error') {
    target.innerHTML = `<h3>We couldn’t finish this video</h3><p>${escapeHTML(job.error || 'Please try another link.')}</p>`;
    return;
  }
  if (job.stage === 'done') {
    const change = job.source_size ? Math.round((1 - job.output_size / job.source_size) * 100) : 0;
    const result = change > 0 ? `${change}% smaller` : 'Output is not smaller';
    target.innerHTML = `<h3>Your video is ready ✨</h3><p>${escapeHTML(job.title || 'Video')} · ${result}</p><div class="result-stats"><span>Original <strong>${formatBytes(job.source_size)}</strong></span><span>Compressed <strong>${formatBytes(job.output_size)}</strong></span></div>${change <= 0 ? '<p class="warning">This source may already be efficiently compressed. Try a smaller-file preset.</p>' : ''}<a class="download-button" href="/api/jobs/${encodeURIComponent(job.id)}/download">Download MP4 ↓</a> <button class="delete-button" type="button">Delete from server</button>`;
    target.querySelector('.delete-button').addEventListener('click', () => deleteJob(job.id, target));
    return;
  }
  const labels = {queued: ['Getting ready', 'Starting your video…'], downloading: ['Downloading your video', 'Getting the best available source. This may take a while.'], preparing: ['Preparing your video', 'Putting the downloaded streams together.'], compressing: ['Making it smaller', 'Encoding for quality. Larger videos can take some time.']};
  const [title, description] = labels[job.stage] || labels.queued;
  const progress = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : null;
  const eta = Number.isFinite(job.eta_seconds) && job.eta_seconds >= 0 ? ` · About ${formatTime(job.eta_seconds)} left in this stage` : '';
  target.innerHTML = `<h3>${title}${progress === null ? '…' : ` · ${progress}%`}</h3><p>${description}${eta}</p><div class="progress-track" role="progressbar" aria-label="${title}" ${progress === null ? '' : `aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"`}><div class="progress-bar ${progress === null ? 'indeterminate' : ''}" style="${progress === null ? '' : `width:${progress}%`}"></div></div>`;
}

async function deleteJob(id, target = panel) {
  if (!confirm('Delete this result from the server? Download it first if you want to keep it.')) return;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {method: 'DELETE'});
    if (!response.ok) throw new Error('Could not delete the result. Please try again.');
    if (sessionStorage.getItem('clipwell-job') === id) sessionStorage.removeItem('clipwell-job');
    target.innerHTML = '<h3>Deleted from server</h3><p>You can start another video when you are ready.</p>';
  } catch (error) { showError(error.message); }
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

async function runBatch(urls, preset) {
  panel.hidden = false;
  panel.innerHTML = '<h3>Video queue</h3><p>One at a time. Keep this tab open; refreshing loses the remaining queue.</p>';
  const items = urls.map((_, index) => {
    const container = document.createElement('div');
    container.className = 'batch-item';
    container.innerHTML = `<p class="batch-label">VIDEO ${index + 1} / ${urls.length}</p><div class="batch-status"><p>Waiting in queue…</p></div>`;
    panel.appendChild(container);
    return container.querySelector('.batch-status');
  });
  try {
    for (let index = 0; index < urls.length; index++) {
      const target = items[index];
      target.innerHTML = '<h3>Starting…</h3>';
      const response = await fetch('/api/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: urls[index], preset})});
      const job = await response.json();
      if (!response.ok) { renderJob({stage: 'error', error: job.error}, target); continue; }
      sessionStorage.setItem('clipwell-job', job.id);
      let current = job;
      renderJob(current, target);
      while (current.stage !== 'done' && current.stage !== 'error') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const status = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`);
        current = await status.json();
        if (!status.ok) throw new Error(current.error || 'Could not check progress.');
        renderJob(current, target);
      }
    }
  } catch (error) {
    showError(`${error.message} The remaining queue was stopped; refresh to reconnect to the active video.`);
  } finally { resetButton(); }
}

// Reconnect to the job after a refresh in the same tab, if the server is still running.
const savedJob = sessionStorage.getItem('clipwell-job');
if (savedJob) {
  submit.disabled = true;
  inspectButton.disabled = true;
  submit.querySelector('span').textContent = 'Checking your video…';
  poll(savedJob);
}
