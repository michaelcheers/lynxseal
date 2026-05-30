// Verify-document page logic. Extracted from inline <script> so the page's
// CSP can drop 'unsafe-inline' for script-src.

'use strict';

// === Load the unwrapped pdfjs-dist@1.0.813 with a runtime integrity check ===
// 1. fetch CDN pdf.combined.js under the original SRI (verifies upstream)
// 2. strip the outer IIFE wrapper (same substring logic as the prebake)
// 3. hash the stripped result
// 4. inject <script src="/lib/pdfjs-1.0.813-unwrapped.js" integrity="sha256-<hash>">
// Browser refuses to execute the self-hosted file if its bytes don't match
// the runtime-computed hash → tampering on either side gets caught.
const pdfjsReady = (async () => {
  const CDN_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@1.0.813/build/pdf.combined.js';
  const CDN_SRI = 'sha256-3gYIJL0OvzCRSjv9rjGha+ht+C8okq/zH+fyIqX6K9g=';
  const OPEN = '(function pdfjsWrapper() {';
  const CLOSE = "}).call((typeof window === 'undefined') ? this : window);";
  const resp = await fetch(CDN_URL, { integrity: CDN_SRI, referrerPolicy: 'no-referrer' });
  if (!resp.ok) throw new Error('pdf.js CDN fetch failed: ' + resp.status);
  const text = await resp.text();
  const o = text.indexOf(OPEN);
  const c = text.lastIndexOf(CLOSE);
  if (o < 0 || c < 0) throw new Error('pdf.js IIFE markers not found');
  const stripped = text.substring(o + OPEN.length, c);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stripped));
  const integrity = 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(digest)));
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.integrity = integrity;
    s.crossOrigin = 'anonymous';
    s.src = '/lib/pdfjs-1.0.813-unwrapped.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('pdf.js self-origin script load failed (integrity mismatch?)'));
    document.head.appendChild(s);
  });
})();

// Will be filled from /api/public-context. SupportsQR controls the QR
// verification flow (hash-based) vs PDF-only verification.
let SUPPORTS_QR = false;
let ASSOCIATION = null;

(async () => {
  try {
    const ctx = await api.get('/api/public-context');
    SUPPORTS_QR = !!ctx.association.supportsQr;
    ASSOCIATION = ctx.association;
    document.getElementById('assocName1').textContent = ctx.association.name;
    document.getElementById('assocName2').textContent = ctx.association.name;
    if (SUPPORTS_QR) document.getElementById('certNumberGroup').style.display = '';
    // Stamp metadata renders inline for every tenant (the old non-ATIO
    // fullscreen-overlay + "View Details" modal is gone). The details card
    // is styled by verify-document.html's .meta-* rules.
    document.getElementById('mainContent').style.display = '';
    // Bootstrap trusted certificates + start auto-verify if URL has #key
    initVerification(ctx.rootCertificateBase64, ctx.oldRootCertificateBase64);
  } catch (e) {
    document.body.innerHTML = '<p style="padding:2em;color:#900">Failed to load: ' + (e.message || e) + '</p>';
  }
})();

// Wire the form submit to performVerification (replaces the inline onsubmit=).
document.getElementById('verifyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  performVerification();
});

// Language toggle
function switchLanguage(lang) {
  document.body.classList.toggle('lang-fr', lang === 'fr');
  document.body.classList.toggle('lang-en', lang !== 'fr');
  const url = new URL(location.href);
  if (lang === 'fr') url.searchParams.set('lang', 'fr'); else url.searchParams.delete('lang');
  history.replaceState(null, '', url.toString());
}
switchLanguage(new URLSearchParams(location.search).get('lang') || 'en');

function fromCustomBase64(s) {
  return s.replaceAll('-', 'O').replaceAll('=', 'l').padEnd(Math.ceil(s.length / 4) * 4, '=');
}
function reportErrorAlert(e) { console.error(e); alert(e.message || e); }
function getErrorOrNull(e) {
  if (e && e.message && e.message.startsWith('SuperSigning.UserVisibleException:')) return e.message.replace(/^SuperSigning\.UserVisibleException:\s*/, '');
  return null;
}

// Trust anchor — populated from /api/public-context root cert(s). Each entry
// is a node-forge X.509 certificate. trustedCaStore is the same set indexed
// by forge.pki.createCaStore for chain validation.
let trustedCertificates = [];
let trustedCaStore = null;

