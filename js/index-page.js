// Static port of the Index.cshtml page logic. The Razor server-side branches
// (@if Model.SupportsQR, @if Model.DB.Association.Name == "ATIO", etc.) become
// runtime checks against window.DeclarationContext, which is fetched from
// /api/context once at page load.

const PAGE_VERSION = '2026-05-22-01';
const CONVERTIBLE_EXTS = ['.pdf', '.doc', '.docx', '.docm', '.odt', '.jpg', '.jpeg', '.png'];

// Helpers q / modifyQS / byName / reportErrorAlert / getError / sleep /
// toCustomBase64 / getExtension / getNameWithoutExtension / getUint8Array /
// downloadUint8Array / reportFileValidity all live in site.js and are
// already global — don't redeclare here.
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) && navigator.vendor === 'Apple Computer, Inc.';
const ensureBlazorStarted = () => Promise.resolve();

function switchLanguage(lang) {
  if (lang === 'fr') {
    document.body.classList.add('lang-fr');
    document.body.classList.remove('lang-en');
    modifyQS('lang', 'fr');
    const dl = document.getElementById('declarationLanguage');
    if (dl) dl.value = 'French';
  } else {
    document.body.classList.remove('lang-fr');
    document.body.classList.add('lang-en');
    modifyQS('lang', undefined);
    const dl = document.getElementById('declarationLanguage');
    if (dl) dl.value = 'English';
  }
  // Refresh selects to honor lang-only options
  Array.from(document.querySelectorAll('select')).forEach(s => {
    const checked = s.querySelector('option:checked');
    if (!checked) return;
    for (const posLang of ['en', 'fr']) {
      if (posLang === lang) continue;
      if (checked.classList.contains(`${posLang}-only`)) {
        const newOpt = Array.from(s.querySelectorAll(`option.${lang}-only`)).find(o => o.value === checked.value);
        if (newOpt) newOpt.selected = true;
        break;
      }
    }
  });
}

// PDF preview helpers --------------------------------------------------------

function addToCard(input) {
  if (input.files.length <= 0) return;
  const file = input.files[0];
  if (getExtension(file.name) !== '.pdf') {
    pdfPreviewerDiv.style.display = 'none';
    return;
  }
  pdfPreviewerDiv.style.display = '';
  addPDFToPreview(pdfCard, file);
}
function addPDFToPreview(oldIframe, pdf) {
  const iframe = oldIframe.cloneNode();
  iframe.removeAttribute('style');
  iframe.removeAttribute('id');
  iframe.removeAttribute('src');
  iframe.setAttribute('style', 'width:0;height:0;position:absolute');
  iframe.setAttribute('src', '');
  oldIframe.after(iframe);
  const resetIframe = () => {
    iframe.setAttribute('style', oldIframe.getAttribute('style'));
    iframe.setAttribute('id', oldIframe.getAttribute('id'));
    oldIframe.remove();
  };
  if (navigator.pdfViewerEnabled ?? ('PDF Viewer' in navigator.plugins)) {
    const url = URL.createObjectURL(pdf);
    iframe.setAttribute('src', url);
    iframe.onload = () => { URL.revokeObjectURL(url); resetIframe(); };
  } else {
    // Load the pdf.js viewer via the audit-friendly loader: it extracts the
    // committed upstream release ZIP client-side, hash-verifies it, and
    // wires viewer.html via srcdoc + blob URLs. See pdfjs-loader.js.
    window.LynxsealPdfjs.openViewer(iframe)
      .then(async app => { await app.open(await pdf.arrayBuffer()); })
      .catch(reportErrorAlert)
      .finally(resetIframe);
  }
}

// Drag-to-position stamp overlay (every-page mode) ---------------------------

function imageDimensions(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject('There was some problem with the image.');
    img.src = dataURL;
  });
}
function dragElement(elmnt, _bounds, frameContent) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  const bounds = [..._bounds];
  bounds[2] -= +elmnt.style.width.slice(0, -2);
  bounds[3] -= +elmnt.style.height.slice(0, -2);
  elmnt.onmousedown = (e) => {
    e = e || window.event; e.preventDefault();
    pos3 = e.clientX; pos4 = e.clientY;
    frameContent.addEventListener('mousemove', drag);
    frameContent.addEventListener('mouseup', close);
  };
  function drag(e) {
    e = e || window.event; e.preventDefault();
    pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
    pos3 = e.clientX; pos4 = e.clientY;
    let yC = elmnt.offsetTop - pos2, xC = elmnt.offsetLeft - pos1;
    if (xC < bounds[0]) xC = bounds[0]; else if (xC > bounds[2]) xC = bounds[2];
    if (yC < bounds[1]) yC = bounds[1]; else if (yC > bounds[3]) yC = bounds[3];
    elmnt.style.top = yC + 'px'; elmnt.style.left = xC + 'px';
  }
  function close() {
    frameContent.removeEventListener('mousemove', drag);
    frameContent.removeEventListener('mouseup', close);
  }
}
function getViewerRect(viewport, x, y, width, height) {
  const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
  return [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.abs(rect[0] - rect[2]), Math.abs(rect[1] - rect[3])];
}
function getPDFRect(viewport, x, y, width, height) {
  const p = viewport.convertToPdfPoint(x, y + height), p2 = viewport.convertToPdfPoint(x + width, y);
  return [...p, p2[0] - p[0], p2[1] - p[1]];
}

// Declaration build helpers (from old Razor inline) --------------------------

let declarationProfiles = [];
let firstCertifiedLanguage = null;

