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
switchLanguage(new URLSearchParams(location.search).get('lang') || window.WRAPPER_LANG || 'en');

// fromCustomBase64 / getErrorOrNull / reportErrorAlert come from site.js (loaded
// before this script). A local fromCustomBase64 used to live here and had a
// padding bug (padEnd('=') → '==' instead of 'A=') that derived the wrong argon2
// key and broke every QR decrypt — keep the single canonical copy in site.js.

// Trust anchor — populated from /api/public-context root cert(s). Each entry
// is a node-forge X.509 certificate. trustedCaStore is the same set indexed
// by forge.pki.createCaStore for chain validation.
let trustedCertificates = [];
let trustedCaStore = null;

// DigiCert Trusted Root G4 — pinned trust anchor for the RFC 3161
// trusted-timestamp (PAdES-T) token. The signing flow stamps each signature
// with a DigiCert token; pinning the root means only DigiCert-issued tokens are
// trusted, regardless of who relayed the timestamp request. Self-contained: the
// token + its chain live in the PDF, so this verifies offline.
const DIGICERT_G4_ROOT_B64 =
  'MIIFkDCCA3igAwIBAgIQBZsbV56OITLiOQe9p3d1XDANBgkqhkiG9w0BAQwFADBiMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwHhcNMTMwODAxMTIwMDAwWhcNMzgwMTE1MTIwMDAwWjBiMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC/5pBzaN675F1KPDAiMGkz7MKnJS7JIT3yithZwuEppz1Yq3aaza57G4QNxDAf8xukOBbrVsaXbR2rsnnyyhHS5F/WBTxSD1Ifxp4VpX6+n6lXFllVcq9ok3DCsrp1mWpzMpTREEQQLt+C8weE5nQ7bXHiLQwb7iDVySAdYyktzuxeTsiT+CFhmzTrBcZe7FsavOvJz82sNEBfsXpm7nfISKhmV1efVFiODCu3T6cw2Vbuyntd463JT17lNecxy9qTXtyOj4DatpGYQJB5w3jHtrHEtWoYOAMQjdjUN6QuBX2I9YI+EJFwq1WCQTLX2wRzKm6RAXwhTNS8rhsDdV14Ztk6MUSaM0C/CNdaSaTC5qmgZ92kJ7yhTzm1EVgX9yRcRo9k98FpiHaYdj1ZXUJ2h4mXaXpI8OCiEhtmmnTK3kse5w5jrubU75KSOp493ADkRSWJtppEGSt+wJS00mFt6zPZxd9LBADMfRyVw4/3IbKyEbe7f/LVjHAsQWCqsWMYRJUadmJ+9oCw++hkpjPRiQfhvbfmQ6QYuKZ3AeEPlAwhHbJUKSWJbOUOUlFHdL4mrLZBdd56rF+NP8m800ERElvlEFDrMcXKchYiCd98THU/Y+whX8QgUWtvsauGi0/C1kVfnSD8oR7FwI+isX4KJpn15GkvmB0t9dmpsh3lGwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQU7NfjgtJxXWRM3y5nP+e6mK4cD08wDQYJKoZIhvcNAQEMBQADggIBALth2X2pbL4XxJEbw6GiAI3jZGgPVs93rnD5/ZpKmbnJeFwMDF/k5hQpVgs2SV1EY+CtnJYYZhsjDT156W1r1lT40jzBQ0CuHVD1UvyQO7uYmWlrx8GnqGikJ9yd+SeuMIW59mdNOj6PWTkiU0TryF0Dyu1Qen1iIQqAyHNm0aAFYF/opbSnr6j3bTWcfFqK1qI4mfN4i/RN0iAL3gTujJtHgXINwBQy7zBZLq7gcfJW5GqXb5JQbZaNaHqasjYUegbyJLkJEVDXCLG4iXqEI2FCKeWjzaIgQdfRnGTZ6iahixTXTBmyUEFxPT9NcCOGDErcgdLMMpSEDQgJlxxPwO5rIHQw0uA5NBCFIRUBCOhVMt5xSdkoF1BN5r5N0XWs0Mr7QbhDparTwwVETyw2m+L64kW4I1NsBm9nVX9GtUw/bihaeSbSpKhil9Ie4u1Ki7wb/UdKDd9nZn6yW0HQO+T0O/QEY+nvwlQAUaCKKsnOeMzV6ocEGLPOr0mIr/OSmbaz5mEP0oUA51Aa5BuVnRmhuZyxm7EAHu/QD09CbMkKvO5D+jpxpchNJqU1/YldvIViHTLSoCtU7ZpXwdv6EM8Zt4tKG48BtieVU+i2iW1bvGjUI+iLUaJW+fCmgKDWHrO8Dw9TdSmq6hN35N6MgSGtBxBHEa2HPQfRdbzP82Z+';

