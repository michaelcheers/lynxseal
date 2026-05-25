# `/pdfjs/`

Embedded pdf.js viewer.

## Files

- **`pdfjs-5.7.284-dist.zip`** — the upstream Mozilla pdf.js release ZIP,
  committed verbatim. Pinned by sha256 in `sw.js`.

  Reproduce:

  ```sh
  curl -L -o pdfjs-5.7.284-dist.zip \
    https://github.com/mozilla/pdf.js/releases/download/v5.7.284/pdfjs-5.7.284-dist.zip
  sha256sum pdfjs-5.7.284-dist.zip
  # 6d1b81252d76358df5831567d7d551f40ebae0cd8e0a554694bc4df0d3db8715
  ```

- **`sw.js`** — service worker, scoped to `/pdfjs/`. On the first fetch
  under this subpath it:
  1. Fetches `fflate@0.8.3` from jsdelivr, sha256-verifies the bytes
     against the pin in `FFLATE_SHA256_B64`, then evaluates the verified
     UMD source in the SW global (via `new Function`). SW contexts don't
     have `URL.createObjectURL`, so the usual blob-URL + `<script
     integrity>` pattern isn't available — we manually hash-check the
     bytes and run them, same effect.
  2. Fetches the ZIP, sha256-verifies it against `ZIP_SHA256_HEX`,
     decompresses with the now-trusted fflate, and serves the archive
     entries with proper Content-Types.

  Applies two source-level rewrites to `web/viewer.mjs` before serving:
  - Default-URL literal `"compressed.tracemonkey-pldi-09.pdf"` → `""`
    (so the viewer doesn't try to auto-open a missing demo PDF on startup —
    we always open via `PDFViewerApplication.open()` ourselves)
  - `defaultOptions.disablePreferences.value: false` → `true`
    (no IndexedDB-backed preferences, no console warning about preferences
    overriding manually set AppOptions)

  Everything else is served byte-for-byte from the ZIP.

## Audit

Two files = the entire pdf.js audit surface:

1. **The ZIP**: compare its sha256 to the upstream release hash above.
2. **`sw.js`**: read it. It does only what's described here.

Tampering at either end fails closed — the hash check in `sw.js` refuses
to extract a ZIP whose bytes don't match, so a substituted ZIP can't
serve poisoned JS to the viewer iframe.

## URL layout

The viewer is iframed at `/pdfjs/web/viewer.html`. All of pdf.js's
relative URL machinery (cmaps, fonts, wasm, locale `.ftl` bundles,
`viewer.css`'s `url(images/...)` references, the worker script, etc.)
resolves naturally over real HTTP responses served from the SW — no
`<base href>` injection, no fetch interceptor inside the iframe, no CSS
or HTML pre-processing in the loader.
