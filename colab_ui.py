"""Inline Colab widgets; processing stays in the notebook runtime, not a web server."""
from html import escape
from pathlib import Path
from shutil import move, copyfileobj
import os
import threading
import time
import uuid
from urllib.parse import urlparse

import ipywidgets as widgets
from IPython.display import display

import app
import filehosts
import video_info

PRESET_TEXT = {
    'high': 'CRF 18 · more detail, usually larger',
    'balanced': 'CRF 23 · a quality and size compromise',
    'small': 'CRF 28 · smaller output may show more artifacts',
}


def size_label(value):
    if value is None:
        return 'Not available'
    amount = float(value)
    for unit in ('B', 'KiB', 'MiB', 'GiB', 'TiB'):
        if amount < 1024 or unit == 'TiB':
            return f'{amount:.1f} {unit}' if unit != 'B' else f'{int(amount)} B'
        amount /= 1024


def duration_label(seconds):
    if seconds is None:
        return 'Not available'
    total = int(seconds)
    return f'{total // 3600}:{(total % 3600) // 60:02d}:{total % 60:02d}'


def preview_html(index, url, info, preset):
    host = escape(urlparse(url).hostname or 'Video')
    title = escape(str(info.get('title') or 'Video'))
    height, width = info.get('height'), info.get('width')
    resolution = f'{int(width)} × {int(height)}' if width and height else (f'{int(height)}p' if height else 'Not available')
    codec = escape(info.get('codec') or 'Not available')
    source_size = size_label(info.get('source_size'))
    if info.get('source_size_approx'):
        source_size += ' (approx.)'
    estimate = video_info.estimate_output(info, preset)
    if estimate:
        fps_note = 'Assumes 30 fps and' if estimate['assumed_fps'] else f"Assumes {estimate['fps']:g} fps and"
        estimate_html = (f"<b>{size_label(estimate['min_bytes'])} – {size_label(estimate['max_bytes'])}</b>"
                         f"<div class='cw-fine'>{fps_note} typical bitrates. Very rough scenario, not a CRF prediction; "
                         'the final file can be outside this range or larger than the source.</div>')
    else:
        estimate_html = '<b>Not enough metadata to estimate</b><div class="cw-fine">Duration and resolution are needed; the final size is known only after encoding.</div>'
    return (f"<div class='cw-card'><div class='cw-card-title'>VIDEO {index} · {host}</div><h3>{title}</h3>"
            f"<div class='cw-grid'><div><span>Source size</span><strong>{source_size}</strong></div>"
            f"<div><span>Source quality</span><strong>{resolution} · {codec}</strong></div>"
            f"<div><span>Duration</span><strong>{duration_label(info.get('duration'))}</strong></div></div>"
            f"<div class='cw-estimate'><span>Potential output · {escape(PRESET_TEXT[preset])}</span>{estimate_html}</div></div>")


def drive_available(mount_root):
    """Fail closed: a local /content/drive directory is not a Drive mount."""
    return os.path.ismount(mount_root) and (Path(mount_root) / 'MyDrive').is_dir()


def save_to_drive(source, mount_root):
    """Copy a finished MP4 to an opted-in mounted Drive; never publish partial files."""
    if not drive_available(mount_root):
        raise RuntimeError('Google Drive is not connected. Run the Connect Google Drive cell first.')
    directory = Path(mount_root) / 'MyDrive' / 'Clipwell'
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / Path(source).name
    if destination.exists():
        raise RuntimeError('A result with that name already exists in Google Drive.')
    temporary = directory / f'.{destination.name}.{uuid.uuid4().hex}.partial'
    try:
        with Path(source).open('rb') as src, temporary.open('xb') as dst:
            copyfileobj(src, dst, length=1024 * 1024)
            dst.flush()
            os.fsync(dst.fileno())
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return destination


