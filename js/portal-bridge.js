// Portal ↔ Wrapper postMessage bridge.
//
// The portal (this code, running on portal.lynxseal.com) is iframed into
// per-tenant wrapper pages (certify.stibc.org, verify.atio.on.ca, etc.).
// Those wrappers hold the per-tenant auth token in their own localStorage
// (so STIBC and ATIO logins don't collide) and we ask for it via postMessage.
//
// On every page load:
//   1. postMessage {type:'init'} → parent
//   2. Wait for {type:'init', tenant, app, token, wrapperOrigin} ← parent
//   3. Stash token + tenant in window globals so api.js can find them
//   4. (Optional) postMessage {type:'navigate', path} on URL changes so
//      the wrapper can pushState its own history.
//
// targetOrigin is locked in BOTH directions:
//   - Outbound: the wrapperOrigin we received in the init handshake.
//   - Inbound:  every message verifies event.origin against KNOWN_WRAPPER_ORIGINS.

(function () {
  'use strict';

  // Compile-time allowlist of wrapper origins. Hostnames where the
  // wrapper-template.html may be deployed. If a postMessage comes from
  // anything else, we ignore it.
  const KNOWN_WRAPPER_ORIGINS = new Set([
    // Testing-only wrappers under domains we control. The real per-tenant
    // wrapper origins (certify.stibc.org etc.) are commented out below until
    // the architecture has been smoke-tested end-to-end.
    'https://certify-stibc-test.lynxseal.com',
    'https://verify-stibc-test.lynxseal.com',
    // 'https://certify.stibc.org',
    // 'https://verify.stibc.org',
    // 'https://certify.atio.on.ca',
    // 'https://verify.atio.on.ca',
    // 'https://certify.atim.mb.ca',
    // 'https://verify.atim.mb.ca',
  ]);

  let wrapperOrigin = null; // set after init handshake
  let initResolve;
  const initPromise = new Promise(r => initResolve = r);

  function send(msg) {
    if (!wrapperOrigin) {
      // Pre-handshake: broadcast to all known wrappers; they'll filter by
      // checking event.source / origin.
      for (const origin of KNOWN_WRAPPER_ORIGINS) {
        try { window.parent.postMessage(msg, origin); } catch {}
      }
    } else {
      window.parent.postMessage(msg, wrapperOrigin);
    }
  }

  window.addEventListener('message', (e) => {
    if (!KNOWN_WRAPPER_ORIGINS.has(e.origin)) return;
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        wrapperOrigin = e.origin;
        window.AUTH_TOKEN = m.token || null;
        window.TENANT = m.tenant || null;
        window.WRAPPER_APP = m.app || null;
        window.WRAPPER_ORIGIN = e.origin;
        // Push the initial document.title to the wrapper, then watch for
        // future title changes. The wrapper appends its own org name to
        // whatever we send — see wrapper-template.html setTitle handler.
        send({ type: 'setTitle', title: document.title });
        try {
          const titleEl = document.querySelector('head > title');
          if (titleEl) {
            new MutationObserver(() => send({ type: 'setTitle', title: document.title }))
              .observe(titleEl, { childList: true, characterData: true, subtree: true });
          }
        } catch {}
        // Rewrite same-origin <a href> to point at the wrapper origin so
        // hover/copy-link shows e.g. certify.stibc.org/reset-password, not
        // portal.lynxseal.com/reset-password.html. The click interceptor
        // below then preventDefault's and navigates the iframe directly
        // (so we don't pay a top-frame reload or end up nested in another
        // wrapper instance).
        try {
          rewriteLinks();
          new MutationObserver(rewriteLinks).observe(document.body, { childList: true, subtree: true });
        } catch {}
        initResolve();
        break;
      case 'popstate':
        // User clicked browser back/forward; the parent pushState'd a new
        // path and is asking us to navigate. Use SPA-style routing.
        if (typeof window.onParentNavigate === 'function') window.onParentNavigate(m.path);
        break;
      case 'authChanged':
        // Another tab (same wrapper origin) signed in/out. Reload to pick up.
        window.AUTH_TOKEN = m.token || null;
        if (typeof window.onAuthChanged === 'function') window.onAuthChanged(m.token);
        break;
    }
  });

  // Rewrite same-origin <a href> to use the wrapper origin (with .html
  // stripped), so on hover the browser shows the user-facing wrapper URL
  // instead of portal.lynxseal.com. Idempotent — we tag rewritten links
  // with a data attribute and skip them on re-runs.
  function rewriteLinks() {
    if (!wrapperOrigin) return;
    for (const a of document.querySelectorAll('a[href]:not([data-pb-rewritten])')) {
      const raw = a.getAttribute('href');
      if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('#')) continue;
      let url;
      try { url = new URL(raw, location.href); } catch { continue; }
      if (url.origin !== location.origin) continue; // external link, leave alone
      const wrapperPath = url.pathname.replace(/\.html$/, '');
      a.href = wrapperOrigin + wrapperPath + url.search + url.hash;
      a.setAttribute('data-pb-rewritten', '1');
    }
  }

  // Capture-phase click interceptor: when the user clicks a wrapper-origin
  // link inside the iframe, navigate the iframe (not the top frame) to the
  // matching portal path. Without this the link would either nav the top
  // frame (slow full reload) or load the wrapper inside our iframe (nested).
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (!wrapperOrigin || url.origin !== wrapperOrigin) return;
    e.preventDefault();
    // Same-page hash change: don't reload.
    const portalPath = (url.pathname && url.pathname !== '/') ? (url.pathname.endsWith('.html') ? url.pathname : url.pathname + '.html') : '/';
    if (portalPath === location.pathname && url.search === location.search) {
      location.hash = url.hash;
    } else {
      location.href = portalPath + url.search + url.hash;
    }
  }, true);

  // Public API used by api.js and individual pages.
  window.PortalBridge = {
    // Wait for the init handshake to complete. After this resolves,
    // window.AUTH_TOKEN, window.TENANT, window.WRAPPER_ORIGIN are populated.
    ready() { return initPromise; },

    // Tell the wrapper to store/clear the token.
    setAuth(token, isAdmin) { send({ type: 'setAuth', token, isAdmin }); window.AUTH_TOKEN = token; },
    clearAuth() { send({ type: 'clearAuth' }); window.AUTH_TOKEN = null; },

    // Sync the parent's URL bar to a portal-internal path.
    navigate(path) { send({ type: 'navigate', path }); },
  };

  // Kick off handshake. Include current path so the wrapper can sync its
  // URL bar — every navigation inside the iframe is a fresh page load, which
  // re-runs this script with the new location.
  send({ type: 'init', path: location.pathname + location.search + location.hash });
})();
