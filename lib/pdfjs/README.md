# pdf.js viewer — audit notes

This directory holds the verbatim upstream release archive
`pdfjs-5.7.284-dist.zip` from
[mozilla/pdf.js v5.7.284](https://github.com/mozilla/pdf.js/releases/tag/v5.7.284),
plus this README. Nothing else.

## How to audit

You **don't** need to check the ZIP itself. The loader
(`js/pdfjs-loader.js`) refuses to extract the ZIP at runtime unless its
sha256 matches a hardcoded constant. So any local tampering with this
ZIP fails closed in the browser before any viewer code runs.

What you actually audit is **the hash constant in the loader**. Open
`js/pdfjs-loader.js`, find `ZIP_SHA256_HEX`, and confirm it equals the
hash of the upstream release ZIP:

```sh
curl -sL https://github.com/mozilla/pdf.js/releases/download/v5.7.284/pdfjs-5.7.284-dist.zip | sha256sum
# 6d1b81252d76358df5831567d7d551f40ebae0cd8e0a554694bc4df0d3db8715
```

If they match, every byte the viewer ever executes is upstream-verified.
If they don't, the loader will refuse to boot in the browser anyway.

(The local ZIP doesn't enter the audit because the loader gates on the
hash — local tampering can't yield a viable viewer.)

## How it's loaded

`js/pdfjs-loader.js` on page load:

1. `fetch('/lib/pdfjs/pdfjs-5.7.284-dist.zip')`
2. `sha256(bytes) === ZIP_SHA256_HEX` — refuse to continue on mismatch
3. `fflate.unzipSync(bytes)` → file → `Uint8Array` map
4. Each file → `URL.createObjectURL(new Blob(...))` → blob URL map
5. `web/viewer.html` is decoded, its `<script>`/`<link>` references
   rewritten to the matching blob URLs, plus a small inline init script
   is injected
6. Set as `iframe.srcdoc` — viewer boots from extracted bytes only
7. Inside the iframe, fetch/Worker are monkey-patched so the bundled
   viewer.mjs's runtime fetches for cmaps/fonts/wasm/worker get
   redirected to the in-memory blob URLs

No file from this directory is ever served at a stable URL beyond the
ZIP itself, and that ZIP is hash-gated.

## Bumping pdf.js

1. Download `pdfjs-X.Y.Z-dist.zip` from the [pdf.js releases page](https://github.com/mozilla/pdf.js/releases)
2. Replace the file here
3. Update `PDFJS_VERSION` and `ZIP_SHA256_HEX` constants in `js/pdfjs-loader.js`
4. Re-test the three iframe call sites in `js/index-page.js`