let _digicertG4 = null;
function _getDigicertG4() {
  if (!_digicertG4) {
    _digicertG4 = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(DIGICERT_G4_ROOT_B64)));
  }
  return _digicertG4;
}

// Verify the embedded RFC 3161 timestamp on a SignerInfo and return its
// genTime (Date) if valid, or null if no token is present. Throws if a token is
// present but invalid (tamper / wrong TSA / mismatched imprint), so a forged
// timestamp can't pass as a real one.
//
//   signerInfoAsn1 — the SignerInfo SEQUENCE (forge asn1 object)
//   signatureBytes — the SignerInfo signature value (binary string); the
//                    token's messageImprint must be SHA-256 of these bytes.
async function _verifyTimestamp(signerInfoAsn1, signatureBytes) {
  const ID_AA_TS = '1.2.840.113549.1.9.16.2.14';
  // Unsigned attrs are [1] IMPLICIT, appearing after the signature OCTET STRING.
  let unsignedAttrs = null;
  for (const child of signerInfoAsn1.value) {
    if (child.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && child.type === 1) { unsignedAttrs = child; break; }
  }
  if (!unsignedAttrs) return null; // no timestamp — older/back-compat doc

  let tokenAsn1 = null;
  for (const attr of unsignedAttrs.value) { // each attr: SEQ { OID, SET OF value }
    if (forge.asn1.derToOid(attr.value[0].value) === ID_AA_TS) {
      tokenAsn1 = attr.value[1].value[0]; // the timeStampToken ContentInfo
      break;
    }
  }
  if (!tokenAsn1) return null;

  // The token is itself a CMS SignedData whose eContent is a TSTInfo.
  const token = forge.pkcs7.messageFromAsn1(tokenAsn1);
  const tsa = token.certificates && token.certificates[0];
  const tsaSI = token.rawCapture.signerInfos && token.rawCapture.signerInfos[0];
  if (!tsa || !tsaSI) throw new Error('Malformed timestamp token');

  // 0) The signing cert must be a dedicated timestamping cert (RFC 3161 EKU
  //    id-kp-timeStamping). DigiCert G4 anchors a huge PKI, so without this an
  //    attacker holding any cert under G4 (e.g. a TLS cert) could sign a forged
  //    TSTInfo with an arbitrary genTime that still chains to G4. Require
  //    timeStamping present and no general-purpose usages.
  const _eku = tsa.getExtension && tsa.getExtension('extKeyUsage');
  if (!_eku || !_eku.timeStamping) throw new Error('Timestamp signer is not a timestamping certificate');
  if (_eku.serverAuth || _eku.clientAuth || _eku.codeSigning || _eku.emailProtection)
    throw new Error('Timestamp signer cert has non-timestamping key usages');

  // 1) TSA cert chains to the pinned DigiCert G4 root (possibly via an
  //    intermediate carried in the token). Verify each link with WebCrypto.
  const g4 = _getDigicertG4();
  const chain = token.certificates.slice();
  const now = new Date();
  // Find a path tsa → ... → G4. Simple issuer-walk over the token's own certs.
  let cur = tsa, hops = 0;
  while (hops++ < 8) {
    if (_certIssuerMatches(cur, g4)) {
      if (!(await _webCryptoVerifyCertSignedBy(cur, g4))) throw new Error('Timestamp chain: G4 signature check failed');
      break;
    }
    const issuer = chain.find(c => _certIssuerMatches(cur, c) && c !== cur);
    if (!issuer) throw new Error('Timestamp token does not chain to DigiCert G4');
    if (!(await _webCryptoVerifyCertSignedBy(cur, issuer))) throw new Error('Timestamp chain: link signature check failed');
    cur = issuer;
  }

  // 2) TSTInfo: messageImprint must equal SHA-256(signatureBytes), and pull
  //    genTime. TSTInfo is the eContent OCTET STRING inside the token.
  const tstInfoDer = token.rawCapture.content && token.rawCapture.content.value &&
    token.rawCapture.content.value[0] ? token.rawCapture.content.value[0].value : null;
  if (!tstInfoDer) throw new Error('Timestamp token has no TSTInfo content');
  const tstInfo = forge.asn1.fromDer(tstInfoDer);
  // TSTInfo := SEQ { version, policy OID, messageImprint SEQ{algId, OCTETSTRING},
  //                  serialNumber, genTime GeneralizedTime, ... }
  const messageImprint = tstInfo.value[2];
  const imprintHash = forge.util.bytesToHex(messageImprint.value[1].value);
  const sigHashBuf = await crypto.subtle.digest('SHA-256', _binaryStrToBytes(signatureBytes));
  const sigHashHex = Array.from(new Uint8Array(sigHashBuf), b => b.toString(16).padStart(2, '0')).join('');
  if (imprintHash !== sigHashHex) throw new Error('Timestamp imprint does not match this signature');

  // 3) The TSA actually signed this TSTInfo (RSA over DER(signedAttrs as SET)).
  //    Without this a forger could attach real DigiCert certs to a fake TSTInfo.
  const tsaSignedAttrs = tsaSI.value[3];
  if (!tsaSignedAttrs || tsaSignedAttrs.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || tsaSignedAttrs.type !== 0)
    throw new Error('Timestamp token missing signed attributes');
  const tsaReTagged = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, tsaSignedAttrs.value);
  const tsaSignedAttrsDer = forge.asn1.toDer(tsaReTagged).getBytes();
  const tsaSigBytes = tsaSI.value[5].value;
  if (!(await _webCryptoVerifyRSA(tsa.publicKey, tsaSigBytes, _binaryStrToBytes(tsaSignedAttrsDer))))
    throw new Error('Timestamp token signature invalid');

  // genTime is a GeneralizedTime: YYYYMMDDHHMMSS[.fff]Z
  const genTimeDate = _parseGeneralizedTime(tstInfo.value[4].value);
  if (!genTimeDate) throw new Error('Timestamp genTime unparseable');

  // The TSA cert (and any intermediate) must have been within its validity
  // window AT genTime. A timestamp legitimately outlives the TSA cert, so we
  // check against genTime, not "now" — but a cert that wasn't valid when it
  // claims to have stamped is forged/bogus.
  for (let c = tsa, n = 0; c && n < 9; n++) {
    if (!_certValid(c, genTimeDate)) throw new Error('A timestamp chain certificate was not valid at genTime');
    if (_certIssuerMatches(c, g4)) break;
    c = chain.find(x => x !== c && _certIssuerMatches(c, x)) || null;
  }

  return genTimeDate;
}