async function initVerification(rootCertB64, oldRootCertB64) {
  const b64s = [rootCertB64];
  if (!SUPPORTS_QR && oldRootCertB64) b64s.push(oldRootCertB64);
  trustedCertificates = b64s.map(b64 => {
    // base64 → binary string → DER bytes → forge cert
    const der = forge.util.decode64(b64);
    const asn1 = forge.asn1.fromDer(der);
    return forge.pki.certificateFromAsn1(asn1);
  });
  trustedCaStore = forge.pki.createCaStore(trustedCertificates);
  // If URL has #<18-char key>, auto-verify via QR flow.
  if (SUPPORTS_QR && location.hash && location.hash.length >= 2) checkQRCode();
}

function parseParameters(hash = window.location.hash.substring(1)) {
  if (hash.length !== 18) return null;
  hash = fromCustomBase64(hash);
  return [hash.substring(0, 4), hash.substring(4)];
}

// node-forge buffer / asn1 helpers all speak "binary strings" (one char per
// byte). These two helpers convert between Uint8Array (what Web APIs return)
// and forge's binary-string convention without leaking signed/unsigned bugs.
function _bytesToBinaryStr(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return s;
}
function _binaryStrToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// node-forge does RSA in pure JS — ~10× slower than native. Hand the actual
// signature verification to WebCrypto's SubtleCrypto while keeping forge for
// ASN.1 / cert parsing. Used for both the SignerInfo signature check and each
// chain link (signerCert signed by trusted root).
async function _webCryptoVerifyRSA(forgePublicKey, signatureBytes, dataBytes) {
  const spkiDer = forge.asn1.toDer(forge.pki.publicKeyToAsn1(forgePublicKey)).getBytes();
  const spkiU8 = _binaryStrToBytes(spkiDer);
  const key = await crypto.subtle.importKey(
    'spki', spkiU8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const sigU8 = typeof signatureBytes === 'string' ? _binaryStrToBytes(signatureBytes) : signatureBytes;
  const dataU8 = dataBytes instanceof Uint8Array ? dataBytes : _binaryStrToBytes(dataBytes);
  return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sigU8, dataU8);
}

// Verify cert was signed by issuer's public key. Replaces the RSA-verify part
// of forge.pki.verifyCertificateChain with WebCrypto; we still check issuer
// match and validity dates manually below.
async function _webCryptoVerifyCertSignedBy(cert, issuerCert) {
  const tbsDer = forge.asn1.toDer(forge.pki.getTBSCertificate(cert)).getBytes();
  return await _webCryptoVerifyRSA(issuerCert.publicKey, cert.signature, _binaryStrToBytes(tbsDer));
}

function _certIssuerMatches(cert, issuerCert) {
  const a = cert.issuer.attributes, b = issuerCert.subject.attributes;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].type !== b[i].type || a[i].value !== b[i].value) return false;
  return true;
}

function _certValid(cert, when) {
  return when >= cert.validity.notBefore && when <= cert.validity.notAfter;
}