function _b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}
function _fileToBytes(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = reject;
    r.readAsArrayBuffer(file);
  });
}
async function _sanitizePng(bytes) {
  if (!bytes) return null;
  const blob = new Blob([bytes], { type: 'image/png' });
  const img = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return new Promise(r => c.toBlob(b => b.arrayBuffer().then(ab => r(new Uint8Array(ab))), 'image/png'));
}
function _getBaseDomain(domainName) {
  if (!domainName) return null;
  const parts = domainName.trim().replace(/^\.+|\.+$/g, '').split('.').filter(Boolean);
  const take = domainName.toLowerCase().endsWith('.on.ca') ? 3 : 2;
  return parts.slice(-take).join('.');
}
function _translateLangPairs(langFrom, langTo, declLanguage) {
  if (declLanguage !== 'French') return [langFrom, langTo];
  const row = window.DeclarationContext.certifiedLanguages.find(c => c.fromLanguage === langFrom && c.toLanguage === langTo);
  if (!row) throw new Error('SuperSigning.UserVisibleException: Language pairs invalid');
  return [row.fromLanguageFrench || row.fromLanguage, row.toLanguageFrench || row.toLanguage];
}
function _shortLangPairs(langFrom, langTo) {
  const row = window.DeclarationContext.certifiedLanguages.find(c => c.fromLanguage === langFrom && c.toLanguage === langTo);
  if (!row) throw new Error('SuperSigning.UserVisibleException: Language pairs invalid');
  return `${row.fromLanguageShort}-${row.toLanguageShort}`;
}
async function _fetchStaticLogo(associationName) {
  const url = associationName === 'ATIO' ? '/img/atio-logo-retina.png' : '/img/stibc-logo-retina.png';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch static logo: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function _buildRenderInputs(formData) {
  const ctx = window.DeclarationContext;
  const isAtio = ctx.association.name === 'ATIO';
  const langFrom = formData.get('langFrom');
  const langTo = formData.get('langTo');
  const declLanguage = formData.get('declLanguage') || 'English';
  const descr = formData.get('descr');
  const gender = formData.get('gender');
  const isFrench = declLanguage === 'French';
  if (!ctx.certifiedLanguages.find(c => c.fromLanguage === langFrom && c.toLanguage === langTo))
    throw new Error(`SuperSigning.UserVisibleException: ${langFrom} -> ${langTo} language combination not found.`);
  const [fromLanguageLocal, toLanguageLocal] = _translateLangPairs(langFrom, langTo, declLanguage);
  let cust = null;
  const profileID = formData.get('profileID');
  const profileJSON = formData.get('profileJSON');
  if (profileID) {
    cust = declarationProfiles.find(p => p.Id == profileID);
    if (!cust) throw new Error('SuperSigning.UserVisibleException: Custom declaration type not found.');
  } else if (profileJSON) {
    const parsed = JSON.parse(profileJSON);
    cust = { Id: parsed.Id, ContactInfo: parsed.ContactInfo, CredentialInfo: parsed.CredentialInfo, LogoType: parsed.LogoType, SignatureType: parsed.SignatureType };
    if (parsed.LogoType === 'existing' && parsed.Id) {
      const existing = declarationProfiles.find(p => p.Id == parsed.Id);
      if (!existing) throw new Error('SuperSigning.UserVisibleException: Custom declaration type not found.');
      cust.LogoType = 'Custom'; cust.LogoBase64 = existing.LogoBase64;
    } else if (parsed.LogoType === 'Custom') {
      const logoFile = formData.get('profileJSON_Logo');
      if (logoFile && logoFile.size > 0) {
        if (logoFile.size > 1024 * 1024) throw new Error('SuperSigning.UserVisibleException: Logo file too large.');
        cust.LogoBytes = await _sanitizePng(await _fileToBytes(logoFile));
      }
    }
    if (parsed.SignatureType === 'existing' && parsed.Id) {
      const existing = declarationProfiles.find(p => p.Id == parsed.Id);
      if (!existing) throw new Error('SuperSigning.UserVisibleException: Custom declaration type not found.');
      cust.SignatureType = 'Custom'; cust.SignatureBase64 = existing.SignatureBase64;
    } else if (parsed.SignatureType === 'Custom') {
      const sigFile = formData.get('profileJSON_Signature');
      if (sigFile && sigFile.size > 0) {
        if (sigFile.size > 1024 * 1024) throw new Error('SuperSigning.UserVisibleException: Signature file too large.');
        cust.SignatureBytes = await _sanitizePng(await _fileToBytes(sigFile));
      }
    }
  }
  let logo = null;
  const logoType = cust?.LogoType;
  if (logoType == null || logoType === 'STIBC') logo = await _fetchStaticLogo(ctx.association.name);
  else if (logoType === 'None') logo = null;
  else if (logoType === 'Custom') logo = cust.LogoBytes || (cust.LogoBase64 ? _b64ToBytes(cust.LogoBase64) : null);
  else throw new Error(`SuperSigning.UserVisibleException: Invalid logo type: ${logoType}.`);
  if (logo) logo = await _sanitizePng(logo);
  let signature = null;
  if (isAtio) {
    const sigType = cust?.SignatureType;
    if (sigType === 'Custom' || (sigType == null && (cust?.SignatureBytes || cust?.SignatureBase64))) {
      signature = cust.SignatureBytes || (cust.SignatureBase64 ? _b64ToBytes(cust.SignatureBase64) : null);
    }
    if (signature) signature = await _sanitizePng(signature);
  }
  return {
    logo, signature,
    translatorsFirstName: ctx.member.firstName,
    translatorsMemberNumber: ctx.member.memberNumber,
    translatorsLastName: ctx.member.lastName,
    fromLanguage: fromLanguageLocal, toLanguage: toLanguageLocal,
    documentDescription: descr,
    verifyURL: `https://${isFrench ? 'verifier' : 'verify'}.${_getBaseDomain(ctx.association.domainName)}`,
    associationLongName: ctx.association.longName,
    associationShortName: ctx.association.name,
    timeZoneID: ctx.association.timeZoneId,
    languagePairs: isAtio ? _shortLangPairs(langFrom, langTo) : '',
    contactInfo: cust?.ContactInfo || null,
    credentialInfo: cust?.CredentialInfo || null,
    declarationLanguage: declLanguage,
    isFemale: gender === 'f',
    stampColor: '#000000',
  };
}
async function renderDeclarationClientSide(formData) {
  const inputs = await _buildRenderInputs(formData);
  const pdfBytes = await window.RenderDeclaration.render(inputs);
  return new Blob([pdfBytes], { type: 'application/pdf' });
}
async function _formDataWithSanitizedPngs(form) {
  const out = new FormData();
  const imgRe = /^image\/(png|jpe?g|webp|bmp|x-bmp|x-ms-bmp)$/i;
  const extRe = /\.(png|jpe?g|webp|bmp)$/i;
  for (const [key, value] of new FormData(form).entries()) {
    if (value instanceof File && value.size > 0 && (imgRe.test(value.type) || extRe.test(value.name))) {
      const bytes = await _fileToBytes(value);
      const sanitized = await _sanitizePng(bytes);
      out.append(key, new Blob([sanitized], { type: 'image/png' }), value.name.replace(/\.(jpe?g|webp|bmp)$/i, '.png'));
    } else out.append(key, value);
  }
  return out;
}

// Bootstrap: fetch context, populate selects, wire handlers -----------------

(async function init() {
  let ctx;
  try {
    ctx = await api.get('/api/context');
  } catch (e) {
    // api.get already redirects on 401; this catch handles other failures.
    document.body.innerHTML = '<p style="padding:2em;color:#900">Failed to load: ' + getError(e) + '</p>';
    return;
  }
  window.DeclarationContext = ctx;
  declarationProfiles = ctx.declarationProfiles || [];
  firstCertifiedLanguage = (ctx.certifiedLanguages && ctx.certifiedLanguages[0]) || null;
  if (!firstCertifiedLanguage) {
    document.body.innerHTML = '<p style="padding:2em">User has no certified languages.</p>';
    return;
  }

  const isAtio = ctx.association.name === 'ATIO';
  const supportsQr = !!ctx.association.supportsQr;

  // Show / hide tenant-specific UI
  if (supportsQr) {
    document.getElementById('declLangPicker').style.display = '';
    document.getElementById('footerSpaceSourceLbl').style.display = '';
    document.getElementById('footerSpaceTargetLbl').style.display = '';
    document.getElementById('stampingPrefBlock').style.display = 'none';
  }
  if (isAtio) {
    document.getElementById('stampColorPicker').style.display = '';
    document.getElementById('signatureSection').style.display = '';
  }
  document.getElementById('stibcLogoLabel').textContent = ctx.association.name;

  // File input accept attributes (was @string.Join in Razor). Server's
  // convertableExtensions whitelist stays tight (PDF/DOC/...JPG/PNG); the
  // extra raster image extensions are only added for non-STIBC associations
  // because those go through the client-side ImageToPDF path and never hit
  // CloudConvert.
  const extraImageExts = ctx.association.name !== 'STIBC'
    ? ['.gif', '.webp', '.bmp', '.avif', '.heic', '.heif']
    : [];
  const acceptAttr = CONVERTIBLE_EXTS.concat(extraImageExts).join(',');
  document.getElementById('originalDocument').setAttribute('accept', acceptAttr);
  document.getElementById('translatedDocument').setAttribute('accept', acceptAttr);
  document.getElementById('originalDocument').addEventListener('change', e => { reportFileValidity(e.target); addToCard(e.target); });
  document.getElementById('translatedDocument').addEventListener('change', e => reportFileValidity(e.target));

  // Populate language combo
  const langCombo = document.getElementById('langCombo');
  for (const lang of ctx.certifiedLanguages) {
    const optEn = document.createElement('option');
    optEn.className = 'en-only';
    optEn.value = `${lang.fromLanguage}_${lang.toLanguage}`;
    optEn.textContent = `${lang.fromLanguage} → ${lang.toLanguage}`;
    langCombo.appendChild(optEn);
    const optFr = document.createElement('option');
    optFr.className = 'fr-only';
    optFr.value = `${lang.fromLanguage}_${lang.toLanguage}`;
    optFr.textContent = `${lang.fromLanguageFrench || lang.fromLanguage} → ${lang.toLanguageFrench || lang.toLanguage}`;
    langCombo.appendChild(optFr);
  }
  // Pre-select via URL params if present
  const reqLangFrom = q('langFrom', ''), reqLangTo = q('langTo', '');
  if (reqLangFrom && reqLangTo) {
    const req = `${reqLangFrom}_${reqLangTo}`;
    const langClass = q('lang') === 'fr' ? 'fr-only' : 'en-only';
    const opt = Array.from(langCombo.querySelectorAll('option')).find(k => k.value === req && k.classList.contains(langClass));
    if (opt) { opt.selected = true; langCombo.style.display = 'none'; }
  }

  // Populate declaration profile select
  const declarationTypeSel = document.getElementById('declarationType');
  const newProfileOpt = document.getElementById('newProfileOpt');
  for (const profile of declarationProfiles) {
    const o = document.createElement('option');
    o.value = profile.Id;
    o.textContent = profile.ProfileName;
    declarationTypeSel.insertBefore(o, newProfileOpt);
  }

  // Default declaration language from ?lang= URL param
  switchLanguage(q('lang', 'en'));

  // QR-only path needs a qrId allocated up front (was Razor-baked)
  if (supportsQr) {
    try {
      const r = await api.post('/api/generate-qr-id', {});
      window.qrId = r.qrId;
    } catch (e) {
      console.error('Failed to allocate qrId', e);
    }
  }

  // Wire form
  document.getElementById('pkgForm').addEventListener('submit', e => {
    e.preventDefault();
    createPackage();
  });
  document.getElementById('declarationLanguage')?.addEventListener('input', e => {
    switchLanguage(e.target.value === 'French' ? 'fr' : 'en');
  });
  declarationTypeSel.addEventListener('change', customDeclarationSelect);
  document.getElementById('editProfileBtn').addEventListener('click', openProfileEditDlg);
  document.getElementById('deleteProfileBtn').addEventListener('click', deleteProfile);
  document.getElementById('cancelProfileBtn').addEventListener('click', closeProfileEditDlg);
  document.getElementById('profileEditForm').addEventListener('submit', e => { e.preventDefault(); profileEditSubmit(); });
  document.getElementById('credentialInfoTextarea').setAttribute('placeholder', `${ctx.member.firstName} ${ctx.member.lastName}\nCertified Translator`);

  // Language toggle in header
  document.getElementById('langEn').addEventListener('click', e => { e.preventDefault(); switchLanguage('en'); });
  document.getElementById('langFr').addEventListener('click', e => { e.preventDefault(); switchLanguage('fr'); });

  // Sign-out link
  document.getElementById('signOutBtn').addEventListener('click', async e => {
    e.preventDefault();
    try { await api.post('/api/sign-out', {}); } catch {}
    location.href = '/sign-in.html';
  });

  // Live preview as the user edits the customization form
  for (const input of document.getElementById('profileEditForm').querySelectorAll('input, textarea, select')) {
    input.addEventListener('input', () => {
      clearTimeout(window._previewTimer);
      window._previewTimer = setTimeout(getDeclarationPreview, 500);
    });
  }

  document.getElementById('mainContent').style.display = '';
  if (isSafari) switchLanguage(q('lang', 'en'));
})();

// === Big interactive blocks ported nearly verbatim from the Razor inline ===

async function toPDF(file) {
  try {
    const extension = getExtension(file.name);
    // Any raster image extension goes through the client-side ImageToPDF path
    // for non-STIBC associations. PNG + JPEG hit pdf-lib's native fast paths;
    // everything else (GIF, WebP, BMP, AVIF, HEIC where supported) round-trips
    // through canvas via createImageBitmap → PNG re-encode. SVG intentionally
    // excluded — XML with scripts/foreignObject/etc isn't worth the surface.
    if (window.DeclarationContext.association.name !== 'STIBC' &&
        ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic', '.heif'].includes(extension)) {
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      let pdfBytes;
      try {
        pdfBytes = await window.PDFSigningClient.ImageToPDF(fileBytes);
      } catch (e) {
        // Distinct from the outer "connection failed" catch: this path is
        // purely client-side, no server round-trip. Most likely a malformed
        // image or an extension the browser can't decode.
        throw new Error('SuperSigning.UserVisibleException: Cannot convert image to PDF: ' + (e?.message || e), { cause: e });
      }
      return new Blob([pdfBytes], { type: 'application/pdf' });
    }
    // Server CloudConvert path
    const createRes = await api.post('/api/to-pdf', { phase: 'create', extension });
    const { uploadFormInfoText, taskID } = createRes;
    const { url, parameters } = JSON.parse(uploadFormInfoText);
    const uploadForm = new FormData();
    for (const p in parameters) uploadForm.append(p, parameters[p]);
    uploadForm.append('file', file, 'na' + extension);
    const uploadResp = await fetch(url, { method: 'POST', body: uploadForm });
    if (!uploadResp.ok) throw new Error('Failed to upload file to conversion server');
    let pdfURL = null;
    for (let n = 0; n < 3 && !pdfURL; n++) {
      try { pdfURL = (await api.post('/api/to-pdf', { phase: 'export', taskID }, { asText: true })); } catch {}
    }
    if (!pdfURL) throw new Error('Export failed');
    const pdfResp = await fetch(pdfURL);
    return await pdfResp.blob();
  } catch (e) {
    throw new Error('SuperSigning.UserVisibleException: Cannot convert file: The connection to the server failed', { cause: e });
  }
}

async function createPackage() {
  popup.style.display = '';
  mainProgressMsg.innerHTML = '<span class=en-only>Packaging</span><span class=fr-only>Emballage</span>';
  progressBar.removeAttribute('value');
  try {
    let docs = [translatedDocument.files[0], originalDocument.files[0]];
    const conversions = [];
    for (let n = 0; n < docs.length; n++) {
      if (getExtension(docs[n].name) !== '.pdf') {
        conversions.push((async () => { docs[n] = await toPDF(docs[n]); })());
      }
    }
    if (conversions.length) specificProgressMsg.innerHTML = '<span class=en-only>Converting document(s) to pdf</span><span class=fr-only>Conversion de(s) document(s) en pdf</span>';
    await Promise.all(conversions);

    specificProgressMsg.innerHTML = '<span class=en-only>Fetching declaration</span><span class=fr-only>Récupération de la déclaration</span>';
    const formData = new FormData(fetchForm);
    const [langFrom, langTo] = document.querySelector('#pkgForm [name=langCombo]').value.split('_');
    formData.append('langFrom', langFrom);
    formData.append('langTo', langTo);
    formData.append('descr', document.querySelector('#pkgForm [name=descr]').value);
    const declLang = document.querySelector('#pkgForm [name=declarationLanguage]');
    formData.append('declLanguage', declLang ? declLang.value : 'English');
    if (declarationType.value === 'newProfile') throw new Error('SuperSigning.UserVisibleException: Cannot create package: The declaration type is set to an invalid value. Try refreshing the page.');
    if (declarationType.value !== 'default') formData.append('profileID', declarationType.value);
    if (q('gender') === 'f') formData.append('gender', 'f');

    let encryptionKey, verifyURL, combinedKey;
    if (window.DeclarationContext.association.supportsQr) {
      encryptionKey = window.PDFSigningClient.GenerateEncryptionKey();
      combinedKey = toCustomBase64(window.qrId + encryptionKey);
      const tld = _getBaseDomain(window.DeclarationContext.association.domainName);
      verifyURL = `https://${(document.body.classList.contains('lang-fr') ? 'verifier' : 'verify')}.${tld}/#${combinedKey}`;
    }

    let declaration;
    try { declaration = await renderDeclarationClientSide(formData); }
    catch (e) { throw new Error('SuperSigning.UserVisibleException: Cannot generate declaration: ' + (e.message || e), { cause: e }); }

    let [translatedDoc, originalDoc] = docs;
    specificProgressMsg.innerHTML = '<span class=en-only>Reading declaration</span><span class=fr-only>Lecture de la déclaration</span>';
    await sleep();
    let declarationDoc = await getUint8Array(declaration);
    specificProgressMsg.innerHTML = '<span class=en-only>Reading translated document</span><span class=fr-only>Lecture du document traduit</span>';
    await sleep();
    translatedDoc = await getUint8Array(translatedDoc);
    specificProgressMsg.innerHTML = '<span class=en-only>Reading original document</span><span class=fr-only>Lecture du document original</span>';
    await sleep();
    originalDoc = await getUint8Array(originalDoc);

    const isAtio = window.DeclarationContext.association.name === 'ATIO';
    if (window.DeclarationContext.association.supportsQr) {
      if (document.getElementById('addFooterSpaceTarget')?.checked) {
        specificProgressMsg.innerHTML = '<span class=en-only>Adding footer space to target</span><span class=fr-only>Ajout d\'espace de pied de page à la cible</span>';
        await sleep();
        translatedDoc = await window.PDFSigningClient.NormalizePDF(translatedDoc, isAtio, true);
      }
      if (document.getElementById('addFooterSpaceSource')?.checked) {
        specificProgressMsg.innerHTML = '<span class=en-only>Adding footer space to source</span><span class=fr-only>Ajout d\'espace de pied de page à la source</span>';
        await sleep();
        originalDoc = await window.PDFSigningClient.NormalizePDF(originalDoc, isAtio, true);
      }
    }

    specificProgressMsg.innerHTML = '<span class=en-only>Merging PDFs</span><span class=fr-only>Fusion des PDFs</span>';
    await sleep();
    let pkg = await window.PDFSigningClient.MergePDFFiles([declarationDoc, translatedDoc, originalDoc]);

    specificProgressMsg.innerHTML = '<span class=en-only>Rendering Package</span><span class=fr-only>Rendu du paquet</span>';
    await sleep();
    pkg = await window.PDFSigningClient.NormalizePDF(pkg, isAtio, false);

    const stampEveryPage = window.DeclarationContext.association.supportsQr
      ? true
      : (pkgForm.querySelector('input[type=radio][name=stampingPref]:checked').value === 'everyPage');

    let stamp;
    if (stampEveryPage) {
      specificProgressMsg.innerHTML = '<span class=en-only>Fetching Stamp</span><span class=fr-only>Récupération du tampon</span>';
      const stampColorSelect = document.querySelector('#pkgForm [name=StampColor]');
      const stampColor = isAtio && stampColorSelect ? stampColorSelect.value : '#000000';
      const stampBytes = await window.RenderDeclaration.renderStampPng({
        firstName: window.DeclarationContext.member.firstName,
        memberNumber: window.DeclarationContext.member.memberNumber,
        lastName: window.DeclarationContext.member.lastName,
        languagePairs: isAtio ? _shortLangPairs(langFrom, langTo) : '',
        isFrench: (declLang?.value) === 'French',
        isFemale: q('gender') === 'f',
        isAtio, stampColor,
      });
      stamp = new Blob([stampBytes], { type: 'image/png' });
    }

    if (window.DeclarationContext.association.supportsQr) {
      const arialResp = await fetch('/fonts/Lato-Regular.ttf');
      const arialBytes = new Uint8Array(await arialResp.arrayBuffer());
      const tld = _getBaseDomain(window.DeclarationContext.association.domainName);
      const fn = window.DeclarationContext.member.firstName;
      const footerTxt = document.body.classList.contains('lang-fr')
        ? `Signé numériquement par\n${fn}\nDate: ${new Date().toLocaleDateString('fr-CA', { year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hour12:false,timeZone:'America/Toronto' }).replace(', ',' ')}\nCode de vérification:\n${combinedKey}\n\nPage {0} de {1}\nVérifiez ce document sur\nverifier.${tld}`
        : `Digitally signed by\n${fn}\nDate: ${new Date().toLocaleDateString('en-CA', { year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hour12:true,timeZone:'America/Toronto' }).replace(', ',' ').replace('a.m.','AM').replace('p.m.','PM')}\nVerification Code:\n${combinedKey}\n\nPage {0} of {1}\nVerify this document at\nverify.${tld}\n`;
      pkg = await window.PDFSigningClient.AddQRCode(pkg, verifyURL, new Uint8Array(await stamp.arrayBuffer()), footerTxt, arialBytes);
    }

    mainProgressMsg.innerHTML = '<span class=en-only>Stamp</span><span class=fr-only>Tampon</span>';
    specificProgressMsg.innerText = '';
    progressBar.value = 100;
    await sleep();

    startSigningProcess(pkg, window.DeclarationContext.association.supportsQr ? false : stampEveryPage, stampEveryPage ? stamp : undefined, encryptionKey);
  } catch (e) { reportError(e); }
}

function reportError(e, progressBar, progressMsg, mainProgressMsg) {
  progressBar ??= document.getElementById('progressBar');
  progressMsg ??= ((mainProgressMsg ??= document.getElementById('mainProgressMsg')), document.getElementById('specificProgressMsg'));
  const msg = getError(e);
  progressBar.value = 0;
  if (mainProgressMsg) mainProgressMsg.innerHTML = '<span class=en-only>Error</span><span class=fr-only>Erreur</span>';
  progressMsg.innerText = msg;
}

function startSigningProcess(pkg, stampEveryPage, stamp, encryptionKey) {
  try {
    modalDlg.style.display = '';
    const getStampedPackage = () => stampEveryPage ? _stampedPackage : pkg;
    let _stampedPackage, applyStampsFn;
    let phase = stampEveryPage ? 1 : 0;
    function backButton() {
      try {
        if (phase === 0) modalDlg.style.display = 'none';
        else if (modalDlg.querySelector('[name=postStamping]').style.display === '') signPhase();
        else {
          phase = 0;
          if (stampEveryPage) {
            modalDlg.querySelector('h1').innerHTML = '<span class=en-only>Stamp</span><span class=fr-only>Tampon</span>';
            modalDlg.querySelector('.modal-message').innerHTML = '<span class=en-only>Make sure the stamps are visible and not blocking any content on each page.</span><span class=fr-only>Assurez-vous que les tampons sont visibles et ne bloquent aucun contenu sur chaque page.</span>';
            modalDlg.querySelector('[name=pdfFrame]').style.display = '';
            modalDlg.querySelector('[name=stampedPdfFrame]').style.display = 'none';
            modalDlg.querySelector('[name=stampedPdfFramePlaceholder]').style.display = 'none';
            modalDlg.querySelector('[name=stampedPdfFrame]').src = '';
            modalDlg.querySelector('[name=stampButtons]').style.display = '';
            modalDlg.querySelector('[name=continueButton]').innerHTML = '<span class=en-only>Continue</span><span class=fr-only>Continuer</span>';
            modalDlg.querySelector('[name=postStamping]').style.display = 'none';
          } else modalDlg.style.display = 'none';
        }
      } catch (e) { reportErrorAlert(e); }
    }
    async function signPhase() {
      try {
        phase = 1;
        modalDlg.querySelector('.modal-message').innerHTML = '<span class=en-only>Confirm you want to apply your digital stamp.</span><span class=fr-only>Confirmez que vous souhaitez appliquer votre tampon numérique.</span>';
        modalDlg.querySelector('h1').innerHTML = '<span class=en-only>Confirm</span><span class=fr-only>Confirmer</span>';
        modalDlg.querySelector('[name=stampButtons]').style.display = '';
        modalDlg.querySelector('[name=pdfFrame]').style.display = 'none';
        modalDlg.querySelector('[name=stampedPdfFrame]').style.display = 'none';
        modalDlg.querySelector('[name=stampedPdfFramePlaceholder]').style.display = '';
        modalDlg.querySelector('[name=continueButton]').innerHTML = '<span class=en-only>Confirm Stamp</span><span class=fr-only>Confirmer le tampon</span>';
        modalDlg.querySelector('[name=postStamping]').style.display = 'none';
        await sleep();
        if (stampEveryPage) _stampedPackage = await applyStampsFn();
        const asBlob = new Blob([getStampedPackage()], { type: 'application/pdf' });
        const stampedPdfFrame = modalDlg.querySelector('[name=stampedPdfFrame]');
        if (window.DeclarationContext.association.name === 'ATIO') {
          window.LynxsealPdfjs.openViewer(stampedPdfFrame)
            .then(async app => {
              await app.open(await asBlob.arrayBuffer());
              const doc = stampedPdfFrame.contentDocument;
              for (const id of ['print', 'download', 'openFile', 'viewBookmark']) {
                const el = doc.getElementById(id); if (el) el.style.display = 'none';
              }
            })
            .catch(reportErrorAlert);
        } else {
          const url = URL.createObjectURL(asBlob);
          stampedPdfFrame.src = url;
          stampedPdfFrame.onload = () => URL.revokeObjectURL(url);
        }
        stampedPdfFrame.style.display = '';
        modalDlg.querySelector('[name=stampedPdfFramePlaceholder]').style.display = 'none';
      } catch (e) { reportErrorAlert(e); }
    }
    function postStamping() {
      try {
        modalDlg.querySelector('[name=continueButton]').innerHTML = '<span class=en-only>Done</span><span class=fr-only>Terminé</span>';
        modalDlg.querySelector('[name=postStamping]').style.display = '';
        modalDlg.querySelector('[name=stampedPdfFrame]').style.display = 'none';
        return [modalDlg.querySelector('[name=postStamping] [name=progressMsg]'), modalDlg.querySelector('[name=postStamping] [name=progressBar]')];
      } catch (e) { reportErrorAlert(e); }
    }
    modalDlg.querySelector('[name=backButton]').onclick = () => backButton();
    modalDlg.querySelector('[name=continueButton]').onclick = async () => {
      try {
        if (phase === 0) { signPhase(); return; }
        if (modalDlg.querySelector('[name=postStamping]').style.display === '') {
          if (window.DeclarationContext.association.supportsQr) { location.reload(); return; }
          popup.style.display = 'none';
          modalDlg.querySelector('[name=postStamping]').style.display = 'none';
          modalDlg.style.display = 'none';
          pdfPreviewerDiv.style.display = 'none';
          pkgForm.reset();
          switchLanguage(q('lang', 'en'));
          return;
        }
        const fileName = getNameWithoutExtension(translatedDocument.files[0].name) + (document.body.classList.contains('lang-fr') ? '_tampon.pdf' : '_stamped.pdf');
        let handle;
        try {
          handle = window.showSaveFilePicker ? await showSaveFilePicker({
            suggestedName: fileName,
            types: [{ desciption: 'PDF-A Digitally Signed Document', accept: { 'application/pdf': ['.pdf'] } }],
          }) : undefined;
        } catch (e) { if (!(e instanceof DOMException)) throw e; }
        const [progressMsg, progressBar] = postStamping();
        try {
          progressBar.removeAttribute('value');
          progressMsg.innerHTML = '<span class=en-only>Stamping package</span><span class=fr-only>Tamponnage du paquet</span>';
          let stampedPackage;
          while (true) { stampedPackage = getStampedPackage(); if (stampedPackage !== undefined) break; await sleep(); }
          modalDlg.querySelector('[name=stampedPdfFrame]').style.display = 'none';
          modalDlg.querySelector('.modal-message').innerHTML = '<span class=en-only>Digitally signing document...</span><span class=fr-only>Signature numérique du document...</span>';
          progressMsg.innerHTML = '<span class=en-only>Generating digital signature request</span><span class=fr-only>Génération de la demande de signature numérique</span>';
          await sleep();
          const fullName = `${window.DeclarationContext.member.firstName} ${window.DeclarationContext.member.lastName}`;
          const hash = await window.PDFSigningClient.GenerateSigningRequest(stampedPackage, fullName);
          progressMsg.innerHTML = '<span class=en-only>Waiting on server response for digital signature</span><span class=fr-only>Attente de la réponse du serveur pour la signature numérique</span>';
          const [langFrom, langTo] = pkgForm.querySelector('[name=langCombo]').value.split('_');
          let signature;
          try {
            signature = await api.post('/api/sign-document', { hash, langFrom, langTo, descr: pkgForm.querySelector('[name=descr]').value }, { asText: true });
          } catch (e) { throw new Error('SuperSigning.UserVisibleException: Digital signature request failed', { cause: e }); }

          progressMsg.innerHTML = '<span class=en-only>Applying digital signature to package</span><span class=fr-only>Application de la signature numérique au paquet</span>';
          await sleep();
          const signedPDF = window.PDFSigningClient.SignPDFFile(signature);
          progressMsg.innerHTML = '<span class=en-only>Saving</span><span class=fr-only>Enregistrement</span>';
          await sleep();
          if (window.DeclarationContext.association.supportsQr) {
            const salt = window.PDFSigningClient.GenerateSalt();
            const derivedKey = await window.deriveKeyWithArgon2(encryptionKey, salt);
            const encryptedPDF = await window.PDFSigningClient.EncryptFileWithDerivedKey(signedPDF, derivedKey, salt);
            const presigned = await api.post('/api/upload-document', { qrId: window.qrId });
            const encryptedBlob = new Blob([encryptedPDF], { type: 'application/octet-stream' });
            if (!(modalDlg.querySelector('[name=postStamping]').style.display === '' && modalDlg.style.display === '')) return;
            modalDlg.querySelector('[name=backButton]').style.display = 'none';
            modalDlg.onclick = () => location.reload();
            const s3 = await fetch(presigned.uploadUrl, { method: 'PUT', body: encryptedBlob, headers: { 'Content-Type': 'application/octet-stream' } });
            if (!s3.ok) throw new Error(`Failed to upload to S3: ${s3.status}`);
          }
          await downloadUint8Array('application/pdf', signedPDF, fileName, handle);
          progressMsg.innerHTML = '<span class=en-only>Saved</span><span class=fr-only>Enregistré</span>';
          modalDlg.querySelector('.modal-message').innerHTML = '<span class=en-only>Digital stamp successful</span><span class=fr-only>Tampon numérique réussi</span>';
          progressBar.value = 100;
        } catch (e) { reportError(e, progressBar, progressMsg); }
      } catch (e) { reportErrorAlert(e); }
    };

    if (stampEveryPage) {
      backButton();
      const pdfFrame = modalDlg.querySelector('[name=pdfFrame]');
      window.LynxsealPdfjs.openViewer(pdfFrame).then(async PDFViewerApplication => {
        try {
          await PDFViewerApplication.open(await uint8ArrayToBase64URL(pkg, 'application/pdf'));
          await PDFViewerApplication.pdfViewer.pagesPromise;
          const stampSrc = URL.createObjectURL(stamp);
          let img = await imageDimensions(stampSrc);
          if (img.width > 300) [img.width, img.height] = [img.width / 2, img.height / 2];
          const stamps = new Map();
          const drawStamps = () => {
            try {
              for (const [, { img }] of stamps) img.remove();
              stamps.clear();
              for (let pageNum = 1; pageNum < PDFViewerApplication.pagesCount; pageNum++) {
                const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNum);
                const imgRect = getViewerRect(pageView.viewport, (pageView.viewport.viewBox[2] - 100) / 2, 3, (img.width / 2) | 0, (img.height / 2) | 0);
                const overlay = document.createElement('img');
                overlay.draggable = true; overlay.src = stampSrc;
                Object.assign(overlay.style, { position: 'absolute', cursor: 'move', left: `${imgRect[0]}px`, top: `${imgRect[1]}px`, width: `${imgRect[2]}px`, height: `${imgRect[3]}px`, zIndex: 999 });
                pageView.div.appendChild(overlay);
                dragElement(overlay, [0, 0, pageView.viewport.width, pageView.viewport.height], pdfFrame.contentDocument);
                stamps.set(pageNum, { img: overlay, viewport: pageView.viewport });
              }
            } catch (e) { reportErrorAlert(e); }
          };
          PDFViewerApplication.eventBus.on('scalechanging', () => drawStamps());
          drawStamps();
          applyStampsFn = async () => {
            const stampObj = {};
            for (const [pageNum, stampInfo] of stamps) {
              stampObj[pageNum + 1] = getPDFRect(stampInfo.viewport, +stampInfo.img.style.left.slice(0, -2), +stampInfo.img.style.top.slice(0, -2), +stampInfo.img.style.width.slice(0, -2), +stampInfo.img.style.height.slice(0, -2));
            }
            return await window.PDFSigningClient.StampDocument(pkg, new Uint8Array(await stamp.arrayBuffer()), JSON.stringify(stampObj));
          };
        } catch (e) { reportErrorAlert(e); }
      }).catch(reportErrorAlert);
    } else signPhase();
  } catch (e) { reportErrorAlert(e); }
}

