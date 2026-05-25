// Loads argon2-bundled.min.js and exposes window.deriveKeyWithArgon2.
// Ported verbatim from Pages/Shared/_Layout.cshtml in the Razor app.
// Used by the QR/encryption flow on index.html and the verify flow on
// verify-document.html.

(function () {
  // Loaded from jsdelivr with SRI. The bundle inlines the WASM as base64
  // inside the JS, so the SRI hash covers both the loader and the
  // executable — no separate wasm fetch happens at runtime, no unhashed
  // download path.
  const script = document.createElement('script');
  // .src last — browsers may start the fetch as soon as src is set, and
  // attributes added afterward (integrity, crossorigin) might not apply to
  // the already-in-flight request.
  script.integrity = 'sha256-d8ZLlGuvGlEW3FkfS5ll1jaxtFX3Xt0tSlh8t14BaHs=';
  script.crossOrigin = 'anonymous';
  script.referrerPolicy = 'no-referrer';
  script.src = 'https://cdn.jsdelivr.net/npm/argon2-browser@1.18.0/dist/argon2-bundled.min.js';
  document.head.appendChild(script);

  window.deriveKeyWithArgon2 = async function (base64Key, saltBase64) {
    try {
      const keyBytes = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
      const salt = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));

      const result = await argon2.hash({
        pass: keyBytes,
        salt: salt,
        type: argon2.ArgonType.Argon2id,
        mem: 65536,
        time: 3,
        parallelism: 4,
        hashLen: 32,  // 256 bits
      });

      return btoa(String.fromCharCode.apply(null, result.hash));
    } catch (error) {
      console.error('Argon2 derivation failed:', error);
      throw error;
    }
  };
})();
