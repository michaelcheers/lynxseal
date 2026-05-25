# `/lib`

## `pdfjs-1.0.813-unwrapped.js`

This file is `pdfjs-dist@1.0.813`'s `build/pdf.combined.js` with the outer IIFE
wrapper stripped, so `var PDFDocument` + `function isRef` and friends attach
as window globals (which is the legacy API our verify-document.js consumes).

### Reproducing it

```sh
curl -s https://cdn.jsdelivr.net/npm/pdfjs-dist@1.0.813/build/pdf.combined.js > /tmp/pdf.combined.js
# Verify upstream SRI:
echo "$(openssl dgst -sha256 -binary /tmp/pdf.combined.js | openssl base64 -A)"
# Expect: 3gYIJL0OvzCRSjv9rjGha+ht+C8okq/zH+fyIqX6K9g=
node -e "
  const fs=require('fs');
  const t=fs.readFileSync('/tmp/pdf.combined.js','utf8');
  const O='(function pdfjsWrapper() {';
  const C=\"}).call((typeof window === 'undefined') ? this : window);\";
  fs.writeFileSync('pdfjs-1.0.813-unwrapped.js', t.substring(t.indexOf(O)+O.length, t.lastIndexOf(C)));
"
# Resulting SRI:
openssl dgst -sha256 -binary pdfjs-1.0.813-unwrapped.js | openssl base64 -A
# Expect: S49gWtlcODD025ZZOkaAbm2LLW3y94fxRYnF51j4SZ8=
```

### Runtime verification

`verify-document.js` re-derives the stripped hash at runtime: it fetches the
CDN file (under its known SRI), reapplies the same `substring` strip, hashes
the result, then injects `<script src="/lib/pdfjs-1.0.813-unwrapped.js"
integrity="sha256-<runtime-derived-hash>">`. The browser's SRI check refuses
to execute the self-origin file if its bytes don't match what the regex
would produce from current CDN — i.e. tampering on either side is caught.

### Why an unwrapped variant at all

The legacy SuperSigning verify page used the pre-modern `PDFDocument` /
`xref.fetch` API (lazy xref-only parsing). Modern pdf.js hides this behind
an async worker proxy that doesn't expose `/ByteRange` or `/Contents`. The
npm-published `pdfjs-dist` (all versions) wraps everything in an IIFE that
hides core classes. So we use the earliest npm version (1.0.813) and strip
the wrapper to recover the legacy API surface.

Only the parse path is used — no rendering, font loading, or PostScript
evaluation. The two known pdfjs-dist CVEs (CVE-2024-4367 font_loader.js eval,
CVE-2018-5158 PostScript compiler) live on code paths we never invoke; the
page's strict CSP (no `'unsafe-eval'`) is the defense-in-depth backstop.
