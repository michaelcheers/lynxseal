// PortalBridge — auth + tenant glue for portal pages running on a wrapper
// origin (certify-stibc-test.lynxseal.com, etc.). The wrapper's service
// worker proxies portal HTML and injects a small <script> in <body> that
// sets window.TENANT / window.WRAPPER_APP / window.ORG_NAME before any
// portal script runs. We're same-origin with the wrapper so localStorage
// works directly — no iframe, no postMessage handshake.

(function () {
  'use strict';

  const STORAGE_KEY = 'lynxseal:authToken';

  function readToken() { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } }
  function writeToken(t) {
    try {
      if (t) localStorage.setItem(STORAGE_KEY, t);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  window.AUTH_TOKEN = readToken();

  window.PortalBridge = {
    // Kept as a Promise for callers that await it; resolves immediately
    // since there's no async handshake any more.
    ready() { return Promise.resolve(); },

    setAuth(token /*, isAdmin */) {
      window.AUTH_TOKEN = token || null;
      writeToken(token);
      try { const bc = new BroadcastChannel('lynxseal:auth'); bc.postMessage({ token: token || null }); bc.close(); } catch {}
    },
    clearAuth() { this.setAuth(null); },

    // No-op: page navigations are direct (no iframe-parent URL sync needed).
    navigate() {},
  };

  // Cross-tab auth sync — different tabs of the same wrapper origin should
  // see each other's sign-in/sign-out.
  try {
    new BroadcastChannel('lynxseal:auth').addEventListener('message', (e) => {
      window.AUTH_TOKEN = (e.data && e.data.token) || null;
      if (typeof window.onAuthChanged === 'function') window.onAuthChanged(window.AUTH_TOKEN);
    });
  } catch {}

  // Wrapper-default language. French wrappers (certifier./verifier. origins)
  // inject window.WRAPPER_LANG='fr' via tenant-globals; apply it as the default
  // body language on every portal page. An explicit ?lang= URL param wins —
  // pages with a language toggle (index, verify-document) call switchLanguage
  // themselves with the same precedence, so this only matters for pages that
  // hardcode lang-en (sign-in, reset-password, …).
  if (window.WRAPPER_LANG === 'fr' && !new URLSearchParams(location.search).get('lang')) {
    const applyFr = () => { document.body.classList.add('lang-fr'); document.body.classList.remove('lang-en'); };
    if (document.body) applyFr();
    else document.addEventListener('DOMContentLoaded', applyFr);
  }

  // Append the org name to the browser tab title (e.g. "Sign In · STIBC").
  // The portal pages set just the page name; we tack on the org from the
  // wrapper-injected window.ORG_NAME.
  if (window.ORG_NAME) {
    const suffix = ' · ' + window.ORG_NAME;
    const apply = () => {
      if (!document.title.endsWith(suffix)) document.title = (document.title || '') + suffix;
    };
    apply();
    try {
      const titleEl = document.querySelector('head > title');
      if (titleEl) new MutationObserver(apply).observe(titleEl, { childList: true, characterData: true, subtree: true });
    } catch {}
  }
})();