async function checkDigitalSignatureInternal(buffer, viewable = false) {
  try {
    signingInfoDetails.innerHTML = '';
    const view = new Uint8Array(buffer);

    // === PDF parse: walk to the signature dict's /ByteRange + /Contents ===
    // Awaits the integrity-checked unwrapped pdfjs-dist@1.0.813 load (top of
    // file). Once resolved, PDFDocument + isRef are window globals — the
    // legacy pre-modern API with lazy xref-only parsing, orders of magnitude
    // faster than pdf-lib's eager full-document parse on large PDFs.
    await pdfjsReady;
    let pdf;
    try {
      pdf = new window.PDFDocument(null, view, null);
      pdf.parseStartXRef();
      pdf.parse();
    } catch (e) { throw new Error('Wrong structure of PDF!'); }
    const acroForm = pdf.xref.root.get('AcroForm');
    if (typeof acroForm === 'undefined') throw new Error('The PDF has no signature!');
    const fields = acroForm.get('Fields');
    if (!fields || !fields.length || !window.isRef(fields[0])) throw new Error('Wrong structure of PDF!');
    const sigField = pdf.xref.fetch(fields[0]);
    const sigFieldType = sigField.get('FT');
    if (typeof sigFieldType === 'undefined' || sigFieldType.name !== 'Sig') throw new Error('Wrong structure of PDF!');
    const v = sigField.get('V');
    const byteRange = v.get('ByteRange');
    if (!byteRange || byteRange.length !== 4) throw new Error('Wrong structure of PDF!');
    // /Contents is a binary string (one char per byte) in this pdf.js era —
    // convert to Uint8Array for the ASN.1 parser below.
    const contents = v.get('Contents');
    const contentBytes = new Uint8Array(contents.length);
    for (let i = 0; i < contents.length; i++) contentBytes[i] = contents.charCodeAt(i);

    // === Bytes covered by the signature: [a..a+b) and [c..c+d) ===
    const signedData = new Uint8Array(byteRange[1] + byteRange[3]);
    let cursor = 0;
    signedData.set(view.subarray(byteRange[0], byteRange[0] + byteRange[1]), cursor); cursor += byteRange[1];
    signedData.set(view.subarray(byteRange[2], byteRange[2] + byteRange[3]), cursor);

    // === Parse the PKCS#7 detached SignedData blob ===
    // /Contents is zero-padded to CSIZE bytes after the actual ASN.1
    // structure ends, so parseAllBytes=false stops the forge parser at the
    // SignedData SEQUENCE's natural end instead of choking on the padding.
    const p7Asn1 = forge.asn1.fromDer(_bytesToBinaryStr(contentBytes), { parseAllBytes: false });
    const p7 = forge.pkcs7.messageFromAsn1(p7Asn1);
    if (!p7.certificates || p7.certificates.length !== 1) throw new Error('Number of certificates in signature invalid!');
    const signerCert = p7.certificates[0];
    const signerInfo = p7.rawCapture.signerInfos && p7.rawCapture.signerInfos[0];
    if (!signerInfo) throw new Error('No SignerInfo present');

    // === SignerInfo fields ===
    //   value[0] = version
    //   value[1] = issuerAndSerialNumber
    //   value[2] = digestAlgorithm (SEQUENCE { OID, ... })
    //   value[3] = [0] IMPLICIT signedAttrs (present)
    //   value[4] = signatureAlgorithm
    //   value[5] = signature OCTET STRING
    const digestAlgOid = forge.asn1.derToOid(signerInfo.value[2].value[0].value);
    if (digestAlgOid !== forge.pki.oids.sha256) throw new Error('Invalid hashing algorithm');
    const signedAttrsAsn1 = signerInfo.value[3];
    if (!signedAttrsAsn1 || signedAttrsAsn1.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || signedAttrsAsn1.type !== 0)
      throw new Error('signedAttrs is not present.');
    const signatureBytes = signerInfo.value[5].value; // octet string contents

    // === Verify: doc SHA-256 == messageDigest attribute ===
    // WebCrypto for the big hash — forge.md.sha256 is pure JS and crawls on
    // multi-MB PDFs.
    const docDigestBuf = await crypto.subtle.digest('SHA-256', signedData);
    const docDigestHex = Array.from(new Uint8Array(docDigestBuf), b => b.toString(16).padStart(2, '0')).join('');

    // SignedAttributes is a SET of Attribute { type OID, values SET OF ANY }.
    // Find type=messageDigest (1.2.840.113549.1.9.4), value is an OCTET STRING.
    let messageDigestHex = null;
    for (const attr of signedAttrsAsn1.value) {
      const attrOid = forge.asn1.derToOid(attr.value[0].value);
      if (attrOid === forge.pki.oids.messageDigest) {
        // attr.value[1] is the SET OF values, first element is the OCTET STRING
        messageDigestHex = forge.util.bytesToHex(attr.value[1].value[0].value);
        break;
      }
    }
    if (!messageDigestHex) throw new Error("No signed attribute 'MessageDigest'");
    if (messageDigestHex !== docDigestHex) throw new Error('Hash is not correct');

    // === Verify: cert chains to one of the trusted roots ===
    // Per-trust-anchor loop so the "old CA" path is tried separately. RSA
    // signature verify is done via WebCrypto (native, fast); issuer match
    // and validity dates are checked manually.
    let trustedIndex = -1;
    const now = new Date();
    if (!_certValid(signerCert, now)) throw new Error('Certificate not currently valid');
    for (let i = 0; i < trustedCertificates.length; i++) {
      const root = trustedCertificates[i];
      if (!_certIssuerMatches(signerCert, root)) continue;
      if (!_certValid(root, now)) continue;
      if (await _webCryptoVerifyCertSignedBy(signerCert, root)) { trustedIndex = i; break; }
    }
    if (trustedIndex < 0) throw new Error('Signature verification failed');

    // === Verify: RSA signature over DER(SignedAttributes as SET) ===
    // Signed bytes are the DER encoding of the SignedAttributes structure
    // RE-TAGGED as a UNIVERSAL SET (tag 0x31) rather than the [0] IMPLICIT
    // context-specific tag it had in the SignerInfo. Spec: RFC 5652 §5.4.
    // WebCrypto hashes internally for RSASSA-PKCS1-v1_5 + SHA-256, so we
    // pass the raw signedAttrsDer bytes, not a pre-computed digest.
    const reTagged = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SET,
      true,
      signedAttrsAsn1.value,
    );
    const signedAttrsDer = forge.asn1.toDer(reTagged).getBytes();
    const sigOk = await _webCryptoVerifyRSA(signerCert.publicKey, signatureBytes, _binaryStrToBytes(signedAttrsDer));
    if (!sigOk) throw new Error('Signature verification failed');

    // === Extract org name (O attribute) from signer cert subject for display ===
    let associationName;
    for (const attr of signerCert.subject.attributes) {
      if (attr.type === forge.pki.oids.organizationName || attr.shortName === 'O') {
        associationName = attr.value; break;
      }
    }
    if (associationName === undefined) throw new Error('Assocation of certificate not set');

    // Doc digest hex (already computed above) — used as the lookup key for
    // the server-side hash check.
    hashValue.value = docDigestHex;
    const makeStibcDialog = () => {
        signingInfo.style.color = 'green';
        signingInfo.innerText = document.body.classList.contains('lang-fr')
          ? '✅ Ce tampon numérique a été vérifié !'
          : '✅ This digital stamp was verified!';
        signingInfo.appendChild(document.createElement('br'));
        const tmpl = 'Society of Translators ';
        const isFr = document.body.classList.contains('lang-fr');
        const start = isFr ? "(Certifiée par l'" : '(Certified by the ';
        const end = ')';
        if (associationName.startsWith(tmpl)) {
          signingInfo.appendChild(new Text(`${start}${isFr ? 'Société des traducteurs' : 'Society of Translators'}`));
          signingInfo.appendChild(document.createElement('br'));
          signingInfo.appendChild(new Text(`${associationName.substr(tmpl.length)}${end}`));
        } else {
          if (isFr && associationName === 'Association of Translators and Interpreters of Ontario')
            associationName = "Association des traducteurs et interprètes de l'Ontario";
          signingInfo.appendChild(new Text(`${start}${associationName}${end}`));
        }
      };
      if (trustedIndex === 0) {
        let signatureDetails;
        try {
          signatureDetails = await api.post('/api/verify-document', { hash: hashValue.value, lang: document.body.classList.contains('lang-fr') ? 'fr' : '' });
        } catch (e) {
          throw new Error('SuperSigning.UserVisibleException: Cannot verify digital stamp: The connection to the server failed.');
        }
        const { TimeSigned: { Raw, Title }, Signer: { FullName, Email, MemberNumber, Association: Assoc }, DocumentDescription, LanguagePair } = signatureDetails;
        associationName = Assoc.LongName;
        makeStibcDialog();
        const fr = document.body.classList.contains('lang-fr');
        if (viewable) {
          signingInfo.appendChild(document.createElement('br'));
          signingInfo.appendChild(Object.assign(document.createElement('a'), {
            innerText: fr ? 'Voir le document' : 'View Document',
            href: 'javascript:void(0)',
            className: 'view-doc-link',
            onclick: () => {
              const blob = new Blob([buffer], { type: 'application/pdf' });
              const url = URL.createObjectURL(blob);
              window.open(url, '_blank');
            },
          }));
        }
        // Render stamp metadata inline as a clean key/value card. Styled by
        // the .meta-* rules in verify-document.html.
        const div = signingInfoDetails;
        div.replaceChildren();
        const section = (title) => {
          const h = document.createElement('div');
          h.className = 'meta-section';
          h.textContent = title;
          div.appendChild(h);
        };
        const row = (key, value) => {
          const r = document.createElement('div');
          r.className = 'meta-row';
          const k = document.createElement('span'); k.className = 'meta-key'; k.textContent = key;
          const v = document.createElement('span'); v.className = 'meta-val';
          if (value instanceof Node) v.appendChild(value); else v.textContent = value;
          r.append(k, v);
          div.appendChild(r);
        };
        section(fr ? 'Document' : 'Document');
        row(fr ? 'Nom' : 'Name', DocumentDescription);
        row(fr ? 'Paire de langues' : 'Language pair', LanguagePair);
        row(fr ? 'Date de tamponnage' : 'Date stamped',
            Object.assign(document.createElement('span'), { textContent: Title, title: Raw }));
        section(fr ? 'Tamponné par' : 'Stamped by');
        row(fr ? 'Nom' : 'Name', FullName);
        row(fr ? 'Courriel' : 'Email',
            Object.assign(document.createElement('a'), { textContent: Email, href: `mailto:${Email}`, target: '_blank' }));
        row(fr ? `Numéro de membre ${Assoc.Name}` : `${Assoc.Name} member number`, MemberNumber);
      } else makeStibcDialog();
  } catch (e) { reportVerifyFailure(e); }
}

