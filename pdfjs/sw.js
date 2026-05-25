// Service worker that serves the pdf.js viewer out of an integrity-pinned
// upstream release ZIP. Scoped to /pdfjs/ so it can only intercept requests
// under this subpath — by design, it cannot accidentally take over any
// other portal route.
//
// Audit story is the same as before:
//
//   sha256sum pdfjs/pdfjs-5.7.284-dist.zip
//   # should print: 6d1b81252d76358df5831567d7d551f40ebae0cd8e0a554694bc4df0d3db8715
//   # compare with: github.com/mozilla/pdf.js/releases/download/v5.7.284/pdfjs-5.7.284-dist.zip
//
// Plus read this file. Two files = the entire pdf.js audit surface.
//
// Why a SW instead of monkey-patching fetch from the iframe: pdf.js uses
// relative URLs everywhere (viewer.css → url(images/foo.svg), L10n →
// new URL(path, baseURL), worker construction, etc.). Serving the ZIP via
// real HTTP responses lets all of that work as designed — no <base> hack,
// no fetch interceptor, no CSS pre-processing, no srcdoc juggling.

'use strict';

const ZIP_URL = '/pdfjs/pdfjs-5.7.284-dist.zip';
const ZIP_SHA256_HEX =
  '6d1b81252d76358df5831567d7d551f40ebae0cd8e0a554694bc4df0d3db8715';

// fflate UMD bundle from jsdelivr, pinned by sha256. importScripts() doesn't
// support SRI directly, so we fetch it, hash-verify the bytes against the
// pin, then importScripts the resulting blob URL — same content the browser
// would have validated via <script integrity="..."> on the page side. The
// pin is the exact base64 string from the SRI attribute everywhere else in
// the codebase (no manual base64→hex conversion).
const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/umd/index.js';
const FFLATE_SHA256_B64 = 'Ri74BB/JcONhWiCp3SsuMEegc7Lacp708CtjS7qLe4M=';

// Activate immediately + take control of already-loaded pages so the first
// page load doesn't have to refresh to get SW-served responses.
self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

async function _sha256(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '', bin = '';
  for (let i = 0; i < d.length; i++) {
    hex += d[i].toString(16).padStart(2, '0');
    bin += String.fromCharCode(d[i]);
  }
  return { hex, b64: btoa(bin) };
}

// Fetch a remote script, sha256-verify against pin, then evaluate it in the
// SW global scope. We can't use the usual blob-URL + importScripts trick
// here because Service Worker contexts don't expose URL.createObjectURL
// (object URLs are tied to document lifecycle). Function() evaluation runs
// the UMD bundle whose self-detection lands on `self.fflate = factory()`.
let _fflateReady = null;
function ensureFflate() {
  if (_fflateReady) return _fflateReady;
  _fflateReady = (async () => {
    const resp = await fetch(FFLATE_URL);
    if (!resp.ok) throw new Error('SW: fflate fetch failed: ' + resp.status);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const { b64 } = await _sha256(bytes);
    if (b64 !== FFLATE_SHA256_B64) {
      throw new Error('SW: fflate integrity check failed. Expected sha256-' + FFLATE_SHA256_B64 + ', got sha256-' + b64);
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    // eslint-disable-next-line no-new-func
    new Function(text)();
    if (typeof self.fflate?.unzipSync !== 'function') {
      throw new Error('SW: fflate loaded but did not attach to self.fflate');
    }
  })();
  return _fflateReady;
}

let _filesPromise = null;
function getFiles() {
  if (_filesPromise) return _filesPromise;
  _filesPromise = (async () => {
    await ensureFflate();
    const resp = await fetch(ZIP_URL);
    if (!resp.ok) throw new Error('SW: pdf.js zip fetch failed: ' + resp.status);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    // Hash-verify before trusting any byte from the archive. ZIP_SHA256_HEX
    // matches `sha256sum pdfjs-5.7.284-dist.zip` output for easy CLI audit.
    const { hex } = await _sha256(bytes);
    if (hex !== ZIP_SHA256_HEX) {
      throw new Error('SW: pdf.js zip integrity check failed. Expected ' + ZIP_SHA256_HEX + ', got ' + hex);
    }
    const files = fflate.unzipSync(bytes);

    // Pre-rewrite viewer.mjs to neuter two upstream behaviors that don't
    // make sense in our embedded use: auto-opening a default PDF on load
    // (we always call PDFViewerApplication.open() ourselves with a Blob),
    // and persistent IndexedDB-backed preferences (we want each viewer
    // session deterministic + no console warning about preferences
    // overriding AppOptions).
    if (files['web/viewer.mjs']) {
      let mjs = new TextDecoder('utf-8').decode(files['web/viewer.mjs']);
      mjs = mjs.replace('"compressed.tracemonkey-pldi-09.pdf"', '""');
      mjs = mjs.replace(
        /defaultOptions\.disablePreferences\s*=\s*\{[\s\S]*?value:\s*false/,
        m => m.replace('value: false', 'value: true')
      );
      files['web/viewer.mjs'] = new TextEncoder().encode(mjs);
    }
    return files;
  })();
  return _filesPromise;
}

function mimeFor(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ({
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    gif: 'image/gif',
    ico: 'image/x-icon',
    wasm: 'application/wasm',
    ftl: 'text/plain; charset=utf-8',
    bcmap: 'application/octet-stream',
    pfb: 'application/octet-stream',
    ttf: 'font/ttf',
    icc: 'application/vnd.iccprofile',
  }[ext] || 'application/octet-stream');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Only handle requests under our scope, and only for paths that aren't the
  // SW itself or the ZIP (which we serve directly from the static host so
  // getFiles() can fetch it without recursing).
  if (!url.pathname.startsWith('/pdfjs/')) return;
  if (url.pathname === '/pdfjs/sw.js') return;
  if (url.pathname === ZIP_URL) return;

  // Map /pdfjs/<archive-path> → archive entry, e.g. /pdfjs/web/viewer.html →
  // files['web/viewer.html']. /pdfjs/ or /pdfjs/web/ → web/viewer.html.
  event.respondWith((async () => {
    const files = await getFiles();
    let key = url.pathname.replace(/^\/pdfjs\//, '');
    if (key === '' || key === 'web/' || key === 'web') key = 'web/viewer.html';
    const bytes = files[key];
    if (!bytes) {
      return new Response('Not found in pdf.js archive: ' + key, { status: 404 });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': mimeFor(key),
        'Cache-Control': 'no-cache',
      },
    });
  })());
});