function _parseGeneralizedTime(s) {
  // e.g. "20260531172403Z" or "20260531172403.123Z"
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

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

    // === /ByteRange must span the ENTIRE file with only the /Contents hole cut
    //     out (defeats signature-wrapping / incremental-update "shadow" attacks)
    // The signature only covers [a..a+b) ∪ [c..c+d). If we don't pin those to
    // the file bounds, an attacker can keep the signed bytes byte-identical (so
    // the hash still matches) while injecting UNSIGNED content a viewer renders:
    // appended after the signed range as an incremental update, or widened into
    // the gap. Require:
    //   • a == 0                  coverage starts at byte 0
    //   • c + d == view.length    coverage ends at real EOF (nothing appended)
    //   • the gap [b..c) is exactly the /Contents <hex> token: it starts with
    //     '<', ends with '>', and its length is contents.length*2 + 2 — so no
    //     extra unsigned bytes hide inside the gap either.
    // Our signer (pdf-signing.js) emits exactly this shape, so genuine documents
    // pass; only tampered ones fail.
    const [_brA, _brB, _brC, _brD] = byteRange;
    if (_brA !== 0) throw new Error('Signature does not cover the start of the document.');
    if (_brB < 0 || _brD < 0 || _brC <= _brB) throw new Error('Invalid signature byte range.');
    if (_brC + _brD !== view.length) throw new Error('Signature does not cover the whole document (content may have been appended after signing).');
    if (view[_brB] !== 0x3c /* < */ || view[_brC - 1] !== 0x3e /* > */) throw new Error('Signature byte range does not delimit the /Contents value.');
    if (_brC - _brB !== contents.length * 2 + 2) throw new Error('Unsigned bytes present in the signature gap.');

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

    // === Trusted timestamp (PAdES-T) — external, non-backdateable date ===
    // If the signature carries a DigiCert RFC 3161 token, validate it (chain to
    // pinned G4, imprint == this signature, TSA signature valid) and use its
    // genTime as the authoritative signing date. Absent → older doc, no bound.
    // Throws if a token is present but bogus, so a forged date can't slip through.
    let trustedTimestamp = null;
    try {
      trustedTimestamp = await _verifyTimestamp(signerInfo, signatureBytes);
    } catch (e) {
      throw new Error('SuperSigning.UserVisibleException: The document has an invalid trusted timestamp.');
    }

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
        const isFr = document.body.classList.contains('lang-fr');
        if (isFr && associationName === 'Association of Translators and Interpreters of Ontario')
          associationName = "Association des traducteurs et interprètes de l'Ontario";
        // Clean verified banner: checkmark + bold headline, then a muted
        // "Certified by <association>" subline on its own. The old layout
        // forced a <br> mid-name and wrapped the org in parentheses, which
        // split the name across lines and read as broken.
        signingInfo.style.color = '';
        signingInfo.classList.add('verified');
        signingInfo.replaceChildren();

        const headline = document.createElement('div');
        headline.className = 'verify-headline';
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        check.setAttribute('class', 'verify-check');
        check.setAttribute('viewBox', '0 0 24 24');
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML = '<circle cx="12" cy="12" r="11" fill="currentColor"/>' +
          '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
        const headlineText = document.createElement('span');
        headlineText.textContent = isFr ? 'Ce tampon numérique a été vérifié' : 'This digital stamp was verified';
        headline.append(check, headlineText);

        const subline = document.createElement('div');
        subline.className = 'verify-subline';
        subline.textContent = (isFr ? 'Certifié par ' : 'Certified by the ') + associationName;

        signingInfo.append(headline, subline);
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
          // .view-doc-link is display:block-ish with its own margin-top, so no
          // <br> needed — it sits cleanly below the verified banner.
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
        // Prefer the externally-verified timestamp (can't be backdated) over the
        // server-reported date. Mark it as externally verified so it's clear the
        // date doesn't rely on trusting our backend. Falls back to the server
        // date for older documents that predate the timestamp feature.
        if (trustedTimestamp) {
          const dt = trustedTimestamp.toLocaleString(fr ? 'fr-CA' : 'en-CA', { dateStyle: 'long', timeStyle: 'short' });
          row(fr ? 'Date de tamponnage' : 'Date stamped',
              Object.assign(document.createElement('span'), {
                textContent: dt + (fr ? ' (horodatage vérifié)' : ' (verified timestamp)'),
                title: 'DigiCert RFC 3161 genTime: ' + trustedTimestamp.toISOString(),
              }));
        } else {
          row(fr ? 'Date de tamponnage' : 'Date stamped',
              Object.assign(document.createElement('span'), { textContent: Title, title: Raw }));
        }
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
  signingInfo.classList.remove('verified');
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
