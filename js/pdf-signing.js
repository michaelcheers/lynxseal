// Pure-JS replacement for PDFSigner_WebAssembly (Blazor) so the client doesn't
// need a .NET runtime or 5MB+ WASM bundle. Exposes the same logical API the
// Blazor wrapper did, callable as window.PDFSigningClient.<Method>(...).
//
// Dependencies (already loaded by the page):
//   - pdf-lib  (window.PDFLib)        general PDF manipulation
//   - fontkit  (window.fontkit)        registered onto each PDFDocument
//   - qrcode-generator (window.qrcode) QR code rasterization
// PKCS#7 detached signature production happens server-side; we only do the
// /ByteRange + /Contents placeholder dance here.
//
// CRYPTO + SIGNING NOTE: the signing path (GenerateSigningRequest + SignPDFFile)
// must produce byte-identical output to the iTextSharp+BouncyCastle pipeline so
// Adobe Acrobat / etc accept the signatures. The byte-range trick, /Contents
// reservation (csize=2381), and PKCS#7 envelope must match exactly. The
// implementation here is a literal port — DO NOT refactor for elegance.

(function () {
  'use strict';

  const { PDFDocument, PDFName, PDFString, PDFHexString, PDFDict, PDFArray, PDFNumber, rgb } = window.PDFLib;

  // ----- helpers -----------------------------------------------------------

  function _b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function _bytesToB64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }
  function _bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  async function _sha256(bytes) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(buf);
  }

  // ----- MergePDFFiles -----------------------------------------------------
  // Server: iText PdfCopy.AddDocument for each input file in order.
  // pdf-lib equivalent: copyPages + addPage on a fresh PDFDocument.
  async function MergePDFFiles(pdfByteArrays) {
    if (pdfByteArrays.length === 1) {
      // Still validate by loading — gives the same error path as multi-file.
      try { await PDFDocument.load(pdfByteArrays[0]); }
      catch { throw new Error(MERGE_FAILURE_MSG); }
      return pdfByteArrays[0];
    }
    const out = await PDFDocument.create();
    try {
      for (const bytes of pdfByteArrays) {
        const src = await PDFDocument.load(bytes);
        const copied = await out.copyPages(src, src.getPageIndices());
        for (const p of copied) out.addPage(p);
      }
    } catch {
      throw new Error(MERGE_FAILURE_MSG);
    }
    return await out.save();
  }

  // Verbatim port of the old PDFSigner_WebAssembly UserVisibleException text.
  // The `SuperSigning.UserVisibleException: ` prefix is required by site.js
  // `getErrorOrNull` to surface the message via reportErrorAlert; without it
  // the user just sees a generic "An error occurred".
  const MERGE_FAILURE_MSG = 'SuperSigning.UserVisibleException: Cannot merge PDFs: The file is corrupted or password protected and could not be read.';

  // ----- NormalizePDF ------------------------------------------------------
  // Server: rebuilds a fresh PDF page-by-page at Letter/A4 size, importing each
  // source page via PdfImportedPage and scaling/rotating it. Handles 4 cases:
  //   - portrait + no footer space:  scale to fit page minus optional footer
  //   - portrait + footer space:     uniform scale, center in available area
  //   - landscape + no footer space: rotate 90, scale to fit
  //   - landscape + footer space:    rotate 90, uniform scale, center
  // Plus: respects the source page's /Rotate dict entry — if it's ~180°,
  // applies an extra 180° flip via negative scale + offset.
  // Verbatim port of the old PDFSigner_WebAssembly UserVisibleException text.
  // Same `SuperSigning.UserVisibleException: ` prefix requirement as
  // MERGE_FAILURE_MSG so site.js getErrorOrNull surfaces it to the user.
  const ENCRYPTED_FAILURE_MSG = 'SuperSigning.UserVisibleException: This PDF is password-protected or has security/permissions enabled, so its pages cannot be read. Please remove the protection (in Acrobat: File ▸ Properties ▸ Security ▸ No Security) or re-save the file with "Print to PDF", then upload again.';

  async function NormalizePDF(pdfBytes, isAtio, addFooterSpace = false) {
    // ignoreEncryption lets the load() succeed, but pdf-lib (1.17) has NO
    // decryption support — for a genuinely encrypted document the content
    // streams stay encrypted and we'd silently emit a BLANK page. This bites
    // owner-locked PDFs (Word/Acrobat "Protect Document", many converters) that
    // set an owner password with an EMPTY user password: they open normally in
    // every viewer, so the member has no idea anything is wrong, yet every page
    // comes out blank here. MergePDFFiles already rejects encrypted input, but
    // NormalizePDF runs first in the pipeline and would turn the file into a
    // valid-but-blank PDF before merge ever sees it. Detect it up front and give
    // an actionable error instead of a blank result.
    const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    if (src.isEncrypted) throw new Error(ENCRYPTED_FAILURE_MSG);
    const out = await PDFDocument.create();
    // Letter = 612 × 792, A4 = 595 × 842 (iText points; same as pdf-lib).
    // Matches C#: new Document(isAtio ? PageSize.Letter : PageSize.A4, 0, 0, 0, 0);
    const pageW = isAtio ? 612 : 595;
    const pageH = isAtio ? 792 : 842;
    const docRight = pageW;
    const docTop  = pageH;
    const footerSpaceReduction = addFooterSpace ? 135 : 0;

    const srcPages = src.getPages();
    // copyPages does a deep copy that preserves all indirect resources (images,
    // fonts, etc.) intact, unlike embedPages which builds a Form XObject and
    // sometimes drops indirect /XObject references from /Resources — that bug
    // caused all images to render as blank white on pure-image source PDFs.
    const copied = await out.copyPages(src, src.getPageIndices());

    for (let i = 0; i < srcPages.length; i++) {
      const srcPage = srcPages[i];
      const copiedPage = copied[i];
      // Mirror iText's PdfReader.GetPageSize, which returns the CropBox (or
      // MediaBox if no CropBox is set). pdf-lib's getWidth/getHeight return
      // MediaBox unconditionally — using those would render off-crop content
      // that the source PDF intended to hide. pdf-lib's getCropBox() falls
      // back to MediaBox when no CropBox is present, so degenerate (cx0=cy0=0,
      // CropBox==MediaBox) pages produce the same matrix as before.
      const cb = srcPage.getCropBox();
      const pageW0 = cb.width;
      const pageH0 = cb.height;
      const cx0 = cb.x;
      const cy0 = cb.y;
      const rotate90 = pageW0 > pageH0;
      let rotationValue = srcPage.getRotation().angle || 0;
      if (rotationValue < 0) {
        rotationValue += (((-rotationValue / 360) | 0) + 1) * 360;
      }
      rotationValue %= 360;
      const isUpsidedown = rotationValue > 135 && rotationValue < 315;

      // Compute the exact 6-element [a b c d e f] matrix iText would have
      // passed to cb.AddTemplate. We then wrap the copied page's content
      // stream in `q a b c d e f cm ... Q` so all original resources stay
      // attached to the page and the same transform applies to them.
      let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
      if (!rotate90) {
        const availableHeight = docTop - footerSpaceReduction;
        const scaleX = docRight / pageW0;
        const scaleY = availableHeight / pageH0;
        if (addFooterSpace) {
          const uniformScale = Math.min(scaleX, scaleY);
          const scaledWidth = pageW0 * uniformScale;
          const scaledHeight = pageH0 * uniformScale;
          const offsetX = (docRight - scaledWidth) / 2;
          const offsetY = footerSpaceReduction + (availableHeight - scaledHeight) / 2;
          a = isUpsidedown ? -uniformScale : uniformScale;
          d = isUpsidedown ? -uniformScale : uniformScale;
          e = isUpsidedown ? offsetX + scaledWidth : offsetX;
          f = isUpsidedown ? offsetY + scaledHeight : offsetY;
        } else {
          a = isUpsidedown ? -scaleX : scaleX;
          d = isUpsidedown ? -scaleY : scaleY;
          e = isUpsidedown ? docRight : 0;
          f = isUpsidedown ? availableHeight : footerSpaceReduction;
        }
      } else {
        const availableHeight = docTop - footerSpaceReduction;
        const scaleX = docRight / pageH0;
        const scaleY = availableHeight / pageW0;
        if (addFooterSpace) {
          const uniformScale = Math.min(scaleX, scaleY);
          const scaledWidth = pageH0 * uniformScale;
          const scaledHeight = pageW0 * uniformScale;
          const offsetX = (docRight - scaledWidth) / 2;
          const offsetY = footerSpaceReduction + (availableHeight - scaledHeight) / 2;
          b = isUpsidedown ? uniformScale : -uniformScale;
          c = isUpsidedown ? -uniformScale : uniformScale;
          e = isUpsidedown ? offsetX + scaledWidth : offsetX;
          f = isUpsidedown ? offsetY : offsetY + scaledHeight;
          a = 0; d = 0;
        } else {
          b = isUpsidedown ? scaleY : -scaleY;
          c = isUpsidedown ? -scaleX : scaleX;
          e = isUpsidedown ? docRight : 0;
          f = isUpsidedown ? footerSpaceReduction : availableHeight;
          a = 0; d = 0;
        }
      }

      // Strip everything from the copied page that isn't visible-content or
      // resource-related. This is the flattening pass: matches the original
      // iText AddTemplate behavior of turning each source page into a pure
      // drawing block, dropping /Annots (which carries form widgets + link
      // annotations + JS-action annotations), /AA (page-level additional
      // actions), and any other extension dictionaries that could carry
      // scripts, embedded files, transitions, or interactive features. Security-
      // relevant — preserves the property that downstream PDFs can't run JS,
      // phone home via OpenActions, etc.
      _flattenPageToContentAndResources(copiedPage);

      // Pre-translate so the CropBox origin (cx0, cy0) in source coords lands
      // at (0, 0) before the scale matrix below applies. Equivalent to
      // multiplying the existing [a b c d e f] by a translate(-cx0, -cy0)
      // matrix on the right: (e, f) absorb the translation.
      // For CropBox == MediaBox (cx0=cy0=0), this is a no-op.
      e -= a * cx0 + c * cy0;
      f -= b * cx0 + d * cy0;

      // Resize copied page to target dimensions. The source content stream is
      // unchanged but its coordinate system now spans (0,0)-(pageW, pageH);
      // our cm transform below maps original content coords into this new box.
      copiedPage.setSize(pageW, pageH);
      // Clear /Rotate so PDF readers don't double-rotate (our matrix already
      // encodes any flip needed via isUpsidedown).
      copiedPage.setRotation(window.PDFLib.degrees(0));
      _wrapPageContentInTransform(out.context, copiedPage, a, b, c, d, e, f);
      out.addPage(copiedPage);
    }
    // Also scrub document-level features that aren't tied to specific pages:
    // /OpenAction (runs on document open), /AA (catalog-level additional
    // actions), /Names → /JavaScript (named scripts), /Names → /EmbeddedFiles
    // (file attachments). We don't clear /AcroForm here because the signing
    // path needs to create one for the signature widget.
    _flattenCatalog(out);
    return await out.save();
  }

  // Whitelist of /Page dict entries to keep when flattening. Everything else
  // (especially /Annots, /AA, /Group with /S /Transparency that hides things,
  // /Trans, /B, /Tabs, /TemplateInstantiated, /PieceInfo, etc.) gets dropped.
  // CropBox/BleedBox/TrimBox/ArtBox are intentionally NOT preserved: the
  // transform already accounts for the source CropBox by placing the cropped
  // region at the destination's (0,0), so re-keeping those boxes would clip
  // the destination page in the wrong place.
  const _PAGE_KEEP_KEYS = new Set([
    'Type', 'Parent', 'Contents', 'Resources',
    'MediaBox',
    'Rotate',
  ]);

  function _flattenPageToContentAndResources(page) {
    const { PDFName } = window.PDFLib;
    const keysToDelete = [];
    page.node.entries().forEach(([key, _]) => {
      const name = key.encodedName.startsWith('/') ? key.encodedName.slice(1) : key.encodedName;
      if (!_PAGE_KEEP_KEYS.has(name)) keysToDelete.push(name);
    });
    for (const name of keysToDelete) page.node.delete(PDFName.of(name));
  }

  function _flattenCatalog(pdfDoc) {
    const { PDFName, PDFDict } = window.PDFLib;
    const catalog = pdfDoc.catalog;
    catalog.delete(PDFName.of('OpenAction'));
    catalog.delete(PDFName.of('AA'));
    const names = catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict) {
      names.delete(PDFName.of('JavaScript'));
      names.delete(PDFName.of('EmbeddedFiles'));
    }
  }

  // Wraps a page's existing /Contents stream(s) in `q a b c d e f cm ... Q`
  // so the transform applies to all original drawing without modifying the
  // resources dict (images, fonts, etc. continue to resolve from the page's
  // existing /Resources).
  function _wrapPageContentInTransform(ctx, page, a, b, c, d, e, f) {
    const { PDFRawStream, PDFDict, PDFArray, PDFName, PDFNumber } = window.PDFLib;

    function makeStream(text) {
      const dict = PDFDict.withContext(ctx);
      const bytes = new TextEncoder().encode(text);
      dict.set(PDFName.of('Length'), PDFNumber.of(bytes.length));
      return ctx.register(PDFRawStream.of(dict, bytes));
    }
    const prefixRef = makeStream(`q\n${a} ${b} ${c} ${d} ${e} ${f} cm\n`);
    const suffixRef = makeStream('\nQ\n');

    const contentsKey = PDFName.of('Contents');
    // /Contents is very commonly an INDIRECT reference (e.g. `/Contents 5 0 R`),
    // and that reference can resolve to EITHER a single stream OR an array of
    // streams. pdf-lib's PDFDict.get() returns the raw PDFRef without
    // dereferencing, so an indirect /Contents *array* slipped past the
    // `instanceof PDFArray` check below and got wrapped as a single element:
    // `[prefix, (ref-to-array), suffix]`. A /Contents array entry that is itself
    // a reference to an array (not a stream) is invalid, so readers silently
    // dropped the page's real drawing and rendered the page BLANK. This bit
    // scanned/OCR PDFs (PDFium, Word "Save/Print as PDF", scanners), which split
    // each page into multiple content streams — an image stream plus an
    // invisible OCR text-layer stream — stored as a /Contents array. Chrome's
    // "Save as PDF" rewrites each page as one stream, which is why those worked.
    // Resolve the reference (lookup dereferences) before deciding how to wrap.
    const rawContents = page.node.get(contentsKey);
    const resolvedContents = page.node.lookup(contentsKey);

    let arr;
    if (resolvedContents instanceof PDFArray) {
      arr = [prefixRef];
      for (let i = 0; i < resolvedContents.size(); i++) arr.push(resolvedContents.get(i));
      arr.push(suffixRef);
    } else if (rawContents) {
      // Single content stream (direct stream object or indirect ref to one) —
      // keep the original ref/stream as-is so we don't inline+duplicate bytes.
      arr = [prefixRef, rawContents, suffixRef];
    } else {
      arr = [prefixRef, suffixRef];
    }
    page.node.set(contentsKey, ctx.obj(arr));
  }

  // ----- StampDocument -----------------------------------------------------
  // Server: DocumentStamper.StampDocument adds a stamp image to specific pages
  // at given (x, y, w, h) positions. stampInfo is a JSON string mapping page
  // number → tuple. stampFirstPage is hardcoded false at the call site here.
  async function StampDocument(pdfBytes, stampPngBytes, stampInfoJson) {
    const stamps = JSON.parse(stampInfoJson);
    // C# uses a tuple converter that outputs JSON as {pageNum: [x, y, w, h]}.
    // Normalize to that shape (could also be object-of-objects from older code).
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const img = await pdf.embedPng(stampPngBytes);
    const pages = pdf.getPages();
    for (const [pageNumStr, tup] of Object.entries(stamps)) {
      const pageNum = +pageNumStr; // 1-indexed
      if (pageNum < 1 || pageNum > pages.length) continue;
      const [x, y, w, h] = Array.isArray(tup) ? tup : [tup.x, tup.y, tup.width, tup.height];
      pages[pageNum - 1].drawImage(img, { x, y, width: w, height: h });
    }
    return await pdf.save();
  }

  // ----- AddQRCode + footer ------------------------------------------------
  // Server: on every page, draws [stamp image | text | QR code | border box]
  // centered horizontally at 0.25" from bottom. Text is formatted with
  // {0} = page num, {1} = total pages. URLs matching /verify|verifier\.[…]/
  // become clickable hyperlinks. Font supplied as raw TTF bytes by caller.
  async function AddQRCode(pdfBytes, verifyURL, stampPngBytes, footerTextTemplate, fontBytes) {
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    pdf.registerFontkit(window.fontkit);
    const font = await pdf.embedFont(fontBytes, { subset: true });
    const stampImg = await pdf.embedPng(stampPngBytes);
    const qrPng = await _generateQrPng(verifyURL);
    const qrImg = await pdf.embedPng(qrPng);

    const pages = pdf.getPages();
    const totalPages = pages.length;
    const FONT_SIZE = 9;
    const LEADING = FONT_SIZE * 1.2;
    const HYPERLINK_RE = /\b(?:verify|verifier)\.[\w.-]+\.(?:ca|com|org|net)\b/gi;

    for (let p = 0; p < totalPages; p++) {
      const page = pages[p];
      const { width: pw } = page.getSize();
      const imageWidth = 110;
      const imageHeight = 110;
      const textWidth = 120;
      const commonY = 0.25 * 72;
      const spacing = 5;
      const totalWidth = imageWidth + spacing + textWidth + spacing + imageWidth;
      const startX = (pw - totalWidth) / 2;
      const stampX = startX;
      const textX = stampX + imageWidth + spacing;
      const qrCodeX = textX + textWidth + spacing;

      // Border
      const borderPadding = 5;
      const borderX = stampX - borderPadding;
      const borderY = commonY - borderPadding;
      const borderWidth = totalWidth + 2 * borderPadding;
      const borderHeight = imageHeight + 2 * borderPadding;
      page.drawRectangle({
        x: borderX, y: borderY, width: borderWidth, height: borderHeight,
        borderColor: rgb(0, 0, 0), borderWidth: 1,
      });

      page.drawImage(stampImg, { x: stampX, y: commonY, width: imageWidth, height: imageHeight });
      page.drawImage(qrImg, { x: qrCodeX, y: commonY, width: imageWidth, height: imageHeight });

      // Text: format {0}/{1} placeholders, render line-by-line top-down inside
      // the textWidth × imageHeight box at (textX, commonY). Server uses iText
      // ColumnText.SetSimpleColumn which lays out text top-to-bottom inside the
      // box. We do the same manually: wrap on word boundaries, draw each line
      // starting at the top of the box and going down.
      const formatted = footerTextTemplate
        .replaceAll('{0}', String(p + 1))
        .replaceAll('{1}', String(totalPages));
      const lines = _wrapAndLinkify(formatted, font, FONT_SIZE, textWidth, HYPERLINK_RE);
      // iText ColumnText.SetSimpleColumn places the first line's baseline at
      // (ury - leading) — the line's *top* sits at ury and the baseline drops
      // by `leading` below that. Earlier ports used ascent or fontSize, which
      // pushed text 2-4pt too high vs the legacy output.
      let lineY = commonY + imageHeight - LEADING; // baseline of first line
      for (const lineRuns of lines) {
        let cursorX = textX;
        for (const run of lineRuns) {
          // Old iText path rendered URLs in the SAME black font as surrounding
          // text — only the underline + clickable annotation distinguished them.
          // Earlier port made URL text blue, which visibly diverged from the
          // legacy output.
          page.drawText(run.text, {
            x: cursorX, y: lineY, size: FONT_SIZE, font,
            color: rgb(0, 0, 0),
          });
          const runWidth = font.widthOfTextAtSize(run.text, FONT_SIZE);
          if (run.url) {
            _addLinkAnnotation(pdf, page, cursorX, lineY - 2, runWidth, FONT_SIZE + 2, run.url);
            // iText Chunk.SetUnderline(0.1f, -2f): 0.1pt thickness, 2pt below baseline, black.
            page.drawLine({
              start: { x: cursorX, y: lineY - 2 },
              end: { x: cursorX + runWidth, y: lineY - 2 },
              thickness: 0.1, color: rgb(0, 0, 0),
            });
          }
          cursorX += runWidth;
        }
        lineY -= LEADING;
        if (lineY < commonY) break; // ran out of vertical space in the box
      }
    }
    return await pdf.save();
  }

  function _addLinkAnnotation(pdf, page, x, y, w, h, url) {
    const ctx = pdf.context;
    const annot = ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: ctx.obj({
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of(url.startsWith('http') ? url : `https://${url}`),
      }),
    });
    const annotRef = ctx.register(annot);
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray) {
      annots.push(annotRef);
    } else {
      page.node.set(PDFName.of('Annots'), ctx.obj([annotRef]));
    }
  }

  // Word-wrap text into lines no wider than maxWidth, splitting URL matches
  // into their own runs so they can be rendered as clickable hyperlinks.
  // Returns an array of lines, where each line is an array of {text, url|null}.
  function _wrapAndLinkify(text, font, size, maxWidth, urlRe) {
    // First split into segments: alternating text + URL runs.
    urlRe.lastIndex = 0;
    const segments = [];
    let last = 0;
    let m;
    while ((m = urlRe.exec(text)) !== null) {
      if (m.index > last) segments.push({ text: text.slice(last, m.index), url: null });
      segments.push({ text: m[0], url: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) segments.push({ text: text.slice(last), url: null });

    // Wrap honoring \n and word boundaries. Each output line is an array of runs.
    const lines = [[]];
    let lineWidth = 0;
    function pushLine() { lines.push([]); lineWidth = 0; }

    for (const seg of segments) {
      const paras = seg.text.split('\n');
      for (let pi = 0; pi < paras.length; pi++) {
        if (pi > 0) pushLine();
        const para = paras[pi];
        const words = para.split(/(\s+)/); // keep whitespace
        for (const w of words) {
          if (!w) continue;
          const ww = font.widthOfTextAtSize(w, size);
          if (lineWidth + ww > maxWidth && lineWidth > 0) pushLine();
          lines[lines.length - 1].push({ text: w, url: seg.url });
          lineWidth += ww;
        }
      }
    }
    // Drop trailing empty line if any
    if (lines.length && lines[lines.length - 1].length === 0) lines.pop();
    return lines;
  }

  async function _generateQrPng(text) {
    // Use qrcode-generator (window.qrcode): v2.x constructor form. Type 0 = auto-fit;
    // ECC level 'Q' matches server's QRCodeGenerator.ECCLevel.Q.
    const qr = new window.qrcode(0, 'Q');
    qr.addData(text);
    qr.make();
    // Render at 5 px per module with a 4-module quiet zone — matches QRCoder's
    // GetGraphic(5) default. Without the quiet zone the modules touch the
    // image edge, making them visually larger when scaled to the footer slot
    // and degrading scan reliability (spec requires 4-module quiet zone).
    const modules = qr.getModuleCount();
    const pixelsPerModule = 5;
    const quietZoneModules = 4;
    const quietZonePx = quietZoneModules * pixelsPerModule;
    const size = modules * pixelsPerModule + 2 * quietZonePx;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(quietZonePx + col * pixelsPerModule, quietZonePx + row * pixelsPerModule, pixelsPerModule, pixelsPerModule);
        }
      }
    }
    return new Promise(resolve =>
      c.toBlob(b => b.arrayBuffer().then(ab => resolve(new Uint8Array(ab))), 'image/png'));
  }

  // ----- ImageToPDF --------------------------------------------------------
  // Server: produces a Letter-size PDF (612×792) with the image centered with
  // 0.5" margins, scaled to fit while preserving aspect ratio.
  async function ImageToPDF(imageBytes) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    // Detect format by magic bytes. PNG: 89 50 4E 47. JPEG: FF D8.
    let img;
    if (imageBytes[0] === 0x89 && imageBytes[1] === 0x50) {
      img = await pdf.embedPng(imageBytes);
    } else if (imageBytes[0] === 0xFF && imageBytes[1] === 0xD8) {
      img = await pdf.embedJpg(imageBytes);
    } else {
      // Fall back: round-trip through Canvas to normalize (handles WebP/BMP).
      const blob = new Blob([imageBytes], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bitmap.width; c.height = bitmap.height;
      c.getContext('2d').drawImage(bitmap, 0, 0);
      const pngBytes = await new Promise(r =>
        c.toBlob(b => b.arrayBuffer().then(ab => r(new Uint8Array(ab))), 'image/png'));
      img = await pdf.embedPng(pngBytes);
    }
    const margin = 0.5 * 72;
    const availW = 612 - 2 * margin;
    const availH = 792 - 2 * margin;
    const scale = Math.min(availW / img.width, availH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: margin + (availW - w) / 2,
      y: margin + (availH - h) / 2,
      width: w, height: h,
    });
    return await pdf.save();
  }

  // ----- Encryption -------------------------------------------------------
  // AES-256-CBC with PKCS7 padding. New format prefixes magic "ARG2" + salt +
  // IV; legacy format is just IV + ciphertext with a zero-padded key.

  const ENCRYPTION_MAGIC_V1 = new Uint8Array([0x41, 0x52, 0x47, 0x32]);
  const SALT_LEN = 16;

  function GenerateEncryptionKey() {
    // Server: GenerateRandomAesKey(14 * 6 = 84 bits) — generates ceil(84/8) = 11
    // bytes, zeros out the bottom (8 - 84%8 = 4) bits of the last byte.
    const keySizeInBits = 84;
    const numBytes = ((keySizeInBits - 1) / 8 | 0) + 1; // 11
    const numBitsToZero = keySizeInBits % 8;            // 4
    const raw = new Uint8Array(numBytes);
    crypto.getRandomValues(raw);
    if (numBitsToZero > 0) {
      raw[raw.length - 1] &= (0xFF << numBitsToZero) & 0xFF;
    }
    return _bytesToB64(raw);
  }

  function GenerateSalt() {
    const salt = new Uint8Array(SALT_LEN);
    crypto.getRandomValues(salt);
    return _bytesToB64(salt);
  }

  function _generateIv() {
    const iv = new Uint8Array(16);
    crypto.getRandomValues(iv);
    return iv;
  }

  async function EncryptFileWithDerivedKey(fileBytes, derivedKeyBase64, saltBase64) {
    const derivedKey = _b64ToBytes(derivedKeyBase64);
    if (derivedKey.length !== 32) throw new Error('Derived key must be exactly 32 bytes (256 bits)');
    const salt = _b64ToBytes(saltBase64);
    if (salt.length !== SALT_LEN) throw new Error(`Salt must be exactly ${SALT_LEN} bytes`);

    const iv = _generateIv();
    const key = await crypto.subtle.importKey('raw', derivedKey, { name: 'AES-CBC' }, false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, fileBytes));

    const out = new Uint8Array(ENCRYPTION_MAGIC_V1.length + SALT_LEN + 16 + encrypted.length);
    out.set(ENCRYPTION_MAGIC_V1, 0);
    out.set(salt, ENCRYPTION_MAGIC_V1.length);
    out.set(iv, ENCRYPTION_MAGIC_V1.length + SALT_LEN);
    out.set(encrypted, ENCRYPTION_MAGIC_V1.length + SALT_LEN + 16);
    return out;
  }

  // ----- Signing -----------------------------------------------------------
  // Server (iText): PdfStamper.CreateSignature reserves a /Contents string of
  // length (csize*2 + 2) bytes, computes SHA-256 over the byte range outside
  // /Contents, sends hash to server for RSA signing → server returns a PKCS#7
  // detached signature blob, client pads to csize bytes and slots into the
  // reserved hole, writes out the final PDF.
  //
  // pdf-lib doesn't have signature-appearance APIs. We implement the byte-range
  // manipulation at the PDF byte level: render a "draft" PDF with a placeholder
  // /Contents, compute the byte ranges, hash, then patch /Contents with the
  // padded signature.

  // Reserved /Contents hole for the signature PKCS#7. Was 2381 (bare detached
  // signature). The PAdES-T trusted-timestamp token (DigiCert RFC 3161, ~6 KB
  // incl. its cert chain) is spliced into the SignerInfo as an unsigned
  // attribute after signing, so the hole must fit signature + token + ASN.1
  // overhead. 12000 leaves comfortable headroom; SignPDFFile rejects anything
  // larger rather than overflow.
  const CSIZE = 12000;
  const REASON = 'Certified Translation';

  // Module-level state mirroring the C# client instance — only one signing
  // operation at a time, just like the WASM wrapper had with its static Client.
  let _draftBytes = null;
  let _contentsStart = -1; // byte offset of '<' starting the placeholder
  let _byteRange = null;   // [a, b, c, d] for /ByteRange

  // Build a draft PDF that has a signature dict with a placeholder /Contents
  // of exactly (csize*2 + 2) hex bytes (including the < >). Returns the
  // SHA-256 hex digest of the signed byte range, after locating the
  // placeholder and recording /ByteRange.
  async function GenerateSigningRequest(pdfBytes, translatorsName) {
    const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const ctx = src.context;

    // Per-signing random nonces used as locator markers for the post-save
    // byte-patching pass. SECURITY: attacker controls the source PDF and
    // could embed arbitrary literal bytes in metadata strings, so any
    // fixed placeholder (e.g. "9999999999", "<0000...0000>") can be
    // smuggled in to mis-direct our search and produce a corrupted (DoS)
    // signed output. Generating fresh nonces *after* the source PDF is in
    // hand means the attacker cannot predict the bytes to include. The
    // nonces are crypto-grade random and are unique per signing call.
    //
    //   • Four 10-digit decimal nonces for /ByteRange — distinct so each
    //     slot is unambiguously addressable by literal match.
    //   • One CSIZE*2-hex-char nonce for /Contents — single 4762-char
    //     marker rules out any collision against attacker-supplied hex.
    const byteRangeNonces = _uniqueByteRangeNonces();   // four distinct ints
    const contentsPlaceholderHex = _randomHex(CSIZE * 2);
    const now = new Date();
    const pdfDate = _formatPdfDate(now);

    const sigDict = ctx.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      Name: PDFString.of(translatorsName),
      Reason: PDFString.of(REASON),
      M: PDFString.of(pdfDate),
      ByteRange: ctx.obj([
        PDFNumber.of(byteRangeNonces[0]),
        PDFNumber.of(byteRangeNonces[1]),
        PDFNumber.of(byteRangeNonces[2]),
        PDFNumber.of(byteRangeNonces[3]),
      ]),
      Contents: PDFHexString.of(contentsPlaceholderHex),
    });
    const sigRef = ctx.register(sigDict);

    // Create a signature field annotation on page 1 referencing this sigDict.
    const pages = src.getPages();
    if (pages.length === 0) throw new Error('SuperSigning.UserVisibleException: Cannot sign PDF: the document has no pages.');
    const page = pages[0];
    const sigField = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of('Signature1'),
      F: 4,
      Rect: [0, 0, 0, 0], // invisible signature
      V: sigRef,
      P: page.ref,
    });
    const sigFieldRef = ctx.register(sigField);

    // Add the widget to the page's /Annots array.
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray) annots.push(sigFieldRef);
    else page.node.set(PDFName.of('Annots'), ctx.obj([sigFieldRef]));

    // Add or extend the document's /AcroForm with this signature field.
    const catalog = src.catalog;
    let acroForm = catalog.lookup(PDFName.of('AcroForm'));
    if (!acroForm) {
      acroForm = ctx.obj({
        SigFlags: 3,
        Fields: ctx.obj([sigFieldRef]),
      });
      catalog.set(PDFName.of('AcroForm'), acroForm);
    } else {
      acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3));
      const fields = acroForm.lookup(PDFName.of('Fields'));
      if (fields instanceof PDFArray) fields.push(sigFieldRef);
      else acroForm.set(PDFName.of('Fields'), ctx.obj([sigFieldRef]));
    }

    // Serialize the draft. Must disable object streams: pdf-lib's default save
    // packs multiple objects into compressed object streams (DEFLATE-encoded),
    // which means our /Contents placeholder bytes wouldn't appear as raw bytes
    // in the output and the search below would fail.
    let draft = await src.save({ updateFieldAppearances: false, useObjectStreams: false });

    // Locate the /Contents placeholder by its full random hex string. Because
    // the hex is per-signing random (CSIZE*2 chars), the probability that any
    // attacker-supplied bytes in the source PDF coincide with it is
    // negligible (~2^-(CSIZE*8) before considering pdf-lib serialization
    // constraints). No fallback / no need to tolerate line-wrapping: pdf-lib
    // writes hex strings without inserted newlines, so the literal '<' + hex
    // + '>' appears intact.
    const fullPlaceholder = new TextEncoder().encode('<' + contentsPlaceholderHex + '>');
    const contentsStart = _indexOfSubarray(draft, fullPlaceholder);
    if (contentsStart < 0) {
      throw new Error('Failed to locate /Contents placeholder in draft PDF.');
    }

    // No byte-insertion: /ByteRange is already in the dict at fixed width. Just
    // compute the offsets and patch the four numbers in place (same number of
    // digits, so xref stays valid).
    const finalContentsStart = contentsStart; // '<' char position
    const finalContentsEnd = finalContentsStart + fullPlaceholder.length; // > + 1

    // Signed = everything except the /Contents <...> hex (the < and > themselves
    // are also excluded from the signed range).
    const a = 0;
    const b = finalContentsStart;
    const c = finalContentsEnd;
    const d = draft.length - finalContentsEnd;

    // Locate the /ByteRange array as a single 43-char literal: the four
    // 10-digit nonces joined by single spaces, exactly as pdf-lib serializes
    // them. Searching for the whole concatenation rather than four separate
    // 10-digit matches drops the collision space from ~10^10 to ~10^40 —
    // i.e., it's no longer plausible that an attacker (or coincidence) can
    // embed a matching 40-digit run anywhere in the source PDF.
    //
    // Layout of the marker:  N1 N2 N3 N4  (each Nx is exactly 10 ASCII digits,
    // separated by single 0x20 spaces — 43 bytes total). Patch each slot at
    // its known offset within the match.
    const realValues = [a, b, c, d];
    const brMarker = new TextEncoder().encode(byteRangeNonces.map(String).join(' '));
    const brStart = _indexOfSubarray(draft, brMarker);
    if (brStart < 0) throw new Error('Lost /ByteRange marker after save.');
    if (_indexOfSubarrayFrom(draft, brMarker, brStart + brMarker.length) >= 0) {
      throw new Error('/ByteRange marker appears twice in draft PDF.');
    }
    for (let n = 0; n < 4; n++) {
      const slotOffset = brStart + n * 11; // 10 digits + 1 space per slot
      const padded = _padLeft(String(realValues[n]), 10);
      draft.set(new TextEncoder().encode(padded), slotOffset);
    }

    // Hash the signed byte ranges.
    const signedRegion = new Uint8Array(b + d);
    signedRegion.set(draft.subarray(0, b), 0);
    signedRegion.set(draft.subarray(c, c + d), b);
    const hash = await _sha256(signedRegion);

    _draftBytes = draft;
    _contentsStart = finalContentsStart;
    _byteRange = [a, b, c, d];

    return _bytesToHex(hash);
  }

  // Take the server's signed PKCS7 (base64), pad to CSIZE bytes, hex-encode
  // it, and splice into the /Contents placeholder we reserved earlier.
  function SignPDFFile(signedDigitalSignatureBase64) {
    if (!_draftBytes) throw new Error('No draft PDF in progress. Call GenerateSigningRequest first.');
    const sigBytes = _b64ToBytes(signedDigitalSignatureBase64);
    if (sigBytes.length > CSIZE) throw new Error(`Signature too large: ${sigBytes.length} > ${CSIZE}`);

    // Build the hex string: signature padded with zeros to CSIZE bytes, then
    // hex-encoded. Total hex length = CSIZE * 2.
    const padded = new Uint8Array(CSIZE);
    padded.set(sigBytes, 0);
    const hex = _bytesToHex(padded);
    const replacement = new TextEncoder().encode('<' + hex + '>');

    _draftBytes.set(replacement, _contentsStart);
    const result = _draftBytes;
    _draftBytes = null;
    _contentsStart = -1;
    _byteRange = null;
    return result;
  }

  function _formatPdfDate(d) {
    // PDF date format: D:YYYYMMDDHHmmSSOHH'mm'  (O = +/-/Z)
    const pad = n => String(n).padStart(2, '0');
    const tz = -d.getTimezoneOffset(); // minutes east of UTC
    const sign = tz >= 0 ? '+' : '-';
    const tzAbs = Math.abs(tz);
    return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      + `${sign}${pad(tzAbs / 60 | 0)}'${pad(tzAbs % 60)}'`;
  }

  function _pad(n, len) { return String(n).padStart(len, ' '); }
  // Left-pad with '0' to exactly `len` chars (truncates if longer). Used to
  // overwrite the /ByteRange placeholder slots without changing total bytes.
  function _padLeft(s, len) {
    if (s.length > len) return s.slice(0, len);
    return '0'.repeat(len - s.length) + s;
  }

  // Crypto-grade random hex string of exactly `len` lowercase hex chars.
  function _randomHex(len) {
    const bytes = new Uint8Array(Math.ceil(len / 2));
    crypto.getRandomValues(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s.slice(0, len);
  }

  // Four distinct 10-digit integers (each in [10^9, 10^10 - 1]) used as
  // /ByteRange slot nonces. Uniqueness across the four matters so each
  // post-save patch lands in exactly one place; pick from a large enough
  // range that collisions are negligible, and explicitly de-dupe.
  function _uniqueByteRangeNonces() {
    const out = [];
    const seen = new Set();
    const u32 = new Uint32Array(1);
    while (out.length < 4) {
      crypto.getRandomValues(u32);
      // Map to [10^9, 10^10 - 1] so the decimal representation is always 10 chars.
      const n = 1_000_000_000 + (u32[0] % 9_000_000_000);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  function _indexOfSubarray(haystack, needle) {
    return _indexOfSubarrayFrom(haystack, needle, 0);
  }
  function _indexOfSubarrayFrom(haystack, needle, fromIdx) {
    outer: for (let i = fromIdx; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  // ----- Expose ------------------------------------------------------------

  window.PDFSigningClient = {
    MergePDFFiles,
    NormalizePDF,
    StampDocument,
    AddQRCode,
    ImageToPDF,
    GenerateEncryptionKey,
    GenerateSalt,
    EncryptFileWithDerivedKey,
    GenerateSigningRequest,
    SignPDFFile,
  };
})();