// Profile editor -------------------------------------------------------------

function setDefaultLogoType(value) {
  try {
    existingLogoSelector.style.display = value === 'existing' ? '' : 'none';
    profileEditForm.querySelectorAll('input[type=radio][name=LogoType]').forEach(r => r.removeAttribute('checked'));
    profileEditForm.querySelector(`input[type=radio][name=LogoType][value=${value}]`).setAttribute('checked', 'checked');
  } catch (e) { reportErrorAlert(e); }
}
function setDefaultSignatureType(value) {
  try {
    existingSignatureSelector.style.display = value === 'existing' ? '' : 'none';
    profileEditForm.querySelectorAll('input[type=radio][name=SignatureType]').forEach(r => r.removeAttribute('checked'));
    profileEditForm.querySelector(`input[type=radio][name=SignatureType][value=${value}]`).setAttribute('checked', 'checked');
  } catch (e) { reportErrorAlert(e); }
}
function openProfileEditDlg() {
  try { profileEditDlg.style.display = ''; profileEditForm.reset(); switchLanguage(q('lang', 'en')); getDeclarationPreview(); }
  catch (e) { reportErrorAlert(e); }
}
function closeProfileEditDlg() {
  try {
    profileEditDlg.style.display = 'none';
    if (declarationType.value === 'newProfile') { declarationType.value = 'default'; declarationType.dispatchEvent(new Event('change')); }
  } catch (e) { reportErrorAlert(e); }
}
function customDeclarationSelect() {
  try {
    editOperationsDiv.style.display = '';
    editingId.value = '';
    const { ProfileName, Logo, Signature, ContactInfo, CredentialInfo } = byName(profileEditForm);
    switch (declarationType.value) {
      case 'default':
        editOperationsDiv.style.display = 'none'; break;
      case 'newProfile':
        profileEditDlg.style.display = ''; profileEditForm.reset();
        ProfileName.setAttribute('value', ''); Logo.setAttribute('value', ''); Signature.setAttribute('value', '');
        setDefaultLogoType('STIBC'); setDefaultSignatureType('None');
        ContactInfo.innerText = '';
        openProfileEditDlg();
        break;
      default:
        editingId.value = declarationType.value;
        const profile = declarationProfiles.find(dc => dc.Id.toString() === declarationType.value);
        ProfileName.setAttribute('value', profile.ProfileName);
        Logo.setAttribute('value', ''); Signature.setAttribute('value', '');
        setDefaultLogoType(profile.LogoType === 'Custom' ? 'existing' : profile.LogoType);
        setDefaultSignatureType(profile.HasSignature ? 'existing' : 'None');
        ContactInfo.value = profile.ContactInfo;
        CredentialInfo.value = profile.CredentialInfo;
        break;
    }
  } catch (e) { reportErrorAlert(e); }
}
async function profileEditSubmit() {
  try {
    const logoTypeValue = profileEditForm.querySelector('input[name=LogoType]:checked').value;
    const signatureTypeValue = profileEditForm.querySelector('input[name=SignatureType]:checked')?.value || 'None';
    const { ProfileName, Logo, Signature, ContactInfo, CredentialInfo } = byName(profileEditForm);
    if (logoTypeValue === 'Custom') {
      if (Logo.files.length === 0) { alert(document.body.classList.contains('lang-fr') ? 'Veuillez sélectionner un logo' : 'Please select a logo'); return; }
      if (Logo.files[0].size > 1024 * 1024) { alert(document.body.classList.contains('lang-fr') ? 'La taille du fichier logo doit être inférieure à 1 Mo' : 'Logo file size must be less than 1MB'); return; }
    }
    if (signatureTypeValue === 'Custom') {
      if (Signature.files.length === 0) { alert(document.body.classList.contains('lang-fr') ? 'Veuillez sélectionner une signature' : 'Please select a signature'); return; }
      if (Signature.files[0].size > 1024 * 1024) { alert(document.body.classList.contains('lang-fr') ? 'La taille du fichier signature doit être inférieure à 1 Mo' : 'Signature file size must be less than 1MB'); return; }
    }
    let id = editingId.value;
    let profile = declarationProfiles.find(p => p.Id.toString() === id);
    try {
      id = await api.post('/api/custom-decl', await _formDataWithSanitizedPngs(profileEditForm));
    } catch (e) { throw new Error('SuperSigning.UserVisibleException: Cannot save declaration: The connection to the server failed', { cause: e }); }
    if (typeof id !== 'number') throw new Error('SuperSigning.UserVisibleException: Cannot save declaration: The server returned an invalid response');

    const isNewProfile = profile === undefined;
    if (isNewProfile) { profile = { Id: id }; declarationProfiles.push(profile); }
    profile.ProfileName = ProfileName.value;
    profile.Logo = Logo.value;
    profile.LogoType = logoTypeValue === 'existing' ? 'Custom' : logoTypeValue;
    profile.ContactInfo = ContactInfo.value;
    profile.CredentialInfo = CredentialInfo.value;
    if (logoTypeValue === 'Custom' && Logo.files.length > 0) profile.LogoBase64 = _bytesToBase64(await _sanitizePng(await _fileToBytes(Logo.files[0])));
    else if (logoTypeValue !== 'existing') profile.LogoBase64 = null;
    if (signatureTypeValue === 'Custom' && Signature.files.length > 0) profile.SignatureBase64 = _bytesToBase64(await _sanitizePng(await _fileToBytes(Signature.files[0])));
    else if (signatureTypeValue !== 'existing') profile.SignatureBase64 = null;

    if (isNewProfile) {
      const opt = document.createElement('option');
      opt.setAttribute('value', profile.Id); opt.innerText = profile.ProfileName;
      declarationType.insertBefore(opt, newProfileOpt);
      declarationType.value = profile.Id;
    } else {
      declarationType.querySelector(`option[value="${profile.Id}"]`).innerText = profile.ProfileName;
    }
    customDeclarationSelect();
    profileEditDlg.style.display = 'none';
  } catch (e) { reportErrorAlert(e); }
}
function deleteProfile() {
  try {
    const id = declarationType.value;
    const profile = declarationProfiles.find(p => p.Id.toString() === id);
    if (!profile) return;
    if (!confirm(document.body.classList.contains('lang-fr')
        ? `Êtes-vous sûr de vouloir supprimer le profil "${profile.ProfileName}" ?`
        : `Are you sure you want to delete the profile "${profile.ProfileName}"?`)) return;
    api.post('/api/custom-decl-delete', { id: +id }).catch(() => {});
    declarationType.removeChild(declarationType.querySelector(`option[value="${id}"]`));
    declarationProfiles.splice(declarationProfiles.indexOf(profile), 1);
    declarationType.value = 'default';
  } catch (e) { reportErrorAlert(e); }
}
async function getDeclarationPreview() {
  const formData = new FormData(fetchForm);
  const langComboValue = document.querySelector('#pkgForm [name=langCombo]').value;
  const [langFrom, langTo] = langComboValue === '' ? [firstCertifiedLanguage.fromLanguage, firstCertifiedLanguage.toLanguage] : langComboValue.split('_');
  formData.append('langFrom', langFrom);
  formData.append('langTo', langTo);
  formData.append('descr', document.body.classList.contains('lang-fr') ? '(Votre titre de document)' : '(Your document title)');
  const dl = document.querySelector('#pkgForm [name=declarationLanguage]');
  formData.append('declLanguage', dl ? dl.value : 'English');
  const profileData = new FormData(profileEditForm);
  formData.append('profileJSON', JSON.stringify({
    Id: editingId.value === '' ? 0 : +editingId.value,
    ContactInfo: profileData.get('ContactInfo'),
    CredentialInfo: profileData.get('CredentialInfo'),
    LogoType: profileData.get('LogoType'),
    SignatureType: profileData.get('SignatureType'),
  }));
  if (byName(profileEditForm).Logo.files.length > 0) formData.append('profileJSON_Logo', profileData.get('Logo'));
  if (byName(profileEditForm).Signature.files.length > 0) formData.append('profileJSON_Signature', profileData.get('Signature'));
  if (q('gender') === 'f') formData.append('gender', 'f');
  try {
    const declaration = await renderDeclarationClientSide(formData);
    customizationPreview.style.display = '';
    addPDFToPreview(customizationPreview, declaration);
  } catch {
    customizationPreview.style.display = 'none';
  }
}

// Need uint8ArrayToBase64URL helper (was in site.js?) — fall back if missing
if (typeof uint8ArrayToBase64URL === 'undefined') {
  window.uint8ArrayToBase64URL = function (bytes, contentType) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([bytes], { type: contentType });
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };
}
