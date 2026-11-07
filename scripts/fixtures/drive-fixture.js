'use strict';
/**
 * A stand-in for Google Drive: the viewer page, the `uc?export=download`
 * endpoint, and the usercontent endpoint that only serves bytes when the
 * "can't scan this file" form's `confirm` comes back.
 *
 * Shared by `scripts/gdrive.test.js` (which asserts on what the app does with
 * it) and `scripts/fixtures/fake-gdrive.js` (which points the app's `fetch` at
 * it, so the whole app can be driven with a Drive link on a machine that has no
 * internet at all).
 *
 * The point is the shape of the answers, not the bytes: `uc` never returns a
 * file, only a form — exactly what Google does for anything over ~100 MB — so
 * an app that saves the response saves HTML. Only a request that carries the
 * form's own `confirm` gets `video/mp4`.
 */

const fs = require('node:fs');
const http = require('node:http');

const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** The page Google sends instead of a large file. */
function confirmForm(id, action) {
  return `<!doctype html><html><head><title>Google Drive - Virus scan warning</title></head><body>
    <p>Google Drive can't scan this file for viruses.</p>
    <p>This file exceeds the maximum size that Google can scan.</p>
    <form id="download-form" action="${escapeHtml(action)}" method="get">
      <input type="hidden" name="id" value="${escapeHtml(id)}">
      <input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t">
      <input type="hidden" name="uuid" value="7d1f0c22-1a44-4f0e-9a51-2c8f1d3b6e90">
    </form></body></html>`;
}

/**
 * Start the fixture. Resolves with the listening `server`, whose `.base` is the
 * origin to point Drive's hosts at.
 *
 *   mediaPath    the file `/usercontent/download` serves
 *   name         the file's name, as the viewer page's <title> says it
 *   privateIds   ids Google would answer with "you need access"
 *   unresolved   a predicate/Set of ids that answer like Drive's "not found"
 *   onHit        called with "METHOD /path?query" for every request
 */
function startDriveFixture({
  port,
  mediaPath,
  name = 'Drive demo clip.mp4',
  privateIds = [],
  unresolved = [],
  onHit = null,
  host = '127.0.0.1',
} = {}) {
  const isPrivate = (id) => (typeof privateIds === 'function' ? privateIds(id) : privateIds.includes(id));
  const isUnknown = (id) => (typeof unresolved === 'function' ? unresolved(id) : unresolved.includes(id));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (onHit) onHit(`${req.method} ${url.pathname}${url.search}`);

    /* The viewer: its <title> is where the file's real name comes from. */
    const viewer = /^\/(?:file\/d\/([^/]+)\/view|open)$/.exec(url.pathname);
    if (viewer) {
      const id = viewer[1] || url.searchParams.get('id') || '';
      if (isUnknown(id)) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<html><head><title>Google Drive</title></head><body>not found</body></html>');
      }
      const title = isPrivate(id) ? 'Private Film.mp4' : name;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        `<html><head><title>${escapeHtml(title)} - Google Drive</title></head><body><div>viewer</div></body></html>`,
      );
    }

    /* Where a downloader lands first. Never a file — a form, or a refusal. */
    if (url.pathname === '/uc') {
      const id = url.searchParams.get('id') || '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (isPrivate(id)) {
        return res.end(
          '<html><body><p>You need access</p><a href="https://accounts.google.com/ServiceLogin">Sign in</a></body></html>',
        );
      }
      if (isUnknown(id)) {
        return res.end('<html><body><p>File not found</p></body></html>');
      }
      return res.end(confirmForm(id, `${server.base}/usercontent/download`));
    }

    /* What the form submits to: bytes only with `confirm`. */
    if (url.pathname === '/usercontent/download') {
      if (url.searchParams.get('confirm') !== 't') {
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<html><body>confirm required</body></html>');
      }
      let stat;
      try {
        stat = fs.statSync(mediaPath);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('no media');
      }
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(stat.size),
        'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'accept-ranges': 'bytes',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(mediaPath).pipe(res);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      server.base = `http://127.0.0.1:${port}`;
      resolve(server);
    });
  });
}

module.exports = { startDriveFixture, confirmForm };
