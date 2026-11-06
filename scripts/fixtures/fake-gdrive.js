'use strict';
/**
 * A stand-in for Google Drive, for the end-to-end test.
 *
 *   node --require scripts/fixtures/fake-gdrive.js server/server.js
 *
 * Drive's two hosts are rewritten to a local fixture server: the viewer page,
 * the `uc?export=download` endpoint that answers a *form* for a big file, and
 * the usercontent download that only serves bytes when the form's `confirm`
 * comes back. Nothing in the app knows this is happening — the resolver builds
 * its own URLs and parses the same HTML it would get from Google.
 *
 *   FAKE_DRIVE_PORT  the local fixture's port (required)
 */

const PORT = process.env.FAKE_DRIVE_PORT;
if (!PORT) throw new Error('fake-gdrive: set FAKE_DRIVE_PORT');

const BASE = `http://127.0.0.1:${PORT}`;
const realFetch = globalThis.fetch;

const rewrite = (url) =>
  String(url)
    .replace(/^https:\/\/drive\.google\.com/i, BASE)
    .replace(/^https:\/\/drive\.usercontent\.google\.com/i, `${BASE}/usercontent`);

globalThis.fetch = function fetch(input, init) {
  const url = typeof input === 'string' ? input : input && input.url;
  if (typeof url === 'string' && /^https:\/\/drive\.(google|usercontent\.google)\.com\//i.test(url)) {
    return realFetch(rewrite(url), init);
  }
  return realFetch(input, init);
};
