'use strict';

/**
 * Free, no-signup file hosts that accept anonymous uploads over an API.
 *
 * Uploads stream from disk (never fully buffered), report progress, and fall
 * back down a list, so a job that cannot reach one host can still finish on
 * another. API bases are overridable so tests (and self-hosted instances) can
 * point them somewhere local.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { PassThrough, Readable } = require('node:stream');

const UA = 'squeeze/1.0 (video compressor)';

class HostError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HostError';
    this.code = code || 'HOST_FAILED';
  }
}

const sanitize = (name) => String(name || 'video.mp4').replace(/[\r\n"]/g, '').slice(0, 180);

/** File read stream wrapped so byte progress can be reported. */
function countedStream(filePath, onBytes) {
  let sent = 0;
  const source = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
  source.on('data', (chunk) => {
    sent += chunk.length;
    if (onBytes) onBytes(sent);
  });
  return source;
}

/**
 * Stream a file as multipart/form-data with a known Content-Length.
 * Returns { body, contentLength, contentType }.
 */
function multipartFile(filePath, { field = 'file', filename, contentType = 'application/octet-stream', fields = {}, onBytes }) {
  const boundary = `----squeeze${crypto.randomBytes(12).toString('hex')}`;
  const size = fs.statSync(filePath).size;

  const fieldParts = Object.entries(fields).map(
    ([key, value]) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`),
  );
  const head = Buffer.concat([
    ...fieldParts,
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${sanitize(filename)}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
  ]);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  const sink = new PassThrough();
  sink.write(head);
  const source = countedStream(filePath, onBytes);
  source.pipe(sink, { end: false });
  source.on('end', () => sink.end(tail));
  source.on('error', (err) => sink.destroy(err));

  return {
    body: Readable.toWeb(sink),
    contentLength: head.length + size + tail.length,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Raw file body with a known Content-Length. */
function rawFile(filePath, onBytes) {
  const size = fs.statSync(filePath).size;
  return { body: Readable.toWeb(countedStream(filePath, onBytes)), contentLength: size };
}

async function jsonOrThrow(res, provider) {
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    throw new HostError(
      `${provider} rejected the upload (HTTP ${res.status})${data && data.message ? `: ${data.message}` : ''}.`,
      'HOST_HTTP',
    );
  }
  return data;
}

/* ------------------------------------------------------------------ gofile */

let gofileToken = { value: null, at: 0 };
let gofileServer = { value: null, at: 0 };

const gofileApi = () => process.env.GOFILE_API_BASE || 'https://api.gofile.io';

async function gofileGuestToken(force = false) {
  if (!force && gofileToken.value && Date.now() - gofileToken.at < 30 * 60 * 1000) return gofileToken.value;
  const res = await fetch(`${gofileApi()}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: '{}',
  });
  const data = await jsonOrThrow(res, 'gofile');
  const token = data && data.data && data.data.token;
  if (!token) throw new HostError('gofile would not issue a guest account.', 'GOFILE_AUTH');
  gofileToken = { value: token, at: Date.now() };
  return token;
}

async function gofileUploadServer() {
  if (process.env.GOFILE_UPLOAD_BASE) return process.env.GOFILE_UPLOAD_BASE;
  if (gofileServer.value && Date.now() - gofileServer.at < 10 * 60 * 1000) return gofileServer.value;
  const res = await fetch(`${gofileApi()}/servers`, { headers: { 'user-agent': UA } });
  const data = await jsonOrThrow(res, 'gofile');
  const server = data && data.data && data.data.servers && data.data.servers[0] && data.data.servers[0].name;
  if (!server) throw new HostError('gofile returned no upload server.', 'GOFILE_SERVER');
  const base = `https://${server}.gofile.io`;
  gofileServer = { value: base, at: Date.now() };
  return base;
}

const gofile = {
  id: 'gofile',
  label: 'gofile.io',
  maxBytes: 20 * 1024 ** 3,
  async upload(filePath, meta, { onProgress, signal } = {}) {
    const token = process.env.GOFILE_TOKEN || (await gofileGuestToken());
    const base = await gofileUploadServer();
    const total = fs.statSync(filePath).size;
    const part = multipartFile(filePath, {
      field: 'file',
      filename: meta.name,
      contentType: 'video/mp4',
      fields: { token },
      onBytes: (sent) => onProgress && onProgress({ sent, total }),
    });

    const res = await fetch(`${base}/contents/uploadfile`, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': part.contentType,
        'content-length': String(part.contentLength),
        authorization: `Bearer ${token}`,
      },
      body: part.body,
      duplex: 'half',
      signal,
    });

    const data = await jsonOrThrow(res, 'gofile');
    if (!data || data.status !== 'ok' || !data.data) {
      throw new HostError(`gofile refused the upload (${data && data.status ? data.status : 'unknown'}).`, 'GOFILE_FAILED');
    }
    const link = data.data.downloadPage || data.data.link;
    if (!link) throw new HostError('gofile returned no download link.', 'GOFILE_NO_LINK');
    return { provider: 'gofile', url: link, id: data.data.id || null };
  },
};

