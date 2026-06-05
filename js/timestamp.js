// RFC 3161 trusted-timestamp client (PAdES-T) for the certify flow.
//
// Why: a document's signature proves *who* and *what* but not *when* — the date
// is DB-only today, so a leaked signing key could mint backdated documents with
// no way to tell. An external Time-Stamp Authority (DigiCert) signs
// hash(signatureValue) ‖ genTime; it can't backdate, so a leaked key can only
// forge documents stamped *after* the leak. Everything carrying a valid TSA
// token from before is provably legit.
//
// Flow (called from index-page.js between /api/sign-document and SignPDFFile):
//   addTimestampToPkcs7(pkcs7Base64) →
//     1. parse the server's detached PKCS#7, pull the SignerInfo signature value
//     2. build an RFC 3161 TimeStampReq over SHA-256(signatureValue)
//     3. POST it to DigiCert (via the CORS proxy, with our server as fallback)
//     4. splice the returned token into the SignerInfo as the
//        id-aa-timeStampToken UNSIGNED attribute (PAdES-T)
//     5. return the new PKCS#7 base64
//   Throws on any failure — signing must fail loudly rather than emit a
//   document missing the timestamp it's supposed to carry.
//
// Depends on node-forge (window.forge) for ASN.1 — already vetted/pinned for the
// verify page; loaded on the certify page too for this.

