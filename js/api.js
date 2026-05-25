// Thin wrapper around fetch for talking to api.lynxseal.com. Sends auth via
// bearer token (from the outer wrapper's localStorage, relayed via
// PortalBridge) plus the tenant id from the wrapper handshake.
//
// Usage:
//   await PortalBridge.ready();           // make sure handshake completed
//   const ctx = await api.get('/api/context');
//   const pdf = await api.post('/api/sign-document', body, { asBytes: true });
//
// On 401: redirects to /sign-in.html unless { noAutoRedirect: true } is passed.

(function () {
  'use strict';

  function buildUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return window.API_BASE + (path.startsWith('/') ? path : '/' + path);
  }

  async function call(method, path, body, opts = {}) {
    // Make sure we have the wrapper handshake before reading window.AUTH_TOKEN.
    if (window.PortalBridge && !opts.skipBridgeWait) {
      await window.PortalBridge.ready();
    }
    const url = buildUrl(path);
    const init = {
      method,
      // No credentials:include — auth is via bearer token. Cookies wouldn't
      // work cross-site from the portal iframe to api.lynxseal.com anyway in
      // modern browsers.
      headers: {},
    };
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
    const res = await fetch(url, init);
    if (res.status === 401 && !opts.noAutoRedirect) {
      const ret = encodeURIComponent(location.pathname + location.search);
      // Tell the wrapper to drop its stale token and route to sign-in.
      if (window.PortalBridge) window.PortalBridge.clearAuth();
      location.href = `/sign-in.html?next=${ret}`;
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch {}
      const err = new Error(`API ${method} ${path} failed: ${res.status} ${detail}`);
      err.status = res.status;
      err.body = detail;
      throw err;
    }
    if (opts.asBlob) return await res.blob();
    if (opts.asBytes) return new Uint8Array(await res.arrayBuffer());
    if (opts.asText) return await res.text();
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) return await res.json();
    return await res.text();
  }

  window.api = {
    get: (path, opts) => call('GET', path, undefined, opts),
    post: (path, body, opts) => call('POST', path, body, opts),
    put: (path, body, opts) => call('PUT', path, body, opts),
    del: (path, opts) => call('DELETE', path, undefined, opts),
    base: () => window.API_BASE,
  };
})();