function reportVerifyFailure(e) {
  console.error(e);
  if (hashValue.value === '') api.post('/api/verify-document', { hash: '' }).catch(() => {});
  hashValue.value = '';
  signingInfo.style.color = 'red';
  signingInfo.innerText = getErrorOrNull(e) ?? (document.body.classList.contains('lang-fr')
    ? "❌ Le tampon numérique n'a pas pu être vérifié.\nNous vous invitons à contacter le traducteur."
    : '❌ The digital stamp could not be verified.\nWe invite you to contact the translator.');
}

function checkDigitalSignature() {
  signingInfo.innerText = '';
  try {
    const file = translationPackage.files[0];
    const reader = new FileReader();
    reader.onload = async () => { try { await checkDigitalSignatureInternal(reader.result); } catch (e) { reportErrorAlert(e); } };
    reader.readAsArrayBuffer(file);
  } catch (e) { reportErrorAlert(e); }
}

function padEncryptionKey(key) {
  const out = new Uint8Array(32);
  out.set(key.slice(0, Math.min(key.length, 32)));
  return out;
}

async function decryptFile(encryptedFileBlob, base64Key) {
  try {
    const buf = await encryptedFileBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const magic = bytes.slice(0, 4);
    const isArgon = magic[0] === 0x41 && magic[1] === 0x52 && magic[2] === 0x47 && magic[3] === 0x32;
    let keyBytes, iv, ciphertext;
    if (isArgon) {
      const salt = bytes.slice(4, 20);
      const saltB64 = btoa(String.fromCharCode.apply(null, salt));
      const derivedB64 = await window.deriveKeyWithArgon2(base64Key, saltB64);
      keyBytes = Uint8Array.from(atob(derivedB64), c => c.charCodeAt(0));
      iv = bytes.slice(20, 36); ciphertext = bytes.slice(36);
    } else {
      keyBytes = padEncryptionKey(Uint8Array.from(atob(base64Key), c => c.charCodeAt(0)));
      iv = bytes.slice(0, 16); ciphertext = bytes.slice(16);
    }
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC', length: 256 }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, ciphertext);
    return new Uint8Array(decrypted);
  } catch (e) { console.error('Decryption failed:', e); return null; }
}