/* --------------------------------------------------------------- pixeldrain */

const pixeldrain = {
  id: 'pixeldrain',
  label: 'pixeldrain.com',
  maxBytes: 20 * 1024 ** 3,
  async upload(filePath, meta, { onProgress, signal } = {}) {
    const base = process.env.PIXELDRAIN_API_BASE || 'https://pixeldrain.com';
    const name = encodeURIComponent(sanitize(meta.name));
    const total = fs.statSync(filePath).size;
    const part = rawFile(filePath, (sent) => onProgress && onProgress({ sent, total }));

    const headers = {
      'user-agent': UA,
      'content-type': 'application/octet-stream',
      'content-length': String(part.contentLength),
    };
    if (process.env.PIXELDRAIN_KEY) {
      headers.authorization = `Basic ${Buffer.from(`:${process.env.PIXELDRAIN_KEY}`).toString('base64')}`;
    }

    const res = await fetch(`${base}/api/file/${name}`, {
      method: 'POST',
      headers,
      body: part.body,
      duplex: 'half',
      signal,
    });

    const data = await jsonOrThrow(res, 'pixeldrain');
    if (!data || !data.id) {
      throw new HostError(
        data && data.message ? `pixeldrain: ${data.message}` : 'pixeldrain returned no file id.',
        'PIXELDRAIN_FAILED',
      );
    }
    return { provider: 'pixeldrain', url: `${base}/u/${data.id}`, id: data.id };
  },
};

/* ------------------------------------------------------------------ catbox */

const catbox = {
  id: 'catbox',
  label: 'catbox.moe',
  maxBytes: 200 * 1024 * 1024,
  async upload(filePath, meta, { onProgress, signal } = {}) {
    const total = fs.statSync(filePath).size;
    if (total > catbox.maxBytes) {
      throw new HostError('catbox only accepts files up to 200 MB.', 'TOO_BIG');
    }
    const part = multipartFile(filePath, {
      field: 'fileToUpload',
      filename: meta.name,
      contentType: 'video/mp4',
      fields: { reqtype: 'fileupload' },
      onBytes: (sent) => onProgress && onProgress({ sent, total }),
    });

    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: {
        'user-agent': UA,
        'content-type': part.contentType,
        'content-length': String(part.contentLength),
      },
      body: part.body,
      duplex: 'half',
      signal,
    });

    const text = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//.test(text)) {
      throw new HostError(`catbox refused the upload (HTTP ${res.status}).`, 'CATBOX_FAILED');
    }
    return { provider: 'catbox', url: text, id: null };
  },
};

/* ---------------------------------------------------------------- registry */

const PROVIDERS = { gofile, pixeldrain, catbox };

/** Providers enabled on this server, in priority order. */
function providerOrder() {
  const raw = process.env.HOSTERS || 'gofile,pixeldrain,catbox';
  return raw
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => PROVIDERS[id]);
}

function describeProviders() {
  return providerOrder().map((id) => ({
    id,
    label: PROVIDERS[id].label,
    maxBytes: PROVIDERS[id].maxBytes,
  }));
}

/**
 * Upload to the first provider that accepts the file.
 * @returns {Promise<{provider: string, url: string, id: string|null, attempts: Array}>}
 */
async function uploadToHoster(filePath, meta, { order, onProgress, signal, timeoutMs = 30 * 60 * 1000 } = {}) {
  const size = fs.statSync(filePath).size;
  const candidates = (order || providerOrder())
    .map((id) => PROVIDERS[id])
    .filter(Boolean)
    .filter((provider) => size <= provider.maxBytes);

  if (!candidates.length) {
    throw new HostError('No enabled file host accepts a file this large.', 'NO_PROVIDER');
  }

  const attempts = [];
  for (const provider of candidates) {
    if (signal && signal.aborted) throw new HostError('Cancelled.', 'CANCELLED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      if (onProgress) onProgress({ provider: provider.id, sent: 0, total: size });
      const result = await provider.upload(filePath, meta, {
        onProgress: (event) => onProgress && onProgress({ ...event, provider: provider.id }),
        signal: controller.signal,
      });
      attempts.push({ provider: provider.id, ok: true });
      return { ...result, attempts };
    } catch (err) {
      attempts.push({ provider: provider.id, ok: false, error: err.message });
      // A cancel or a policy refusal should not silently retry elsewhere.
      if (err.code === 'CANCELLED') throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join('; ');
  throw Object.assign(new HostError(`Every enabled file host refused the upload. ${detail}`, 'ALL_HOSTS_FAILED'), {
    attempts,
  });
}

module.exports = {
  PROVIDERS,
  providerOrder,
  describeProviders,
  uploadToHoster,
  HostError,
  multipartFile,
  rawFile,
};
