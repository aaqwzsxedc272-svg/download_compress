'use strict';

const id = location.pathname.split('/').filter(Boolean).pop();
const $ = (sel) => document.querySelector(sel);

const PRESET_LABELS = {
  tiny: 'Tiny · 360p',
  small: 'Small · 480p',
  balanced: 'Balanced · 720p',
  high: 'High · 1080p',
  original: 'Original resolution',
};

function formatBytes(bytes) {
  if (!bytes) return '—';
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
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function stat(label, value, good = false) {
  const el = document.createElement('div');
  el.className = 'stat';
  el.innerHTML = `<div class="k">${label}</div><div class="v ${good ? 'good' : ''}"></div>`;
  el.querySelector('.v').textContent = value;
  return el;
}

function render(job) {
  const done = job.status === 'done';
  const failed = job.status === 'error';
  const pct = Math.round((job.progress || 0) * 100);

  document.title = job.status === 'done'
    ? `${job.outputName || 'Video'} — Squeeze`
    : 'Squeezing… — Squeeze';

  $('#jobName').textContent = job.name || (job.url ? job.url.split('/').pop() : 'Video');
  $('#jobBadge').textContent = job.targetMb ? `${job.targetMb} MB target` : PRESET_LABELS[job.presetId] || job.presetId;

  const sub = [];
  if (job.meta?.width) sub.push(`${job.meta.width}×${job.meta.height}`);
  if (formatDuration(job.meta?.duration)) sub.push(formatDuration(job.meta.duration));
  if (job.url) {
    try {
      sub.push(new URL(job.url).hostname.replace(/^www\./, ''));
    } catch {
      /* not a parseable url */
    }
  }
  $('#jobSub').textContent = sub.join('  ·  ');

  const progress = $('#jobProgress');
  const bar = $('#jobProgressBar');
  if (!done && !failed) {
    progress.style.display = '';
    bar.style.width = job.progress > 0 ? `${pct}%` : '34%';
    progress.classList.toggle('is-indeterminate', !(job.progress > 0));
  } else {
    progress.style.display = 'none';
  }

  // player / status area
  const slot = $('#playerSlot');
  if (done && job.hasFile) {
    if (!slot.querySelector('video')) {
      const video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = `/api/jobs/${job.id}/preview`;
      video.style.cssText = 'width:100%;height:100%;display:block;background:#000;object-fit:contain';
      slot.innerHTML = '';
      slot.style.position = 'relative';
      slot.append(video);
    }
  } else if (failed) {
    slot.innerHTML = `<div style="text-align:center;padding:24px;max-width:520px">
      <div style="font-size:15px;color:var(--danger);margin-bottom:6px">Couldn't finish this one</div>
      <div class="err-text" style="color:var(--muted);font-size:13.5px"></div>
      <a class="btn" style="margin-top:16px;display:inline-flex" href="/">Try another video</a>
    </div>`;
    $('.err-text').textContent = job.error || 'Unknown error';
  } else {
    const label = job.status === 'compressing'
      ? `Compressing · ${pct}%${job.speed ? ` · ${job.speed.toFixed(1)}×` : ''}`
      : job.stage || 'Working…';
    const statusEl = $('#playerStatus');
    if (statusEl) statusEl.textContent = label;
    if (!slot.querySelector('.spinner')) {
      slot.innerHTML = `<div style="text-align:center;padding:24px">
        <div class="spinner" style="margin:0 auto 14px"></div>
        <div id="playerStatus" style="color:var(--muted);font-size:14px">${label}</div>
      </div>`;
    }
  }

  // stats
  const stats = $('#statRow');
  stats.innerHTML = '';
  if (job.meta) {
    stats.append(
      stat('Original', formatBytes(job.sourceBytes)),
      stat('Compressed', done ? formatBytes(job.outputBytes) : '…', done),
    );
    const saved = job.sourceBytes && job.outputBytes ? Math.max(0, 1 - job.outputBytes / job.sourceBytes) : 0;
    if (done && saved > 0.01) stats.append(stat('Saved', `${Math.round(saved * 100)}%`, true));
    if (job.meta.videoCodec) stats.append(stat('Source codec', job.meta.videoCodec));
    if (job.meta.fps) stats.append(stat('Frame rate', `${job.meta.fps} fps`));
    if (job.status === 'compressing' && formatDuration(job.etaSeconds)) {
      stats.append(stat('Time left', formatDuration(job.etaSeconds)));
    }
  }

  // actions
  const actions = $('#detailActions');
  actions.innerHTML = '';
  if (done && job.hasFile) {
    const dl = document.createElement('a');
    dl.className = 'btn download';
    dl.href = `/api/jobs/${job.id}/download`;
    dl.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Download ${job.outputName ? '' : 'video'}`;
    actions.append(dl);

    const again = document.createElement('a');
    again.className = 'btn';
    again.href = '/';
    again.textContent = 'Squeeze another';
    actions.append(again);
  }

  const note = $('#jobNote');
  if (job.note) {
    note.style.display = '';
    note.textContent = job.note;
  } else {
    note.style.display = 'none';
  }
}

async function poll() {
  try {
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) throw new Error('gone');
    const { job } = await res.json();
    render(job);
    return job.status === 'done' || job.status === 'error';
  } catch {
    $('#playerSlot').innerHTML = `<div style="text-align:center;padding:24px">
      <div style="font-size:15px;margin-bottom:6px">This video isn't here anymore</div>
      <div style="color:var(--muted);font-size:13.5px">Compressed files are deleted after a few hours.</div>
      <a class="btn" style="margin-top:16px;display:inline-flex" href="/">Start over</a>
    </div>`;
    return true;
  }
}

async function start() {
  const finished = await poll();
  if (finished) return;
  const es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (event) => {
    try {
      const job = JSON.parse(event.data);
      render(job);
      if (job.status === 'done' || job.status === 'error') es.close();
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    es.close();
    poll();
  };
}

start();
