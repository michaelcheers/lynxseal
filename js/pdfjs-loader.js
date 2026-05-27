// Audit-friendly pdf.js viewer loader.
//
// Instead of vendoring 500+ files from the pdf.js release ZIP — where
// a single malicious in-repo edit would be invisible in the noise — this
// loader takes the upstream release ZIP as a single committed binary
// (lib/pdfjs/pdfjs-5.7.284-dist.zip), hash-verifies it client-side, and
// extracts it in-browser via fflate. Every viewer file is then served
// from blob URLs derived from the verified bytes.
//
// Audit story:
//
//   sha256sum lib/pdfjs/pdfjs-5.7.284-dist.zip
//   # should print: 6d1b81252d76358df5831567d7d551f40ebae0cd8e0a554694bc4df0d3db8715
//   # compare with: github.com/mozilla/pdf.js/releases/download/v5.7.284/pdfjs-5.7.284-dist.zip
//
// Plus read this file. Two files = the entire audit surface for pdf.js.
//
// Usage:
//   await window.LynxsealPdfjs.openViewer(iframeElement, pdfBlob);

(function () {
  'use strict';

  const PDFJS_VERSION = '5.7.284';
  const ZIP_URL = '/lib/pdfjs/pdfjs-' + PDFJS_VERSION + '-dist.zip';
  // Pinned to the bytes of the upstream GitHub release. If anyone tampers
  // with the local zip, the extract step throws before any viewer code runs.
  const ZIP_SHA256_HEX =
    '6d1b81252d76358df5831567d7d551f40ebae0cd8e0a554694bc4df0d3db8715';

  // Single in-flight promise — extract once per page load, then reuse.
  let _extractedPromise = null;

  function _toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  async function _extractZip() {
    const resp = await fetch(ZIP_URL);
    if (!resp.ok) throw new Error('Failed to fetch pdf.js zip: HTTP ' + resp.status);
    const zipBytes = new Uint8Array(await resp.arrayBuffer());

    // Hash-verify against the pinned upstream sha. Defense in depth — if
    // a build pipeline (or attacker) ever substitutes the file in the
    // deployment without updating ZIP_SHA256_HEX, the viewer fails closed.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', zipBytes));
    const digestHex = _toHex(digest);
    if (digestHex !== ZIP_SHA256_HEX) {
      throw new Error(
        'pdf.js zip integrity check failed. Expected ' + ZIP_SHA256_HEX +
        ', got ' + digestHex + '. Refusing to extract.'
      );
    }

    // fflate's unzipSync gives us { 'web/viewer.html': Uint8Array(...), ... }
    if (!window.fflate || !window.fflate.unzipSync) {
      throw new Error('fflate not loaded — script tag missing or blocked?');
    }
    const files = window.fflate.unzipSync(zipBytes);

    // Convert every file to a blob URL keyed by its archive path. The
    // monkey-patched fetch inside the viewer iframe resolves runtime
    // requests against this map.
    const blobUrls = Object.create(null);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('/')) continue; // skip directory entries
      const mime = _guessMime(name);
      blobUrls[name] = URL.createObjectURL(new Blob([bytes], { type: mime }));
    }
    return { files, blobUrls };
  }

  function _guessMime(name) {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    return ({
      html: 'text/html',
      css: 'text/css',
      mjs: 'text/javascript',
      js: 'text/javascript',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      gif: 'image/gif',
      ico: 'image/x-icon',
      wasm: 'application/wasm',
      ftl: 'text/plain',
      bcmap: 'application/octet-stream',
      pfb: 'application/octet-stream',
      ttf: 'font/ttf',
      icc: 'application/vnd.iccprofile',
      map: 'application/json',
    }[ext] || 'application/octet-stream');
  }

  function _getExtracted() {
    if (!_extractedPromise) _extractedPromise = _extractZip();
    return _extractedPromise;
  }

  // Build the inline init script we splice into viewer.html. This runs INSIDE
  // the iframe before viewer.mjs loads. It:
  //   - rewrites runtime URLs (cMapUrl, standardFontDataUrl, workerSrc,
  //     wasmUrl, iccUrl, sandboxBundleSrc) to point at a virtual prefix
  //     "lynxseal://pdfjs/" that we then intercept;
  //   - monkey-patches window.fetch + Worker + URL parsing so any request
  //     under that prefix is served from the blob URL map injected by the
  //     parent.
  function _buildInitScript(blobUrls) {
    // Serializing the blobUrls map as JSON is fine — values are short
    // blob:https://... URLs from the parent's origin.
    const mapJson = JSON.stringify(blobUrls);
    return `
      (function () {
        const BLOB_URLS = ${mapJson};

        // Pattern-based blob lookup. The viewer (and viewer.mjs at runtime)
        // constructs URLs like "../web/cmaps/Adobe-CNS1-UCS2.bcmap" relative
        // to its own (about:srcdoc) location, which the browser resolves
        // against the parent's URL → "https://parent/web/cmaps/X.bcmap".
        // We strip everything before the recognizable "/web/" or "/build/"
        // segment and look up the rest in BLOB_URLS, where keys are the
        // archive-relative paths ("web/cmaps/X.bcmap", "build/pdf.worker.mjs").
        function resolveBlob(rawUrl) {
          if (!rawUrl) return null;
          let urlStr;
          try { urlStr = new URL(String(rawUrl), location.href).href; }
          catch { urlStr = String(rawUrl); }
          const m = urlStr.match(/\\/((?:web|build)\\/[^?#]+)/);
          if (m && BLOB_URLS[m[1]]) return BLOB_URLS[m[1]];
          return null;
        }

        // Monkey-patch fetch. Cmaps, fonts, wasm, iccs, locale .ftl files
        // all go through fetch() inside the bundled viewer.mjs.
        const origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url);
          const blob = resolveBlob(url);
          if (blob) return origFetch(blob, init);
          return origFetch(input, init);
        };

        // Same for Worker — pdf.js does new Worker(workerSrc, { type:'module' }).
        const OrigWorker = window.Worker;
        function PatchedWorker(script, opts) {
          const blob = resolveBlob(script);
          return new OrigWorker(blob || script, opts);
        }
        PatchedWorker.prototype = OrigWorker.prototype;
        window.Worker = PatchedWorker;
      })();
    `;
  }

  // Modify the upstream viewer.html in-memory: replace the <script> / <link>
  // tags that reference siblings (viewer.css, viewer.mjs, locale/locale.json,
  // ../build/pdf.mjs) with blob URLs, and inject the init script before the
  // viewer.mjs <script>.
  function _buildViewerHtml(files, blobUrls, initScript) {
    const htmlBytes = files['web/viewer.html'];
    if (!htmlBytes) throw new Error('web/viewer.html missing from pdf.js zip');
    let html = new TextDecoder('utf-8').decode(htmlBytes);

    // Map of href/src tokens in viewer.html → archive paths in the zip.
    const replacements = {
      'viewer.css': 'web/viewer.css',
      'viewer.mjs': 'web/viewer.mjs',
      '../build/pdf.mjs': 'build/pdf.mjs',
      'locale/locale.json': 'web/locale/locale.json',
    };
    for (const [token, archivePath] of Object.entries(replacements)) {
      const blob = blobUrls[archivePath];
      if (!blob) {
        console.warn('pdfjs-loader: blob URL missing for', archivePath);
        continue;
      }
      // Replace inside src="..." or href="...". The tokens are distinctive
      // enough that a plain string replace is fine.
      html = html.split('"' + token + '"').join('"' + blob + '"');
    }

    // Inject init script just before the closing </head>. It must run before
    // viewer.mjs (which is loaded with type=module — modules defer by default,
    // so a non-module inline script in <head> beats them to execution).
    html = html.replace(
      /<\/head>/i,
      '<script>' + initScript + '<\/script></head>'
    );
    return html;
  }

  // Loads the viewer into the given iframe and resolves with
  // PDFViewerApplication once it's ready for the caller to invoke .open()
  // (with a URL, ArrayBuffer, or whatever). Caller is responsible for
  // hiding toolbar elements / etc. after open().
  async function openViewer(iframe) {
    const { files, blobUrls } = await _getExtracted();
    const initScript = _buildInitScript(blobUrls);
    const html = _buildViewerHtml(files, blobUrls, initScript);

    return new Promise((resolve, reject) => {
      iframe.addEventListener('load', function onLoad() {
        iframe.removeEventListener('load', onLoad);
        // viewer.mjs initializes PDFViewerApplication asynchronously after
        // the iframe load event. initializedPromise resolves when it's
        // safe to call .open(). Older fallback is webViewerLoaded event.
        const w = iframe.contentWindow;
        const app = w && w.PDFViewerApplication;
        if (!app) return reject(new Error('PDFViewerApplication not on iframe window'));
        Promise.resolve(app.initializedPromise || null)
          .then(() => resolve(app))
          .catch(reject);
      });
      // srcdoc rather than blob: navigation keeps the iframe same-origin
      // with the parent (no sandbox), so iframe.contentDocument/iframe.contentWindow
      // remain accessible for toolbar tweaks after open().
      iframe.srcdoc = html;
    });
  }

  window.LynxsealPdfjs = { openViewer };
})();
