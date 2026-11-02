/**
 * Browser-side uploads to free file hosts.
 *
 * Why this exists: a server with no outbound internet still has a user whose
 * browser does. gofile and pixeldrain both allow cross-origin requests, so the
 * finished file can be handed back from the browser and turned into a share link.
 *
 * Runs in the page (<script>) and in Node for tests (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.SqueezeHost = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class HostError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'HostError';
      this.code = code || 'HOST_FAILED';
    }
  }

  const safeName = (name) => String(name || 'video.mp4').replace(/[^\w.\- ]+/g, '_').slice(0, 180) || 'video.mp4';

  /** XHR upload so progress events are available (fetch still lacks them). */
  function xhrUpload(url, { method = 'POST', body, headers = {}, onProgress, timeoutMs = 30 * 60 * 1000 }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.timeout = timeoutMs;
      for (const [key, value] of Object.entries(headers)) {
        try {
          xhr.setRequestHeader(key, value);
        } catch {
          /* header not allowed; the server will decide */
        }
      }
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress({ sent: event.loaded, total: event.total });
        };
      }
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new HostError('The upload was blocked (network or CORS).', 'NETWORK'));
      xhr.ontimeout = () => reject(new HostError('The upload timed out.', 'TIMEOUT'));
      xhr.send(body);
    });
  }

  async function jsonOf(response, provider) {
    let data = null;
    try {
      data = JSON.parse(response.text);
    } catch {
      /* not json */
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HostError(
        `${provider} rejected the upload (HTTP ${response.status})${data && data.message ? `: ${data.message}` : ''}.`,
        'HOST_HTTP',
      );
    }
    return data;
  }

  /* ------------------------------------------------------------------ gofile */

  let guest = { token: null, at: 0 };

  async function gofileToken() {
    if (guest.token && Date.now() - guest.at < 30 * 60 * 1000) return guest.token;
    const res = await fetch('https://api.gofile.io/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => null);
    const token = data && data.data && data.data.token;
    if (!token) throw new HostError('gofile would not issue a guest account.', 'GOFILE_AUTH');
    guest = { token, at: Date.now() };
    return token;
  }

  let uploadBase = { value: null, at: 0 };

  async function gofileServer() {
    if (uploadBase.value && Date.now() - uploadBase.at < 10 * 60 * 1000) return uploadBase.value;
    const res = await fetch('https://api.gofile.io/servers');
    const data = await res.json().catch(() => null);
    const name =
      data && data.data && data.data.servers && data.data.servers[0] && data.data.servers[0].name;
    if (!name) throw new HostError('gofile returned no upload server.', 'GOFILE_SERVER');
    uploadBase = { value: `https://${name}.gofile.io`, at: Date.now() };
    return uploadBase.value;
  }

  const gofile = {
    id: 'gofile',
    label: 'gofile.io',
    maxBytes: 20 * 1024 ** 3,
    async upload(file, meta, { onProgress } = {}) {
      const token = await gofileToken();
      const base = await gofileServer();
      const form = new FormData();
      form.append('token', token);
      form.append('file', file, safeName(meta.name));
      const response = await xhrUpload(`${base}/contents/uploadfile`, {
        body: form,
        headers: { authorization: `Bearer ${token}` },
        onProgress,
      });
      const data = await jsonOf(response, 'gofile');
      if (!data || data.status !== 'ok' || !data.data) {
        throw new HostError(`gofile refused the upload (${data && data.status ? data.status : 'unknown'}).`, 'GOFILE_FAILED');
      }
      const url = data.data.downloadPage || data.data.link;
      if (!url) throw new HostError('gofile returned no download link.', 'GOFILE_NO_LINK');
      return { provider: 'gofile', url, id: data.data.id || null };
    },
  };

  /* --------------------------------------------------------------- pixeldrain */

  const pixeldrain = {
    id: 'pixeldrain',
    label: 'pixeldrain.com',
    maxBytes: 20 * 1024 ** 3,
    async upload(file, meta, { onProgress } = {}) {
      const name = encodeURIComponent(safeName(meta.name));
      const response = await xhrUpload(`https://pixeldrain.com/api/file/${name}`, {
        body: file,
        headers: { 'content-type': 'application/octet-stream' },
        onProgress,
      });
      const data = await jsonOf(response, 'pixeldrain');
      if (!data || !data.id) {
        throw new HostError(
          data && data.message ? `pixeldrain: ${data.message}` : 'pixeldrain returned no file id.',
          'PIXELDRAIN_FAILED',
        );
      }
      return { provider: 'pixeldrain', url: `https://pixeldrain.com/u/${data.id}`, id: data.id };
    },
  };

  const PROVIDERS = { gofile, pixeldrain };

  function available() {
    return Object.keys(PROVIDERS);
  }

  /**
   * Upload a Blob/File to the first host that accepts it.
   * @returns {Promise<{provider: string, url: string, attempts: Array}>}
   */
  async function upload(blob, meta = {}, { order = ['gofile', 'pixeldrain'], onProgress, onProvider } = {}) {
    const size = blob.size;
    const candidates = order.map((id) => PROVIDERS[id]).filter(Boolean).filter((p) => size <= p.maxBytes);
    if (!candidates.length) throw new HostError('No file host accepts a file this large.', 'NO_PROVIDER');

    const attempts = [];
    for (const provider of candidates) {
      try {
        if (onProvider) onProvider(provider.id);
        const result = await provider.upload(blob, meta, { onProgress });
        attempts.push({ provider: provider.id, ok: true });
        return { ...result, attempts };
      } catch (err) {
        attempts.push({ provider: provider.id, ok: false, error: err.message });
      }
    }
    const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join('; ');
    throw new HostError(`No file host accepted the upload. ${detail}`, 'ALL_HOSTS_FAILED');
  }

  return { upload, available, PROVIDERS, HostError };
});
