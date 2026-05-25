// pdf.js viewer loader.
//
// The viewer lives at /pdfjs/web/viewer.html, served by a service worker
// (/pdfjs/sw.js) that decompresses an integrity-pinned upstream release
// ZIP. See /pdfjs/README.md for the audit story.
//
// This file just registers the SW (once per page load) and exposes
//   await window.LynxsealPdfjs.openViewer(iframeElement);
// which navigates the iframe to the viewer and resolves with the
// initialized PDFViewerApplication. The caller then does:
//   app.open({ data: arrayBuffer });

(function () {
  'use strict';

  const SW_URL = '/pdfjs/sw.js';
  const SW_SCOPE = '/pdfjs/';
  const VIEWER_URL = '/pdfjs/web/viewer.html';

  // Register once per page load and wait until the SW for our /pdfjs/ scope
  // is active. We can't use navigator.serviceWorker.ready because that only
  // resolves when an SW controls the *current document* — and the portal
  // page isn't under /pdfjs/ scope, so nothing ever controls it.
  let _readyPromise = null;
  function _ensureReady() {
    if (_readyPromise) return _readyPromise;
    if (!('serviceWorker' in navigator)) {
      _readyPromise = Promise.reject(new Error('Service workers not supported in this browser'));
      return _readyPromise;
    }
    _readyPromise = (async () => {
      const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
      if (reg.active) return reg;
      const sw = reg.installing || reg.waiting;
      if (!sw) throw new Error('SW registered but has no installing/waiting/active worker');
      await new Promise((resolve) => {
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated') resolve();
        });
      });
      return reg;
    })();
    return _readyPromise;
  }

  async function openViewer(iframe) {
    await _ensureReady();
    return new Promise((resolve, reject) => {
      iframe.addEventListener('load', function onLoad() {
        iframe.removeEventListener('load', onLoad);
        const w = iframe.contentWindow;
        const app = w && w.PDFViewerApplication;
        if (!app) return reject(new Error('PDFViewerApplication not on iframe window'));
        // initializedPromise resolves once the viewer is ready to receive
        // .open() calls (toolbar wired up, L10n loaded, event bus etc.).
        Promise.resolve(app.initializedPromise || null)
          .then(() => resolve(app))
          .catch(reject);
      });
      iframe.src = VIEWER_URL;
    });
  }

  window.LynxsealPdfjs = { openViewer };
})();
