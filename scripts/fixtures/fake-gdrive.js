'use strict';
/**
 * A stand-in for Google Drive, for the end-to-end test and for a live demo.
 *
 *   node --require scripts/fixtures/fake-gdrive.js server/server.js
 *
 * Drive's two hosts are rewritten to a local fixture server: the viewer page,
 * the `uc?export=download` endpoint that answers a *form* for a big file, and
 * the usercontent download that only serves bytes when the form's `confirm`
 * comes back. Nothing in the app knows this is happening — the resolver builds
 * its own URLs and parses the same HTML it would get from Google.
 *
 *   FAKE_DRIVE_PORT   the local fixture's port (required)
 *   FAKE_DRIVE_MEDIA  if set, *serve* the fixture from this file too, so a Drive
 *                     link can be pasted into the app on a machine with no
 *                     internet (the demo). The test starts its own fixture and
 *                     leaves this unset.
 *   FAKE_DRIVE_NAME   the file's name in that demo (default "Drive demo clip.mp4")
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

/* The demo: serve the fixture here, so the app's own resolver talks to
   something that answers like Drive instead of to a network it cannot reach. */
if (process.env.FAKE_DRIVE_MEDIA) {
  const { startDriveFixture } = require('./drive-fixture');
  startDriveFixture({
    port: Number(PORT),
    mediaPath: process.env.FAKE_DRIVE_MEDIA,
    name: process.env.FAKE_DRIVE_NAME || 'Drive demo clip.mp4',
    onHit: (hit) => console.log(`[fake-gdrive] ${hit}`),
  })
    .then(() => {
      console.log(`[fake-gdrive] drive.google.com is this server — paste any Drive file link`);
    })
    .catch((err) => {
      console.error(`[fake-gdrive] could not start: ${err.message}`);
      process.exit(1);
    });
}
