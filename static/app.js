const form = document.querySelector('#video-form');
const urlInput = document.querySelector('#url');
const submit = document.querySelector('#submit');
const message = document.querySelector('#message');
const panel = document.querySelector('#job-panel');
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
  try { urlInput.value = await navigator.clipboard.readText(); urlInput.focus(); }
  catch { showError('Clipboard access is unavailable. Paste your link into the field instead.'); urlInput.focus(); }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearTimeout(pollTimer);
  message.hidden = true;
  panel.hidden = true;
  submit.disabled = true;
  submit.querySelector('span').textContent = 'Getting things ready…';
  try {
    const response = await fetch('/api/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: urlInput.value.trim(), preset: new FormData(form).get('preset')})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start your video.');
    sessionStorage.setItem('clipwell-job', data.id);
    renderJob(data);
    poll(data.id);
  } catch (error) { showError(error.message); resetButton(); }
});
function resetButton() { submit.disabled = false; submit.querySelector('span').textContent = 'Make my video smaller'; }
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
function renderJob(job) {
  panel.hidden = false;
  if (job.stage === 'error') {
    panel.innerHTML = `<h3>We couldn’t finish this video</h3><p>${escapeHTML(job.error || 'Please try another link.')}</p>`;
    return;
  }
  if (job.stage === 'done') {
    const change = job.source_size ? Math.round((1 - job.output_size / job.source_size) * 100) : 0;
    const result = change > 0 ? `${change}% smaller` : 'Output is not smaller';
    panel.innerHTML = `<h3>Your video is ready ✨</h3><p>${escapeHTML(job.title || 'Video')} · ${result}</p><div class="result-stats"><span>Original <strong>${formatBytes(job.source_size)}</strong></span><span>Compressed <strong>${formatBytes(job.output_size)}</strong></span></div>${change <= 0 ? '<p class="warning">This source may already be efficiently compressed. Try a smaller-file preset.</p>' : ''}<a class="download-button" href="/api/jobs/${encodeURIComponent(job.id)}/download">Download MP4 ↓</a> <button class="delete-button" type="button">Delete from server</button>`;
    panel.querySelector('.delete-button').addEventListener('click', () => deleteJob(job.id));
    return;
  }
  const labels = {queued: ['Getting ready', 'Starting your video…'], downloading: ['Downloading your video', 'Getting the best available source. This may take a while.'], preparing: ['Preparing your video', 'Putting the downloaded streams together.'], compressing: ['Making it smaller', 'Encoding for quality. Larger videos can take some time.']};
  const [title, description] = labels[job.stage] || labels.queued;
  const progress = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : null;
  panel.innerHTML = `<h3>${title}${progress === null ? '…' : ` · ${progress}%`}</h3><p>${description}</p><div class="progress-track" role="progressbar" aria-label="${title}" ${progress === null ? '' : `aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"`}><div class="progress-bar ${progress === null ? 'indeterminate' : ''}" style="${progress === null ? '' : `width:${progress}%`}"></div></div>`;
}

async function deleteJob(id) {
  if (!confirm('Delete this result from the server? Download it first if you want to keep it.')) return;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {method: 'DELETE'});
    if (!response.ok) throw new Error('Could not delete the result. Please try again.');
    sessionStorage.removeItem('clipwell-job');
    panel.innerHTML = '<h3>Deleted from server</h3><p>You can start another video when you are ready.</p>';
  } catch (error) { showError(error.message); }
}

// Reconnect to the job after a refresh in the same tab, if the server is still running.
const savedJob = sessionStorage.getItem('clipwell-job');
if (savedJob) {
  submit.disabled = true;
  submit.querySelector('span').textContent = 'Checking your video…';
  poll(savedJob);
}
