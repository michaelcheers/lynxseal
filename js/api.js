// Thin API client. Lives on the wrapper origin (per-tenant), routes every
// call through a hidden iframe at portal.lynxseal.com/api-proxy.html which
// does the actual fetch to api.lynxseal.com. Reason: api.lynxseal.com's
// CORS allowlist only knows about portal.lynxseal.com, so adding a new
// wrapper tenant doesn't require a server-side CORS change — every wrapper
// rides through the portal-side proxy.
//
// Usage unchanged from the old direct-fetch version:
//   const ctx = await api.get('/api/context');
//   const pdf = await api.post('/api/sign-document', body, { asBytes: true });

(function () {
  'use strict';

  const PROXY_URL = 'https://portal.lynxseal.com/api-proxy.html';
  const PROXY_ORIGIN = 'https://portal.lynxseal.com';

  // Singleton hidden iframe + ready promise — lazily created on first call.
  let _proxyFrame = null;
  let _proxyReady = null;
  const _pending = new Map();
  let _nextId = 0;

  function ensureProxy() {
    if (_proxyReady) return _proxyReady;
    _proxyReady = new Promise((resolve, reject) => {
      _proxyFrame = document.createElement('iframe');
      _proxyFrame.src = PROXY_URL;
      _proxyFrame.setAttribute('aria-hidden', 'true');
      _proxyFrame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      // The proxy posts {type:'api-proxy-ready'} once its script has wired
      // its own message listener. Resolve on that — not iframe.onload —
      // so we don't race the proxy's listener installation.
      const onMsg = (e) => {
        if (e.origin !== PROXY_ORIGIN || e.source !== _proxyFrame.contentWindow) return;
        if (e.data && e.data.type === 'api-proxy-ready') {
          window.removeEventListener('message', onMsg);
          resolve();
        }
      };
      window.addEventListener('message', onMsg);
      _proxyFrame.onerror = () => reject(new Error('Failed to load API proxy iframe'));
      document.body.appendChild(_proxyFrame);
    });
    return _proxyReady;
  }

  // The proxy posts back { id, ok, status, statusText, headers, body | error }.
  // body is an ArrayBuffer (transferred, not copied).
  window.addEventListener('message', (e) => {
    if (e.origin !== PROXY_ORIGIN) return;
    if (!_proxyFrame || e.source !== _proxyFrame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.id === 'undefined') return;
    const pending = _pending.get(m.id);
    if (!pending) return;
    _pending.delete(m.id);
    if (m.error) { pending.reject(new Error(m.error)); return; }
    pending.resolve(m);
  });

  // Send a request to the proxy, await its response.
  async function proxyFetch(path, init) {
    await ensureProxy();
    const id = ++_nextId;
    return new Promise((resolve, reject) => {
      _pending.set(id, { resolve, reject });
      // body needs to be serializable through structured clone — a string,
      // ArrayBuffer, Blob, or FormData all work. JSON-stringified body is a
      // string already so it sails through.
      _proxyFrame.contentWindow.postMessage({ id, path, init }, PROXY_ORIGIN);
    });
  }

  async function call(method, path, body, opts = {}) {
    // Make sure PortalBridge has populated window.AUTH_TOKEN / window.TENANT.
    if (window.PortalBridge && !opts.skipBridgeWait) {
      await window.PortalBridge.ready();
    }
    const init = { method, headers: {} };
    if (window.AUTH_TOKEN) init.headers['Authorization'] = 'Bearer ' + window.AUTH_TOKEN;
    if (window.TENANT) init.headers['X-Tenant'] = window.TENANT;
    if (body !== undefined && body !== null) {
      if (body instanceof FormData || body instanceof Blob || body instanceof Uint8Array || body instanceof ArrayBuffer) {
        init.body = body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const res = await proxyFetch(path, init);
    if (res.status === 401 && !opts.noAutoRedirect) {
      const ret = encodeURIComponent(location.pathname + location.search);
      if (window.PortalBridge) window.PortalBridge.clearAuth();
      location.href = `/sign-in.html?next=${ret}`;
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = new TextDecoder('utf-8').decode(res.body); } catch {}
      const err = new Error(`API ${method} ${path} failed: ${res.status} ${detail}`);
      err.status = res.status;
      err.body = detail;
      throw err;
    }

    if (opts.asBlob) {
      const ct = (res.headers && res.headers['content-type']) || 'application/octet-stream';
      return new Blob([res.body], { type: ct });
    }
    if (opts.asBytes) return new Uint8Array(res.body);
    if (opts.asText) return new TextDecoder('utf-8').decode(res.body);
    const ct = (res.headers && res.headers['content-type']) || '';
    const text = new TextDecoder('utf-8').decode(res.body);
    if (ct.includes('application/json')) return JSON.parse(text);
    return text;
  }

  window.api = {
    get: (path, opts) => call('GET', path, undefined, opts),
    post: (path, body, opts) => call('POST', path, body, opts),
    put: (path, body, opts) => call('PUT', path, body, opts),
    del: (path, opts) => call('DELETE', path, undefined, opts),
  };
})();