class ClipwellUI:
    def __init__(self, download, output_dir='/content', drive_root='/content/drive', start_in_cell=False):
        self.download = download
        self.output_dir = Path(output_dir)
        self.drive_root = Path(drive_root)
        self.metadata = []
        self.input_urls = widgets.Textarea(placeholder='https://example.com/video\nPaste one link per line',
                                           layout=widgets.Layout(width='100%', height='115px'))
        self.quality = widgets.ToggleButtons(options=[('Highest quality', 'high'), ('Balanced', 'balanced'), ('Smallest file', 'small')],
                                             value='balanced', layout=widgets.Layout(width='100%'))
        self.quality.observe(self._quality_changed, names='value')
        self.save_drive = widgets.Checkbox(value=False, description='Save completed videos to Google Drive', indent=False, layout=widgets.Layout(width='100%'))
        self.check = widgets.Button(description='Check links', icon='search', layout=widgets.Layout(width='150px'))
        self.start = widgets.Button(description='Start processing', icon='play', button_style='success', layout=widgets.Layout(width='180px'))
        self.check.on_click(self._check)
        self.start.on_click(self._start)
        if start_in_cell:
            self.start.layout.display = 'none'
        self.message = widgets.HTML(value='')
        self.previews = widgets.VBox([])
        self.results = widgets.VBox([])
        self.root = widgets.VBox([
            widgets.HTML(value='''<style>
            .clipwell-root{background:#17251d;padding:25px;border:1px solid #3a5140;border-radius:16px;max-width:800px;}
            .clipwell-root .widget-html,.clipwell-root .widget-checkbox label{color:#e5eee4}.clipwell-root h2,.clipwell-root h3{color:#f0f6ed;margin:7px 0 10px}
            .clipwell-root textarea{background:#101d16!important;color:#ecf4e9!important;border:1px solid #526b55!important;border-radius:8px;padding:10px}
            .cw-kicker{color:#b1d89a;font-weight:700;font-size:11px;letter-spacing:1.4px}.cw-muted,.cw-fine{color:#a9bbaa;font-size:12px;line-height:1.5}
            .cw-label{color:#e3eee2;font-size:13px;font-weight:700;margin:14px 0 6px}.cw-card{background:#203329;border:1px solid #3b5742;border-radius:10px;padding:15px;margin:6px 0;color:#e9f2e7}
            .cw-card-title{color:#b1d89a;font-size:10px;font-weight:700;letter-spacing:1px}.cw-card h3{font-size:15px;overflow-wrap:anywhere}
            .cw-grid{display:flex;flex-wrap:wrap;gap:18px}.cw-grid span,.cw-estimate span{display:block;font-size:11px;color:#a8beab;margin-bottom:3px}.cw-grid strong{font-size:13px}
            .cw-estimate{margin-top:14px;border-top:1px solid #3c5541;padding-top:12px}.cw-estimate b{color:#d1eaba;font-size:14px}
            </style><div class="cw-kicker">✳ LESS FILE, MORE FILM</div><h2>Big video? Small problem.</h2><div class="cw-muted">Paste your links, preview what we can find, then download the compressed MP4s.</div>'''),
            widgets.HTML(value='<div class="cw-label">01 · Video links</div>'), self.input_urls,
            widgets.HTML(value='<div class="cw-muted">One link per line · up to 20 · processed one at a time</div><div class="cw-label">02 · Choose your balance</div>'),
            self.quality,
            widgets.HTML(value='<div class="cw-muted">Compression is lossy. Resolution is not intentionally reduced.</div><div class="cw-label">03 · Save your results</div>'),
            self.save_drive,
            widgets.HTML(value='<div class="cw-muted">Optional: run the Connect Google Drive cell first. Completed videos go to My Drive / Clipwell. Free Colab may stop while you are away; unfinished videos will not be saved.</div>'),
            widgets.HBox([self.check, self.start], layout=widgets.Layout(margin='15px 0 5px 0')),
            widgets.HTML(value='<div class="cw-muted">After entering your links, run ▶ Start processing in the notebook cell below.</div>' if start_in_cell else ''),
            self.message, self.previews, self.results,
            widgets.HTML(value='<div class="cw-muted" style="margin-top:14px">Keep the notebook open. Free runtimes can disconnect; output stays temporary. Only process content you have permission to use.</div>'),
        ])
        self.root.add_class('clipwell-root')

    def _urls(self):
        # Also accept links separated by spaces for users of the earlier notebook.
        urls = self.input_urls.value.split()
        if not 1 <= len(urls) <= 20:
            raise ValueError('Enter between 1 and 20 links.')
        return urls

    def _busy(self, value):
        self.check.disabled = self.start.disabled = self.quality.disabled = value
        self.input_urls.disabled = self.save_drive.disabled = value

    def _quality_changed(self, _):
        self._render_previews()

    def _render_previews(self):
        self.previews.children = tuple(widgets.HTML(value=preview_html(i, url, info, self.quality.value))
                                       if isinstance(info, dict) else widgets.HTML(value=f"<div class='cw-card'><b>VIDEO {i}</b><div class='cw-fine'>{escape(info)}</div></div>")
                                       for i, url, info in self.metadata)

    def _check(self, _):
        try:
            urls = self._urls()
        except ValueError as exc:
            self.message.value = f"<div class='cw-muted'>{escape(str(exc))}</div>"
            return
        self._busy(True)
        self.metadata = []
        self._render_previews()
        try:
            for index, url in enumerate(urls, 1):
                self.message.value = f"<div class='cw-muted'>Checking video {index} of {len(urls)}…</div>"
                try:
                    app.validate_url(url)
                    info = video_info.inspect(url, self.quality.value)
                except Exception:
                    info = ('Preview unavailable for this GoFile download link. Try processing it, or use the public share-page link https://gofile.io/d/... instead.'
                            if filehosts.is_gofile_download(url) else
                            'Preview unavailable. This site may not provide details; you can still try processing the link.')
                self.metadata.append((index, url, info))
                self._render_previews()
            self.message.value = "<div class='cw-muted'>Preview complete. Estimates are illustrative; choose a quality and start when ready.</div>"
        finally:
            self._busy(False)

    def run_in_cell(self):
        """Run the real queue in the current notebook cell, not a keepalive."""
        self._start(None)

    def _start(self, _):
        try:
            urls = self._urls()
        except ValueError as exc:
            self.message.value = f"<div class='cw-muted'>{escape(str(exc))}</div>"
            return
        save_to_google_drive = self.save_drive.value
        if save_to_google_drive and not drive_available(self.drive_root):
            self.message.value = "<div class='cw-muted'>Google Drive is not connected. Run the optional Connect Google Drive cell and authorize it before starting.</div>"
            return
        self._busy(True)
        preset = self.quality.value
        self.results.children = ()
        drive_saved = 0
        drive_failed = 0
        try:
            for index, url in enumerate(urls, 1):
                heading = widgets.HTML(value=f"<div class='cw-card-title' style='margin-top:16px'>VIDEO {index} OF {len(urls)}</div>")
                status = widgets.HTML(value="<div class='cw-muted'>Preparing…</div>")
                progress = widgets.IntProgress(value=0, min=0, max=100, bar_style='info', layout=widgets.Layout(width='100%'))
                item = widgets.VBox([heading, status, progress])
                self.results.children = (*self.results.children, item)
                try:
                    app.validate_url(url)
                    job_id = 'colab-' + uuid.uuid4().hex
                    app.JOBS[job_id] = {'id': job_id, 'url': url, 'preset': preset, 'stage': 'queued', 'progress': None}
                    worker = threading.Thread(target=app.run_job, args=(job_id,), daemon=True)
                    worker.start()
                    while worker.is_alive():
                        with app.LOCK:
                            job = dict(app.JOBS[job_id])
                        percent = job.get('progress')
                        eta = job.get('eta_seconds')
                        progress.value = max(0, min(100, int(percent))) if isinstance(percent, (int, float)) else 0
                        eta_text = f' · about {max(1, int((eta + 59) // 60))} min left in this stage' if isinstance(eta, (int, float)) else ''
                        status.value = f"<div class='cw-muted'>{escape(job['stage'].capitalize())}{f' · {int(percent)}%' if percent is not None else '…'}{eta_text}</div>"
                        time.sleep(2)
                    worker.join()
                    with app.LOCK:
                        job = dict(app.JOBS[job_id])
                    if job['stage'] != 'done':
                        raise RuntimeError(job.get('error', 'Processing did not finish.'))
                    self.output_dir.mkdir(parents=True, exist_ok=True)
                    result_path = self.output_dir / f'clipwell-{job_id}.mp4'
                    move(job['path'], str(result_path))
                    button = widgets.Button(description='Download MP4', icon='download', button_style='success')
                    button.on_click(lambda _, path=result_path: self.download(str(path)))
                    difference = 'Output is not smaller.' if job['output_size'] >= job['source_size'] else 'Ready to download.'
                    drive_status = ''
                    if save_to_google_drive:
                        status.value = "<div class='cw-muted'>Saving completed video to Google Drive…</div>"
                        try:
                            save_to_drive(result_path, self.drive_root)
                            drive_saved += 1
                            drive_status = ' Copied to My Drive / Clipwell; verify it appears in Drive.'
                        except Exception:
                            drive_failed += 1
                            drive_status = ' Could not save to Drive. Download it while this runtime is still open.'
                    status.value = (f"<div class='cw-muted'>{difference} Source {size_label(job['source_size'])} → "
                                    f"MP4 {size_label(job['output_size'])}.{drive_status} Download buttons work after the queue finishes.</div>")
                    progress.value = 100
                    progress.bar_style = 'success'
                    item.children = (*item.children, button)
                except Exception as exc:
                    status.value = f"<div class='cw-muted'>Could not finish: {escape(app.readable_error(exc))}</div>"
                    progress.bar_style = 'danger'
            if save_to_google_drive:
                self.message.value = (f"<div class='cw-muted'>Queue finished. {drive_saved} copied to Google Drive; "
                                      f"{drive_failed} Drive copies failed. Verify files in My Drive / Clipwell. "
                                      "Free Colab cannot guarantee processing while disconnected.</div>")
            else:
                self.message.value = "<div class='cw-muted'>Queue finished. Use each Download MP4 button or the Colab Files sidebar. Keep the runtime open until downloads complete.</div>"
        finally:
            self._busy(False)


def show(download, start_in_cell=False):
    ui = ClipwellUI(download, start_in_cell=start_in_cell)
    display(ui.root)
    return ui