(function () {
  'use strict';

  // DigiCert via the ai.moda CORS load-balancer, pinned to the /digicert
  // upstream (confirmed to route to DigiCert's TSA). Browser-callable (sends
  // Access-Control-Allow-Origin). The bare RFC 3161 endpoints send no CORS
  // headers, so this proxy is how the browser reaches a real TSA directly.
  const PROXY_TSA_URL = 'https://rfc3161.ai.moda/digicert';
  // Server-side fallback relay (same-origin via the API proxy) — used only if
  // the public proxy is unreachable, so a third party being down never blocks
  // signing. Both ultimately hit DigiCert; the token self-validates regardless
  // of who relayed it.
  const FALLBACK_API_PATH = '/api/timestamp';

  const ID_AA_TIMESTAMPTOKEN = '1.2.840.113549.1.9.16.2.14';

  // DigiCert Trusted Root G4 — the ONLY trust anchor we accept for timestamps.
  // The proxy (rfc3161.ai.moda) is untrusted plumbing: we validate every token
  // it returns against this pinned root before embedding, so a malicious or
  // broken proxy can't slip in a bogus/forged-time token. Same cert pinned on
  // the verify side. (Kept in sync with verify-document.js DIGICERT_G4_ROOT_B64.)
  const DIGICERT_G4_ROOT_B64 =
    'MIIFkDCCA3igAwIBAgIQBZsbV56OITLiOQe9p3d1XDANBgkqhkiG9w0BAQwFADBiMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwHhcNMTMwODAxMTIwMDAwWhcNMzgwMTE1MTIwMDAwWjBiMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC/5pBzaN675F1KPDAiMGkz7MKnJS7JIT3yithZwuEppz1Yq3aaza57G4QNxDAf8xukOBbrVsaXbR2rsnnyyhHS5F/WBTxSD1Ifxp4VpX6+n6lXFllVcq9ok3DCsrp1mWpzMpTREEQQLt+C8weE5nQ7bXHiLQwb7iDVySAdYyktzuxeTsiT+CFhmzTrBcZe7FsavOvJz82sNEBfsXpm7nfISKhmV1efVFiODCu3T6cw2Vbuyntd463JT17lNecxy9qTXtyOj4DatpGYQJB5w3jHtrHEtWoYOAMQjdjUN6QuBX2I9YI+EJFwq1WCQTLX2wRzKm6RAXwhTNS8rhsDdV14Ztk6MUSaM0C/CNdaSaTC5qmgZ92kJ7yhTzm1EVgX9yRcRo9k98FpiHaYdj1ZXUJ2h4mXaXpI8OCiEhtmmnTK3kse5w5jrubU75KSOp493ADkRSWJtppEGSt+wJS00mFt6zPZxd9LBADMfRyVw4/3IbKyEbe7f/LVjHAsQWCqsWMYRJUadmJ+9oCw++hkpjPRiQfhvbfmQ6QYuKZ3AeEPlAwhHbJUKSWJbOUOUlFHdL4mrLZBdd56rF+NP8m800ERElvlEFDrMcXKchYiCd98THU/Y+whX8QgUWtvsauGi0/C1kVfnSD8oR7FwI+isX4KJpn15GkvmB0t9dmpsh3lGwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQU7NfjgtJxXWRM3y5nP+e6mK4cD08wDQYJKoZIhvcNAQEMBQADggIBALth2X2pbL4XxJEbw6GiAI3jZGgPVs93rnD5/ZpKmbnJeFwMDF/k5hQpVgs2SV1EY+CtnJYYZhsjDT156W1r1lT40jzBQ0CuHVD1UvyQO7uYmWlrx8GnqGikJ9yd+SeuMIW59mdNOj6PWTkiU0TryF0Dyu1Qen1iIQqAyHNm0aAFYF/opbSnr6j3bTWcfFqK1qI4mfN4i/RN0iAL3gTujJtHgXINwBQy7zBZLq7gcfJW5GqXb5JQbZaNaHqasjYUegbyJLkJEVDXCLG4iXqEI2FCKeWjzaIgQdfRnGTZ6iahixTXTBmyUEFxPT9NcCOGDErcgdLMMpSEDQgJlxxPwO5rIHQw0uA5NBCFIRUBCOhVMt5xSdkoF1BN5r5N0XWs0Mr7QbhDparTwwVETyw2m+L64kW4I1NsBm9nVX9GtUw/bihaeSbSpKhil9Ie4u1Ki7wb/UdKDd9nZn6yW0HQO+T0O/QEY+nvwlQAUaCKKsnOeMzV6ocEGLPOr0mIr/OSmbaz5mEP0oUA51Aa5BuVnRmhuZyxm7EAHu/QD09CbMkKvO5D+jpxpchNJqU1/YldvIViHTLSoCtU7ZpXwdv6EM8Zt4tKG48BtieVU+i2iW1bvGjUI+iLUaJW+fCmgKDWHrO8Dw9TdSmq6hN35N6MgSGtBxBHEa2HPQfRdbzP82Z+';

  // Sanity bound on genTime vs the local clock. The cryptographic G4 check is
  // the real accuracy guarantee (DigiCert signs the genTime over our unique
  // imprint — the proxy can't alter it without breaking the signature). This
  // window only catches gross errors (a token years off, a totally wrong
  // device clock); kept generous so a merely-skewed consumer clock doesn't
  // block legitimate signing.
  const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

  const asn1 = () => window.forge.asn1;
  const pki = () => window.forge.pki;

  let _g4 = null;
  function _g4Root() {
    if (!_g4) _g4 = pki().certificateFromAsn1(asn1().fromDer(window.forge.util.decode64(DIGICERT_G4_ROOT_B64)));
    return _g4;
  }

  // --- RSA verify via WebCrypto (forge's pure-JS RSA is slow); mirrors the
  //     helpers in verify-document.js. ---
  async function _webCryptoVerifyRSA(forgePublicKey, signatureBinStr, dataBytes) {
    const spkiDer = asn1().toDer(pki().publicKeyToAsn1(forgePublicKey)).getBytes();
    const key = await crypto.subtle.importKey('spki', _binaryStrToBytes(spkiDer),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, _binaryStrToBytes(signatureBinStr), dataBytes);
  }
  async function _certSignedBy(cert, issuer) {
    const tbsDer = asn1().toDer(pki().getTBSCertificate(cert)).getBytes();
    return _webCryptoVerifyRSA(issuer.publicKey, cert.signature, _binaryStrToBytes(tbsDer));
  }
  function _issuerMatches(cert, issuer) {
    const a = cert.issuer.attributes, b = issuer.subject.attributes;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i].type !== b[i].type || a[i].value !== b[i].value) return false;
    return true;
  }
  function _parseGeneralizedTime(s) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
  }

  // Enforce RFC 3161: the TSA signing cert must carry the id-kp-timeStamping
  // EKU and must NOT carry general-purpose usages (serverAuth/clientAuth/etc.).
  // This is what stops a non-TSA cert under the same root from being abused to
  // mint timestamps. (forge parses extKeyUsage into named booleans.)
  function _requireTimestampingEku(cert) {
    const eku = cert.getExtension && cert.getExtension('extKeyUsage');
    if (!eku || !eku.timeStamping) throw new Error('Timestamp signer is not a timestamping certificate (missing id-kp-timeStamping EKU)');
    if (eku.serverAuth || eku.clientAuth || eku.codeSigning || eku.emailProtection)
      throw new Error('Timestamp signer cert has non-timestamping key usages');
  }

  function _b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
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
  function _bytesToB64(bytes) {
    return btoa(_bytesToBinaryStr(bytes));
  }

  // Walk the detached PKCS#7 ASN.1 to the first SignerInfo SEQUENCE.
  //   ContentInfo := SEQ { OID signedData, [0] EXPLICIT SignedData }
  //   SignedData  := SEQ { version, digestAlgs SET, encapContentInfo,
  //                        [0] certs?, [1] crls?, signerInfos SET }
  // The signerInfos SET is the last child of SignedData that is a SET (the
  // digestAlgorithms SET is earlier but precedes encapContentInfo, so taking
  // the *last* SET reliably lands on signerInfos).
  function _findSignerInfo(p7Asn1) {
    const signedData = p7Asn1.value[1].value[0]; // [0] EXPLICIT → SignedData SEQ
    let signerInfos = null;
    for (const child of signedData.value) {
      if (child.type === asn1().Type.SET) signerInfos = child; // last SET wins
    }
    if (!signerInfos || !signerInfos.value.length) throw new Error('No SignerInfos in PKCS#7');
    return signerInfos.value[0]; // first SignerInfo SEQUENCE
  }

  // SignerInfo (signedAttrs present) layout:
  //   [0]=version [1]=sid [2]=digestAlg [3]=[0]signedAttrs
  //   [4]=sigAlg  [5]=signature OCTET STRING  [6]=[1] unsignedAttrs (we append)
  // The signature value the TSA stamps is the OCTET STRING *contents*.
  function _signatureValueBytes(signerInfo) {
    const sig = signerInfo.value[5];
    if (!sig || sig.type !== asn1().Type.OCTETSTRING) throw new Error('Unexpected SignerInfo shape (no signature OCTET STRING at [5])');
    return _binaryStrToBytes(sig.value);
  }

  async function _sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }

  // Build a DER TimeStampReq over `hashBytes` (SHA-256 imprint), certReq=TRUE so
  // the response token embeds the TSA cert chain (needed for offline verify).
  function _buildTSQ(hashBytes) {
    const A = asn1();
    const req = A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
      A.create(A.Class.UNIVERSAL, A.Type.INTEGER, false, A.integerToDer(1).getBytes()), // version v1
      A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [ // messageImprint
        A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [ // AlgorithmIdentifier
          A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(pki().oids.sha256).getBytes()),
          A.create(A.Class.UNIVERSAL, A.Type.NULL, false, ''),
        ]),
        A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, _bytesToBinaryStr(hashBytes)),
      ]),
      A.create(A.Class.UNIVERSAL, A.Type.BOOLEAN, false, String.fromCharCode(0xff)), // certReq TRUE
    ]);
    return _binaryStrToBytes(A.toDer(req).getBytes());
  }

  // Fetch + validate a token from one source. Returns { token, genTime } or
  // throws. Validation is bound to `expectedImprint` so a token for any other
  // hash (or a replay) is rejected here, at the source, before we trust it.
  async function _fetchValidatedFrom(source, tsqBytes, expectedImprint) {
    let respBytes;
    if (source === 'proxy') {
      const r = await fetch(PROXY_TSA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query' },
        body: tsqBytes,
        // Don't leak the tenant's certify URL to the third-party proxy; no creds.
        referrerPolicy: 'no-referrer',
        credentials: 'omit',
        mode: 'cors',
      });
      if (!r.ok) throw new Error('Proxy TSA returned ' + r.status);
      respBytes = new Uint8Array(await r.arrayBuffer());
    } else {
      // same-origin server relay (via api.js); returns bytes with asBytes.
      const b = await window.api.post(FALLBACK_API_PATH, tsqBytes, { asBytes: true });
      if (!b || !b.length) throw new Error('Timestamp relay returned empty response');
      respBytes = b instanceof Uint8Array ? b : new Uint8Array(b);
    }
    const token = _extractToken(respBytes);
    const genTime = await _validateToken(token, expectedImprint); // throws if bad
    return { token, genTime };
  }

  // Parse TimeStampResp := SEQ { PKIStatusInfo, timeStampToken? }, check the
  // status is granted, and return the timeStampToken (a ContentInfo) ASN.1 obj.
  function _extractToken(respBytes) {
    const resp = asn1().fromDer(_bytesToBinaryStr(respBytes));
    const status = resp.value[0];          // PKIStatusInfo SEQ
    const statusInt = status.value[0];     // status INTEGER
    // 0 = granted, 1 = grantedWithMods; anything else is a rejection.
    const code = statusInt.value.charCodeAt(0) || 0;
    if (code !== 0 && code !== 1) throw new Error('TSA rejected the timestamp request (status ' + code + ')');
    if (resp.value.length < 2) throw new Error('TSA response has no timeStampToken');
    return resp.value[1]; // timeStampToken ContentInfo
  }

  // Validate a timeStampToken BEFORE we embed it. The proxy/relay is untrusted,
  // so we don't take its word for anything: (1) the TSA cert chains to the
  // pinned DigiCert G4 root, (2) the TSA actually signed the TSTInfo, (3) the
  // TSTInfo's messageImprint is SHA-256 of OUR signature value (not some other
  // doc / replayed token), (4) genTime is sane vs the local clock. Throws on any
  // failure → addTimestampToPkcs7 falls through to the next source or fails the
  // sign. `expectedImprint` is the Uint8Array we sent in the request.
  async function _validateToken(tokenAsn1, expectedImprint) {
    const token = window.forge.pkcs7.messageFromAsn1(tokenAsn1);
    const tsa = token.certificates && token.certificates[0];
    const tsaSI = token.rawCapture.signerInfos && token.rawCapture.signerInfos[0];
    if (!tsa || !tsaSI) throw new Error('Malformed timestamp token');

    // (0) The signing cert MUST be a dedicated timestamping cert. DigiCert G4
    //     anchors a huge PKI (TLS, email, code-signing, …); without this an
    //     attacker holding ANY cert under G4 (e.g. a free DigiCert TLS cert)
    //     could sign their own TSTInfo with a forged genTime and it would still
    //     chain to G4. RFC 3161 requires the EKU id-kp-timeStamping (and only
    //     that, critical). Require timeStamping present and no general-purpose
    //     usages alongside it.
    _requireTimestampingEku(tsa);

    // (1) chain tsa → … → pinned G4, verifying each link's RSA signature.
    const g4 = _g4Root();
    const certs = token.certificates.slice();
    let cur = tsa, hops = 0;
    while (true) {
      if (hops++ > 8) throw new Error('Timestamp chain too long / no path to G4');
      if (_issuerMatches(cur, g4)) {
        if (!(await _certSignedBy(cur, g4))) throw new Error('Timestamp chain: G4 signature check failed');
        break;
      }
      const issuer = certs.find(c => c !== cur && _issuerMatches(cur, c));
      if (!issuer) throw new Error('Timestamp token does not chain to DigiCert G4');
      if (!(await _certSignedBy(cur, issuer))) throw new Error('Timestamp chain: link signature check failed');
      cur = issuer;
    }

    // (2) the TSA signed the TSTInfo: RSA over DER(signedAttrs re-tagged as SET).
    const tsaSignedAttrs = tsaSI.value[3];
    if (!tsaSignedAttrs || tsaSignedAttrs.tagClass !== asn1().Class.CONTEXT_SPECIFIC || tsaSignedAttrs.type !== 0)
      throw new Error('Timestamp token missing signed attributes');
    const reTag = asn1().create(asn1().Class.UNIVERSAL, asn1().Type.SET, true, tsaSignedAttrs.value);
    const reTagDer = asn1().toDer(reTag).getBytes();
    if (!(await _webCryptoVerifyRSA(tsa.publicKey, tsaSI.value[5].value, _binaryStrToBytes(reTagDer))))
      throw new Error('Timestamp token signature invalid');

    // (3) messageImprint == SHA-256(our signature value). Parse TSTInfo from the
    //     token's eContent OCTET STRING.
    const tstDer = token.rawCapture.content && token.rawCapture.content.value &&
      token.rawCapture.content.value[0] ? token.rawCapture.content.value[0].value : null;
    if (!tstDer) throw new Error('Timestamp token has no TSTInfo');
    const tst = asn1().fromDer(tstDer);
    // TSTInfo := SEQ { version, policy, messageImprint SEQ{algId, OCTETSTRING},
    //                  serialNumber, genTime, ... }
    const imprintInToken = tst.value[2].value[1].value; // OCTET STRING contents (binary str)
    const expected = _bytesToBinaryStr(expectedImprint);
    if (imprintInToken !== expected) throw new Error('Timestamp imprint does not match our signature');

    // (4) genTime sanity vs local clock (cryptographic genTime is the real
    //     guarantee; this only rejects gross errors).
    const genTime = _parseGeneralizedTime(tst.value[4].value);
    if (!genTime) throw new Error('Timestamp genTime unparseable');
    if (Math.abs(genTime.getTime() - Date.now()) > MAX_CLOCK_SKEW_MS)
      throw new Error('Timestamp genTime is implausibly far from the current time');

    // (5) every cert in the validated chain must have been within its validity
    //     window AT genTime — the correct semantic for a timestamp (the stamp
    //     stays meaningful after the TSA cert later expires, but a cert that
    //     wasn't yet valid / already expired when it claims to have stamped is
    //     bogus).
    for (let c = tsa, n = 0; c && n < 9; n++) {
      if (genTime < c.validity.notBefore || genTime > c.validity.notAfter)
        throw new Error('A timestamp chain certificate was not valid at genTime');
      if (_issuerMatches(c, g4)) break;
      c = certs.find(x => x !== c && _issuerMatches(c, x)) || null;
    }

    return genTime;
  }

  // Append the timeStampToken to the SignerInfo as the id-aa-timeStampToken
  // UNSIGNED attribute: [1] IMPLICIT SET OF Attribute, where
  //   Attribute := SEQ { OID, SET OF AttributeValue }.
  function _appendTimestampAttr(signerInfo, tokenAsn1) {
    const A = asn1();
    const attr = A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, [
      A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(ID_AA_TIMESTAMPTOKEN).getBytes()),
      A.create(A.Class.UNIVERSAL, A.Type.SET, true, [tokenAsn1]),
    ]);
    // [1] IMPLICIT — constructed, context-specific tag 1, directly holding the
    // Attribute(s) in place of the SET OF tag.
    const unsignedAttrs = A.create(A.Class.CONTEXT_SPECIFIC, 1, true, [attr]);
    signerInfo.value.push(unsignedAttrs);
  }

  // Public entry: returns a new PKCS#7 (base64) with a VALIDATED DigiCert
  // timestamp embedded. Tries the proxy, then the server relay; each source's
  // token is fully validated (chain-to-G4 + TSA signature + imprint + genTime)
  // before we accept it, so an untrusted relay can't inject a bogus token. If
  // neither yields a valid token, throws — signing fails loudly rather than
  // emitting an untimestamped or wrongly-timestamped document.
  async function addTimestampToPkcs7(pkcs7Base64) {
    if (!window.forge) throw new Error('node-forge not loaded — cannot add timestamp');
    const p7Asn1 = asn1().fromDer(_bytesToBinaryStr(_b64ToBytes(pkcs7Base64)));
    const signerInfo = _findSignerInfo(p7Asn1);
    const sigValue = _signatureValueBytes(signerInfo);
    const imprint = await _sha256(sigValue);
    const tsq = _buildTSQ(imprint);

    let result = null;
    const errors = [];
    for (const source of ['proxy', 'relay']) {
      try { result = await _fetchValidatedFrom(source, tsq, imprint); break; }
      catch (e) { errors.push(source + ': ' + (e && e.message || e)); }
    }
    if (!result) throw new Error('No valid trusted timestamp obtained (' + errors.join('; ') + ')');

    _appendTimestampAttr(signerInfo, result.token);
    const der = asn1().toDer(p7Asn1).getBytes();
    return _bytesToB64(_binaryStrToBytes(der));
  }

  window.LynxsealTimestamp = { addTimestampToPkcs7 };
})();
