// pdf.js viewer loader. The viewer lives at a different origin
// (pdfjs.lynxseal.com) so a parser/XSS bug in pdf.js is sandboxed away
// from anything sensitive on portal / wrapper origins.
//
// API (unchanged from caller's perspective):
//   const app = await window.LynxsealPdfjs.openViewer(iframe);
//   await app.open({ data: arrayBuffer });          // PDF bytes
//   await app.open({ data: arrayBuffer, hideToolbarIds: ['print', ...] });

(function () {
  'use strict';

  const VIEWER_ORIGIN = 'https://pdfjs.lynxseal.com';
  const VIEWER_URL = VIEWER_ORIGIN + '/web/viewer.html';

  // One global message listener — routes by iframe + id to the right pending
  // promise. Avoids leaking N listeners per simultaneous viewer.
  const _pendingByIframe = new WeakMap(); // iframe → Map(id → {resolve,reject})
  const _readyByIframe = new WeakMap();   // iframe → {resolve,reject}

  window.addEventListener('message', (e) => {
    if (e.origin !== VIEWER_ORIGIN) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;

    // Find the iframe this message came from (e.source is its window).
    let targetIframe = null;
    for (const f of document.querySelectorAll('iframe')) {
      if (f.contentWindow === e.source) { targetIframe = f; break; }
    }
    if (!targetIframe) return;

    if (m.type === 'pdfjs:ready') {
      const r = _readyByIframe.get(targetIframe);
      if (r) { _readyByIframe.delete(targetIframe); r.resolve(); }
      return;
    }
    if (m.type === 'pdfjs:opened' || m.type === 'pdfjs:stampsAdded') {
      const pendings = _pendingByIframe.get(targetIframe);
      if (!pendings) return;
      const p = pendings.get(m.id);
      if (!p) return;
      pendings.delete(m.id);
      p.resolve(m);
      return;
    }
    if (m.type === 'pdfjs:stampRects') {
      const pendings = _pendingByIframe.get(targetIframe);
      if (!pendings) return;
      const p = pendings.get(m.id);
      if (!p) return;
      pendings.delete(m.id);
      p.resolve(m.rects);
      return;
    }
    if (m.type === 'pdfjs:error') {
      const pendings = _pendingByIframe.get(targetIframe);
      if (!pendings) return;
      const p = pendings.get(m.id);
      if (!p) return;
      pendings.delete(m.id);
      p.reject(new Error(m.message || 'pdf.js error'));
    }
  });

  let _nextId = 0;

  async function openViewer(iframe) {
    // Wait for the viewer to be ready (it posts pdfjs:ready once
    // PDFViewerApplication.initializedPromise resolves).
    const readyPromise = new Promise((resolve, reject) => {
      _readyByIframe.set(iframe, { resolve, reject });
    });
    iframe.src = VIEWER_URL;
    await readyPromise;

    function send(msg, transfer) {
      const id = ++_nextId;
      return new Promise((resolve, reject) => {
        let pendings = _pendingByIframe.get(iframe);
        if (!pendings) { pendings = new Map(); _pendingByIframe.set(iframe, pendings); }
        pendings.set(id, { resolve, reject });
        iframe.contentWindow.postMessage({ ...msg, id }, VIEWER_ORIGIN, transfer || []);
      });
    }

    return {
      open(opts) {
        const msg = { type: 'pdfjs:open', data: opts.data };
        if (opts.hideToolbarIds) msg.hideToolbarIds = opts.hideToolbarIds;
        // Transfer ArrayBuffer to avoid the copy. Caller can pass a clone
        // if they want to keep using opts.data afterwards.
        const transfer = opts.data instanceof ArrayBuffer ? [opts.data] : [];
        return send(msg, transfer);
      },
      // Add a draggable stamp overlay on each page. stampSrc is a data: or
      // blob: URL of the stamp image. stampWidth/Height are in PDF units
      // (used for initial sizing). Resolves once overlays are placed.
      addStamps(opts) {
        return send({
          type: 'pdfjs:addStamps',
          stampSrc: opts.stampSrc,
          stampWidth: opts.stampWidth,
          stampHeight: opts.stampHeight,
        });
      },
      // Returns { pageNum (1-based): [pdfX, pdfY, pdfW, pdfH], ... } for the
      // current overlay positions, in PDF coordinates.
      getStampRects() {
        return send({ type: 'pdfjs:getStampRects' });
      },
    };
  }

  window.LynxsealPdfjs = { openViewer };
})();