function performVerification() {
  const pdfFile = translationPackage.files && translationPackage.files[0];
  const verificationCode = SUPPORTS_QR ? certNumber.value.trim() : '';
  if (pdfFile && verificationCode) {
    signingInfo.style.color = 'red';
    signingInfo.innerText = document.body.classList.contains('lang-fr')
      ? 'Veuillez fournir soit un document PDF soit un code de vérification, pas les deux.'
      : 'Please provide either a PDF document or a verification code, not both.';
    return;
  }
  if (pdfFile) checkDigitalSignature();
  else if (SUPPORTS_QR && verificationCode) checkQRCode(verificationCode);
  else {
    signingInfo.style.color = 'red';
    signingInfo.innerText = document.body.classList.contains('lang-fr')
      ? (SUPPORTS_QR ? 'Veuillez fournir soit un document PDF soit un code de vérification.' : 'Veuillez fournir un document PDF.')
      : (SUPPORTS_QR ? 'Please provide either a PDF document or a verification code.' : 'Please provide a PDF document.');
  }
}

async function checkQRCode(key) {
  try {
    const params = parseParameters(key);
    if (!params) throw new Error('verify failed');
    const [qrId, encryptionKey] = params;
    const { downloadUrl } = await api.get(`/api/fetch-document?qrId=${encodeURIComponent(qrId)}`);
    if (!downloadUrl) throw new Error('Download URL not found in response.');
    const docResp = await fetch(downloadUrl);
    if (!docResp.ok) throw new Error(`Failed to download document content from S3: ${docResp.status}`);
    const encryptedFile = await docResp.blob();
    const pdfBytes = await decryptFile(encryptedFile, encryptionKey);
    if (!pdfBytes) throw new Error('Decryption failed.');
    await checkDigitalSignatureInternal(pdfBytes, true);
  } catch (e) {
    if (key !== undefined) { signingInfoDetails.innerHTML = ''; reportVerifyFailure(e); }
  }
}
