// Client-side declaration renderer. Replaces the server-side
// PDFSigningServer.GenerateDeclaration call so attacker-controlled PNG bytes
// (logo, signature) never touch libpng on the server.
//
// Public API:
//   window.RenderDeclaration.render(inputs) → Promise<Uint8Array>
//
// `inputs` shape (all fields from the old GenerateDeclaration call site):
//   {
//     logo: Uint8Array | null,                // already-sanitized PNG bytes, or null
//     signature: Uint8Array | null,           // ATIO signature image, or null
//     translatorsFirstName: string,
//     translatorsMemberNumber: string,
//     translatorsLastName: string,
//     fromLanguage: string,                   // localized (after TranslateLanguagePairs)
//     toLanguage: string,                     // localized
//     documentDescription: string,
//     verifyURL: string,
//     associationLongName: string,
//     associationShortName: string,           // "ATIO" or "STIBC"
//     timeZoneID: string,                     // .NET tz id (not used client-side; date is just today)
//     languagePairs: string,                  // short form for ATIO stamp (e.g. "EN-FR"); "" for STIBC
//     contactInfo: string | null,
//     credentialInfo: string | null,
//     declarationLanguage: "English" | "French",
//     isFemale: boolean,
//     stampColor: string,                     // hex, e.g. "#000000"
//   }
//
// Depends on pdf-lib and @pdf-lib/fontkit being loaded as window.PDFLib /
// window.fontkit before this module is used.

(function () {
  'use strict';

  const FONT_URLS = {
    Lato: '/fonts/Lato-Regular.ttf',
    Arial: '/fonts/Arial.ttf',
    ArialBold: '/fonts/Arial-Bold.ttf',
    TimesBold: '/fonts/Times-Bold.ttf',
    SegoeUI: '/fonts/SegoeUI.ttf',
    Nirmala: '/fonts/Nirmala.ttf',
    MicrosoftSansSerif: '/fonts/MicrosoftSansSerif.ttf',
    MalgunGothic: '/fonts/MalgunGothic.ttf',
    MicrosoftYaHei: '/fonts/MicrosoftYaHei.ttf',
    FuturaBoldCondensed: '/fonts/FuturaBoldCondensed.otf',
    DejaVuSansBold: '/fonts/DejaVuSans-Bold.ttf',
  };

  // Body text fallback chain — matches GenerateDeclaration.cs:258-266 (the
  // QuestPDF DefaultTextStyle Fallback order). Lato is QuestPDF's built-in
  // default (the actual primary), Arial through YaHei are the explicit fallbacks.
  const BODY_FALLBACK_ORDER = ['Lato', 'Arial', 'MalgunGothic', 'Nirmala', 'MicrosoftSansSerif', 'MicrosoftYaHei'];

  // STIBC stamp fallback. C# DrawStamp inits paint with DefaultTypeFace
  // (Segoe UI) and SetTypefaceForText falls back through the system font chain
  // for missing glyphs. Mirror that with Segoe UI primary + the same body chain.
  const STAMP_FALLBACK_ORDER = ['SegoeUI', 'MalgunGothic', 'Nirmala', 'MicrosoftSansSerif', 'MicrosoftYaHei'];

  // bytes/kitFont are cached forever; pdfFont is re-embedded per render
  // (PDFFont objects are tied to a specific PDFDocument).
  const fontByteCache = {};

  async function loadFontBytes(name) {
    if (fontByteCache[name]) return fontByteCache[name];
    const url = FONT_URLS[name];
    if (!url) throw new Error(`Unknown font: ${name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const kitFont = window.fontkit.create(bytes);
    fontByteCache[name] = { name, bytes, kitFont };
    return fontByteCache[name];
  }

  // Lazy-load fonts in `order` until every codepoint in `texts` is covered by
  // at least one loaded font. Always loads order[0] (primary). Subsequent
  // fonts in order are only fetched if their script appears in the inputs.
  //
  // Returns the list of font names needed for THIS call's texts — so callers
  // can embed JUST those into the PDF, not every font that any past render
  // happened to load into the byte cache (which would re-parse 13MB Malgun /
  // 19MB YaHei every render for no reason — pdf-lib's subset can't make those
  // cheap to embed when there's nothing to subset).
  async function ensureFontsForTexts(texts, order) {
    const used = [order[0]];
    await loadFontBytes(order[0]);
    const allText = texts.filter(Boolean).join('');
    if (!allText) return used;
    const codepoints = new Set();
    for (const ch of allText) {
      const cp = ch.codePointAt(0);
      // Skip control characters (newlines, tabs, etc.) — no font has a glyph
      // for them and they're handled by the layout code (drawWrapped's split
      // on '\n'), not rendered as glyphs. If we included them, the fallback
      // walker would load every font in the chain looking for a U+000A glyph
      // that doesn't exist anywhere.
      if (cp < 0x20 || cp === 0x7F) continue;
      codepoints.add(cp);
    }

    const isCovered = (cp) => {
      for (const name of used) {
        const f = fontByteCache[name];
        if (f && f.kitFont.hasGlyphForCodePoint(cp)) return true;
      }
      return false;
    };

    for (const name of order.slice(1)) {
      let allCovered = true;
      for (const cp of codepoints) {
        if (!isCovered(cp)) { allCovered = false; break; }
      }
      if (allCovered) return used;
      await loadFontBytes(name);
      used.push(name);
    }
    return used;
  }

  // Port of PDFSigningServer.RemoveTabs (the C# extension method called on
  // contactInfo, the body declaration text, documentDescription, and credentialInfo
  // before drawing). Tab → 4 spaces, FormFeed/VerticalTab → newline, and Bell /
  // Backspace / Escape are stripped. Belt-and-suspenders: also strip the remaining
  // C0 control chars + DEL so a stray \0 or \r etc. never reaches drawText.
  function _removeTabs(text) {
    if (text == null) return text;
    return text
      .replace(/\t/g, '    ')
      .replace(/[\f\v]/g, '\n')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  // y-coord convention: y is the TOP of the next line box (not the baseline).
  // Convert to baseline before calling pdf-lib's drawText. Constants measured
  // from the server-rendered PDF (test_results/...): for Lato 10.5pt, baseline
  // sits 11.6pt below the line box top, baselines are 15.1pt apart.
  const ASCENT_RATIO = 11.6 / 10.5;
  const LINEH_RATIO = 15.1 / 10.5;
  const ascentFor = (size) => size * ASCENT_RATIO;
  const lineHFor = (size) => size * LINEH_RATIO;

  // Parse a "#rrggbb" hex colour into a pdf-lib rgb() (0..1 components).
  // Defaults to black on null/short/garbage input so a bad stampColor can
  // never make the stamp invisible.
  function _hexToRgb(hex) {
    const { rgb } = window.PDFLib;
    if (typeof hex === 'string') {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
      if (m) {
        const n = parseInt(m[1], 16);
        return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
      }
    }
    return rgb(0, 0, 0);
  }

  // Per-codepoint font pick: walk an ordered list of {pdfFont, kitFont}
  // entries and return the first that has the glyph; else the first entry.
  function pickFont(cp, chain) {
    for (const f of chain) if (f.kitFont.hasGlyphForCodePoint(cp)) return f;
    return chain[0];
  }

  function splitRuns(text, chain) {
    const runs = [];
    let cur = null;
    for (const ch of text) {
      const f = pickFont(ch.codePointAt(0), chain);
      if (cur && cur.font === f) cur.text += ch;
      else { cur = { font: f, text: ch }; runs.push(cur); }
    }
    return runs;
  }

  function measureRuns(text, size, chain) {
    let w = 0;
    for (const r of splitRuns(text, chain)) {
      w += r.font.pdfFont.widthOfTextAtSize(r.text, size);
    }
    return w;
  }

  function drawRunsAtBaseline(page, text, x, y, size, chain, opts = {}) {
    for (const r of splitRuns(text, chain)) {
      page.drawText(r.text, { x, y, size, font: r.font.pdfFont, ...opts });
      x += r.font.pdfFont.widthOfTextAtSize(r.text, size);
    }
  }

  // LayoutCtx holds the current page + current y. Helpers below mutate it in
  // place and add new pages when content would overflow, replacing the old
  // single-page assumption that silently let content disappear past the bottom.
  // QuestPDF Column does this automatically; pdf-lib doesn't.
  //
  //   ctx.y      → top of the next line box (PDF coords, y grows up)
  //   ctx.yMin   → smallest y any draw is allowed to reach. For ATIO this leaves
  //                the 120pt footer area free for the QR overlay AddQRCode draws
  //                on every page (matches server's page.Footer().Height(120)).
  //   ctx.yReset → y to use after pdf.addPage (top - paddingVertical)
  function _newPage(ctx) {
    ctx.page = ctx.pdf.addPage([ctx.pageW, ctx.pageH]);
    ctx.y = ctx.yReset;
  }
  // Make sure `neededHeight` PDF points are available below current y. If not,
  // start a new page first.
  function _ensureSpace(ctx, neededHeight) {
    if (ctx.y - neededHeight < ctx.yMin) _newPage(ctx);
  }

  function drawWrapped(ctx, text, x, maxWidth, size, chain, opts = {}) {
    const lh = lineHFor(size);
    const asc = ascentFor(size);
    for (const para of text.split('\n')) {
      if (!para) {
        _ensureSpace(ctx, lh);
        ctx.y -= lh;
        continue;
      }
      const words = para.split(' ');
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (measureRuns(test, size, chain) > maxWidth) {
          _ensureSpace(ctx, lh);
          drawRunsAtBaseline(ctx.page, line, x, ctx.y - asc, size, chain, opts);
          ctx.y -= lh;
          line = w;
        } else line = test;
      }
      if (line) {
        _ensureSpace(ctx, lh);
        drawRunsAtBaseline(ctx.page, line, x, ctx.y - asc, size, chain, opts);
        ctx.y -= lh;
      }
    }
  }

  // Split `text` into display lines: break on explicit '\n', then greedily
  // word-wrap each paragraph to `maxWidth`. Used for the contact-info and
  // credential-info blocks, which the server (QuestPDF) auto-wrapped but the
  // original port drew line-per-'\n' (so long lines ran off the page).
  function wrapTextLines(text, maxWidth, size, chain) {
    const out = [];
    for (const para of String(text).split('\n')) {
      if (!para) { out.push(''); continue; }
      const words = para.split(' ');
      let line = '';
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (line && measureRuns(test, size, chain) > maxWidth) {
          out.push(line);
          line = w;
        } else line = test;
      }
      if (line) out.push(line);
    }
    return out;
  }

  function drawCentered(ctx, text, size, chain, opts = {}) {
    const lh = lineHFor(size);
    _ensureSpace(ctx, lh);
    const w = measureRuns(text, size, chain);
    drawRunsAtBaseline(ctx.page, text, (ctx.pageW - w) / 2, ctx.y - ascentFor(size), size, chain, opts);
    ctx.y -= lh;
  }

  function drawLeft(ctx, text, x, size, chain, opts = {}) {
    const lh = lineHFor(size);
    _ensureSpace(ctx, lh);
    drawRunsAtBaseline(ctx.page, text, x, ctx.y - ascentFor(size), size, chain, opts);
    ctx.y -= lh;
  }

  // Right-align without consuming a wrapping budget (used for the contact info
  // column next to the logo). Returns nothing; mutates ctx.y like the others.
  function drawRight(ctx, text, rightX, size, chain, opts = {}) {
    const lh = lineHFor(size);
    _ensureSpace(ctx, lh);
    const w = measureRuns(text, size, chain);
    drawRunsAtBaseline(ctx.page, text, rightX - w, ctx.y - ascentFor(size), size, chain, opts);
    ctx.y -= lh;
  }

  // Draw an image flush at current y, advancing y by its height. Adds a new
  // page first if the image wouldn't fit on the current one.
  function drawImageBlock(ctx, img, x, w, h) {
    _ensureSpace(ctx, h);
    ctx.page.drawImage(img, { x, y: ctx.y - h, width: w, height: h });
    ctx.y -= h;
  }

  // Substitute the admin-authored declaration-translation placeholders with
  // this document's values. Unknown tokens are left as-is. {documents} expands
  // to the document description (the list of translated documents); {date} uses
  // the same association-timezone date the English block shows.
  function _fillTranslationTokens(text, inputs) {
    if (text == null) return '';
    const fullName = [inputs.translatorsFirstName, inputs.translatorsLastName].filter(s => s).join(' ');
    const repl = {
      '{fullName}': fullName,
      '{memberNumber}': inputs.translatorsMemberNumber || '',
      '{fromLanguage}': inputs.fromLanguage || '',
      '{toLanguage}': inputs.toLanguage || '',
      '{date}': formatDate(inputs.declarationLanguage, inputs.timeZoneID),
      '{documents}': inputs.documentDescription || '',
    };
    return String(text).replace(/\{fullName\}|\{memberNumber\}|\{fromLanguage\}|\{toLanguage\}|\{date\}|\{documents\}/g,
      (m) => repl[m] != null ? repl[m] : m);
  }

  // Builds the declaration body text. Mirrors GenerateDeclaration.cs:296-355
  // — branches on isATIO and isFrench, with French vowel-aware articles and
  // gendered terms for ATIO French.
  function buildDeclarationText(inputs) {
    const fullName = [inputs.translatorsFirstName, inputs.translatorsLastName].filter(s => s).join(' ');
    const isAtio = inputs.associationShortName === 'ATIO';
    const isFrench = inputs.declarationLanguage === 'French';
    if (isAtio) {
      if (isFrench) {
        const startsWithVowel = w => w && 'aeiouàâéèêëîïôùûüÿæœ'.includes(w.toLowerCase()[0]);
        const fromLower = inputs.fromLanguage.toLowerCase();
        const toLower = inputs.toLanguage.toLowerCase();
        const fromArticle = startsWithVowel(inputs.fromLanguage) ? "de l'" : 'du ';
        const toArticle = startsWithVowel(inputs.toLanguage) ? "à l'" : 'au ';
        const toArticle2 = startsWithVowel(inputs.toLanguage) ? "l'" : 'le ';
        const soussigne = inputs.isFemale ? 'soussignée' : 'soussigné';
        const traducteur = inputs.isFemale ? 'traductrice' : 'traducteur';
        const agree = inputs.isFemale ? 'agréée' : 'agréé';
        return `Je ${soussigne}, ${fullName}, ${traducteur} ${agree} ${fromArticle}${fromLower} ${toArticle}${toLower}, ` +
          `membre en règle de l'Association des traducteurs et interprètes de l'Ontario, qui est une société membre du Conseil des traducteurs, terminologues et interprètes du Canada (CTTIC), ` +
          `déclare par les présentes que j'ai traduit vers ${toArticle2}${toLower} le ou les documents ${fromLower} ci-joints, et qu'il s'agit, à ma connaissance, d'une traduction fidèle et exacte du ou des documents sources ${fromLower}.\n\n` +
          `Avertissement : La présente déclaration vise à certifier l'exactitude de la traduction seulement. Je n'émets aucune affirmation et ne donne aucune garantie quant à l'authenticité ou au contenu du document original. ` +
          `De plus, je n'assume aucune responsabilité quant à la façon dont la traduction sera utilisée par le client ou un tiers, y compris les utilisateurs finaux de la traduction.`;
      }
      return `I, the undersigned, ${fullName}, Certified Translator from ${inputs.fromLanguage} to ${inputs.toLanguage}, ` +
        `member in good standing of the Association of Translators and Interpreters of Ontario, which is a member society of the Canadian Translators, Terminologists, Interpreters Council (CTTIC), ` +
        `hereby declare that I did translate into ${inputs.toLanguage} the attached ${inputs.fromLanguage} document(s) and that it is, to the best of my knowledge, a true and accurate translation of the ${inputs.fromLanguage} source document(s).\n\n` +
        `Disclaimer: This statement is to certify the accuracy of the translation only. I do not make any claims or guarantees about the authenticity or content of the original document. ` +
        `Furthermore, I do not assume any liability for the way in which the translation is used by the customer or any third party, including end users of the translation.`;
    }
    return `I, ${fullName}, certified ${inputs.fromLanguage} to ${inputs.toLanguage} translator ` +
      `and member in good standing of the ${inputs.associationLongName} (${inputs.associationShortName}), ` +
      `member number ${inputs.translatorsMemberNumber}, hereby declare that, to the best of my knowledge and ability, ` +
      `the attached ${inputs.toLanguage}-language document is a full and accurate translation of the attached ${inputs.fromLanguage}-language source document.`;
  }

  // Extract the y/m/d that the given timezone is *currently* in, regardless of
  // the browser's local zone. Server stores IANA tz names (e.g. "America/Toronto")
  // since .NET 6+ on Linux accepts them directly via TimeZoneInfo.FindSystemTimeZoneById,
  // which is exactly what Intl.DateTimeFormat's timeZone option also expects.
  function _ymdInTz(tz) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t).value;
    return { year: +get('year'), month: +get('month'), day: +get('day') };
  }

  // Date in the association's timezone, formatted to match the server's exact
  // wording. The server uses TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow,
  // TimeZoneInfo.FindSystemTimeZoneById(timeZoneID)) then ToString("MMMM d, yyyy")
  // for English or ToString("d MMMM yyyy", fr-FR) for French.
  function formatDate(declLanguage, timeZoneID) {
    const { year, month, day } = _ymdInTz(timeZoneID);
    if (declLanguage === 'French') {
      const months = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
      return `${day} ${months[month - 1]} ${year}`;
    }
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${months[month - 1]} ${day}, ${year}`;
  }

  // STIBC stamp drawn as native PDF vector content (circles via page.drawCircle
  // with borderDashArray, text via page.drawText with rotation). Mirrors
  // GenerateDeclaration.cs:389-397 (MinimalBox().Layers().Canvas(DrawStamp...)).
  // ATIO declaration has no inline stamp on the server side (the C# branch
  // guards `if (associationShortName != "ATIO")`).
  async function drawStibcStampNative(page, pdf, params, stampX, stampYTop, stampWPt, stampFontsNeeded) {
    const PDFLib = window.PDFLib;
    const { rgb, pushGraphicsState, popGraphicsState, translate, rotateRadians } = PDFLib;

    // Stamp colour (STIBC requested coloured stamps). params.stampColor is a
    // hex string like "#418C2C"; default to black. Applied to both rings and
    // all stamp text so the inline declaration stamp matches the every-page
    // canvas stamp colour.
    const stampRgb = _hexToRgb(params.stampColor);

    const lWidth = 480;
    const lFullR = 50;
    const mult = lFullR / 50;
    const innerR = lFullR * (19 / 25);
    const superInnerR = innerR - mult * 3;
    const lHeight = lFullR * 2;
    const leftCenter = lWidth / 2 - lFullR;
    const cxL = lFullR + leftCenter;
    const cyL = lFullR;

    const scale = stampWPt / lWidth;
    const stampHPt = lHeight * scale;
    const toX = (xL) => stampX + xL * scale;
    const toY = (yL) => stampYTop - yL * scale;
    const cxPdf = toX(cxL);
    const cyPdf = toY(cyL);

    // Stamp font chain: Segoe UI primary + body fallbacks for non-Latin names.
    // Only embeds the fonts that ensureFontsForTexts said this render's stamp
    // text needs — not every STAMP_FALLBACK_ORDER entry in the byte cache.
    const stampChain = [];
    for (const name of (stampFontsNeeded || STAMP_FALLBACK_ORDER)) {
      const cached = fontByteCache[name];
      if (!cached) continue;
      const pdfFont = await pdf.embedFont(cached.bytes, { subset: true });
      stampChain.push({ pdfFont, kitFont: cached.kitFont, name });
    }
    const segoeFont = stampChain[0].pdfFont;
    const segoeFk = stampChain[0].kitFont;
    const fkMeasure = (text, sizeL) =>
      segoeFk.layout(text).advanceWidth / segoeFk.unitsPerEm * sizeL;
    const fkFontSpacing = (sizeL) =>
      (segoeFk.ascent - segoeFk.descent + segoeFk.lineGap) / segoeFk.unitsPerEm * sizeL;
    const fkTop = (sizeL) => -segoeFk.bbox.maxY / segoeFk.unitsPerEm * sizeL;
    const fkBottom = (sizeL) => -segoeFk.bbox.minY / segoeFk.unitsPerEm * sizeL;

    function pickStampFont(text) {
      const dflt = stampChain[0];
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (!dflt.kitFont.hasGlyphForCodePoint(cp)) {
          for (const f of stampChain) {
            if (f.kitFont.hasGlyphForCodePoint(cp)) return f;
          }
        }
      }
      return dflt;
    }
    function pickedMeasure(text, sizeL) {
      const f = pickStampFont(text);
      return f.kitFont.layout(text).advanceWidth / f.kitFont.unitsPerEm * sizeL;
    }

    // Rings — both dashed (C# PathEffect is sticky on the paint).
    // Per-circle dash sizes so the pattern fits an integer count of periods,
    // otherwise the seam shows as a bunched first+last dash.
    function fitDashArray(circumference, dashLen, gapLen) {
      const patternLen = dashLen + gapLen;
      const nPatterns = Math.max(1, Math.round(circumference / patternLen));
      const adjusted = circumference / nPatterns;
      const k = adjusted / patternLen;
      return [dashLen * k, gapLen * k];
    }
    const dashUnit = mult * 1 * scale;
    const gapUnit = mult * 0.5 * scale;
    const outerCirc = 2 * Math.PI * lFullR * scale;
    const innerCircRadius = innerR - mult * 3;
    const innerCirc = 2 * Math.PI * innerCircRadius * scale;
    page.drawCircle({
      x: cxPdf, y: cyPdf, size: lFullR * scale,
      borderColor: stampRgb,
      borderWidth: mult * 4 * scale,
      borderDashArray: fitDashArray(outerCirc, dashUnit, gapUnit),
    });
    page.drawCircle({
      x: cxPdf, y: cyPdf, size: innerCircRadius * scale,
      borderColor: stampRgb,
      borderWidth: mult * scale,
      borderDashArray: fitDashArray(innerCirc, dashUnit, gapUnit),
    });

    // Outer arc text. AddCircle path starts at angle 0 (3 o'clock); text reads CW.
    const outerText = 'B.C. (STIBC)        Society of Translators and Interpreters of ';
    const outerWPerSize = fkMeasure(outerText, 1);
    let curSizeL = (2 * Math.PI * innerR) / outerWPerSize;
    const outerDrawSizeL = curSizeL;
    let angle = 0;
    for (const ch of outerText) {
      const chWL = fkMeasure(ch, outerDrawSizeL);
      const chArc = chWL / innerR;
      const a = angle + chArc / 2;
      const px = cxPdf + Math.cos(a) * innerR * scale;
      const py = cyPdf - Math.sin(a) * innerR * scale;
      const pdfRot = -(a + Math.PI / 2);
      page.pushOperators(pushGraphicsState(), translate(px, py), rotateRadians(pdfRot));
      const sizePt = outerDrawSizeL * scale;
      const charWPt = segoeFont.widthOfTextAtSize(ch, sizePt);
      page.drawText(ch, { x: -charWPt / 2, y: 0, font: segoeFont, size: sizePt, color: stampRgb });
      page.pushOperators(popGraphicsState());
      angle += chArc;
    }

    // Center stack iteration — picked-font measures so e.g. Korean names use
    // Malgun-derived widths to constrain the converged size.
    for (let n = 0; n < 3; n++) {
      const fs = fkFontSpacing(curSizeL);
      const mostExtreme = fs / 2 - fkTop(curSizeL) + fkBottom(curSizeL);
      const lineRadius = Math.sqrt(Math.max(0, superInnerR * superInnerR - mostExtreme * mostExtreme));
      const reqSize = (t) => {
        const w = pickedMeasure(t, curSizeL);
        return w > lineRadius * 2 ? curSizeL * (lineRadius * 2) / w : curSizeL;
      };
      const oldSize = curSizeL;
      curSizeL = Math.min(reqSize(params.firstName), reqSize(params.lastName));
      if (Math.abs(oldSize - curSizeL) < 0.01) break;
    }
    const fs = fkFontSpacing(curSizeL);

    function drawCenteredLine(text, yL) {
      const f = pickStampFont(text);
      const wL = f.kitFont.layout(text).advanceWidth / f.kitFont.unitsPerEm * curSizeL;
      page.drawText(text, {
        x: toX(cxL - wL / 2),
        y: toY(yL),
        font: f.pdfFont,
        size: curSizeL * scale,
        color: stampRgb,
      });
    }
    drawCenteredLine(params.firstName,    cyL - fs * 0.75);
    drawCenteredLine(params.memberNumber, cyL + fs * 0.25);
    drawCenteredLine(params.lastName,     cyL + fs * 1.25);

    return stampHPt;
  }

  async function render(inputs) {
    const PDFLib = window.PDFLib;
    const { PDFDocument, rgb } = PDFLib;

    // Sanitize the same fields the server's RemoveTabs was called on, so control
    // characters from user input never reach drawText. Matches the C# behavior
    // covered by SuperSigningTester's TestControlCharactersInPDF.
    inputs = {
      ...inputs,
      contactInfo: _removeTabs(inputs.contactInfo),
      documentDescription: _removeTabs(inputs.documentDescription),
      credentialInfo: _removeTabs(inputs.credentialInfo),
      // Translator name fields are interpolated into buildDeclarationText, so
      // sanitize them too. (Server doesn't explicitly, but only because the
      // whole declarationText string is sanitized at draw time.)
      translatorsFirstName: _removeTabs(inputs.translatorsFirstName),
      translatorsLastName: _removeTabs(inputs.translatorsLastName),
      translatorsMemberNumber: _removeTabs(inputs.translatorsMemberNumber),
    };

    // Determine which fonts we actually need based on the text content, then
    // lazy-load just those. Lato (always) and Arial cover ~99% of cases without
    // pulling Malgun (17MB), YaHei (25MB), etc.
    const tr = inputs.declarationTranslation || null;
    const bodyTexts = [
      inputs.translatorsFirstName, inputs.translatorsLastName, inputs.translatorsMemberNumber,
      inputs.documentDescription, inputs.contactInfo, inputs.credentialInfo,
      inputs.fromLanguage, inputs.toLanguage,
      inputs.associationLongName, inputs.languagePairs,
      inputs.verifyURL,
      buildDeclarationText(inputs), // includes "Disclaimer:", "Avertissement :", etc.
      // Bilingual declaration (STIBC): the source-language block's text is
      // typically CJK/non-Latin, so feed it to the font walker too — otherwise
      // the fallback chain wouldn't load Malgun/YaHei/etc. for these glyphs.
      tr && tr.title, tr && tr.certificationStatement, tr && tr.documentsLabel, tr && tr.translatorsNote,
    ];
    const bodyFontsNeeded = await ensureFontsForTexts(bodyTexts, BODY_FALLBACK_ORDER);
    let stampFontsNeeded = null;
    if (inputs.associationShortName !== 'ATIO') {
      stampFontsNeeded = await ensureFontsForTexts(
        [inputs.translatorsFirstName, inputs.translatorsLastName, inputs.translatorsMemberNumber],
        STAMP_FALLBACK_ORDER
      );
    }

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(window.fontkit);
    const isAtio = inputs.associationShortName === 'ATIO';
    const isFrench = inputs.declarationLanguage === 'French';

    // Letter for ATIO, A4 for STIBC. Matches QuestPDF PageSizes.Letter / PageSizes.A4.
    const pageW = isAtio ? 612 : 595;
    const pageH = isAtio ? 792 : 842;
    const firstPage = pdf.addPage([pageW, pageH]);

    // Margins: ATIO vertical 0.635cm + horizontal 2cm; STIBC 2cm all around.
    const cm = 28.346;
    const marginX = 2 * cm;
    const marginYTop = isAtio ? 0.635 * cm : 2 * cm;
    const marginYBottom = isAtio ? 0.635 * cm : 2 * cm;
    const contentW = pageW - 2 * marginX;

    // Embed only the fonts ensureFontsForTexts said this render's text needs —
    // not every font that happens to be in fontByteCache. The cache persists
    // across renders, and re-embedding e.g. a previously-loaded 13MB Malgun
    // just because it's cached costs seconds per render with no benefit.
    const bodyChain = [];
    for (const name of bodyFontsNeeded) {
      const cached = fontByteCache[name];
      if (!cached) continue;
      const pdfFont = await pdf.embedFont(cached.bytes, { subset: true });
      bodyChain.push({ pdfFont, kitFont: cached.kitFont, name });
    }

    const baseSize = isAtio ? 10.5 : 12;
    const sectionGap = isAtio ? 15 : 20;

    // Reserve page.Footer().Height(120) for the QR overlay AddQRCode draws on
    // every page later, so no body content lands in the bottom 120pt. This is
    // keyed on supportsQr (every QR tenant needs the footer), not on ATIO —
    // STIBC now uses the QR footer too. Falls back to isAtio when the caller
    // doesn't pass supportsQr (keeps older callers' behavior unchanged).
    const footerReserve = (inputs.supportsQr ?? isAtio) ? 120 : 0;

    // Top of content area after PaddingVertical(1, Centimetre) inside the Content block.
    const yTop = pageH - marginYTop - cm;
    const ctx = {
      pdf,
      page: firstPage,
      pageW, pageH,
      y: yTop,
      yReset: yTop,
      yMin: marginYBottom + footerReserve,
    };

    // Logo row (logo + contact info on right). For ATIO logo width = contentW/3
    // (RelativeItem(0.5) over RelativeItem(1)); for STIBC = contentW/2. Logo is
    // sized to fit on whatever current page it lands on — if it would overflow,
    // _ensureSpace inside drawImageBlock starts a new page.
    if (inputs.logo) {
      const logoImg = await pdf.embedPng(inputs.logo);
      const logoW = isAtio ? contentW * (0.5 / 1.5) : contentW * 0.5;
      const logoH = logoImg.height * (logoW / logoImg.width);
      // Logo + contact-info column laid out side-by-side. Pre-compute the contact
      // text height so _ensureSpace can reserve max(logoH, contactH) — otherwise
      // a small logo with many contact lines could push the contact text past
      // the bottom margin on a short first page.
      // Contact column width mirrors the QuestPDF RelativeItem split: logo:contact
      // is 0.5:1.0 for ATIO and 0.5:0.5 for STIBC. Wrap to that width so long
      // address/contact lines don't run off the right edge.
      const contactColW = isAtio ? contentW * (1 / 1.5) : contentW * 0.5;
      const contactLines = inputs.contactInfo ? wrapTextLines(inputs.contactInfo, contactColW, baseSize, bodyChain) : [];
      const lh = lineHFor(baseSize);
      const contactH = contactLines.length * lh;
      const rowH = Math.max(logoH, contactH);
      _ensureSpace(ctx, rowH);
      const rowYTop = ctx.y;
      ctx.page.drawImage(logoImg, { x: marginX, y: rowYTop - logoH, width: logoW, height: logoH });
      let lineOff = 0;
      for (const line of contactLines) {
        // Use full bodyChain so contact lines with non-Latin chars (rare but
        // possible — addresses with accented chars, etc.) get proper fallback.
        const lw = measureRuns(line, baseSize, bodyChain);
        drawRunsAtBaseline(ctx.page, line, pageW - marginX - lw, rowYTop - lineOff - ascentFor(baseSize), baseSize, bodyChain);
        lineOff += lh;
      }
      ctx.y = rowYTop - rowH - sectionGap;
    } else if (inputs.contactInfo) {
      for (const line of wrapTextLines(inputs.contactInfo, contentW, baseSize, bodyChain)) {
        drawRight(ctx, line, pageW - marginX, baseSize, bodyChain);
      }
      ctx.y -= sectionGap;
    }

    // Title.
    const title = isFrench ? 'Déclaration du traducteur' : "Translator's Declaration";
    drawCentered(ctx, title, baseSize, bodyChain);
    ctx.y -= sectionGap;

    // Body declaration text.
    drawWrapped(ctx, buildDeclarationText(inputs), marginX, contentW, baseSize, bodyChain);
    ctx.y -= sectionGap;

    // Document list.
    const docsTitle = isFrench ? '        Liste des documents traduits :' : '        List of translated document(s):';
    drawLeft(ctx, docsTitle, marginX, baseSize, bodyChain);
    drawWrapped(ctx, inputs.documentDescription, marginX, contentW, baseSize, bodyChain);
    ctx.y -= sectionGap;

    // Date (centered). Computed in the association's timezone, matching the
    // server's TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, timeZoneID).
    drawCentered(ctx, formatDate(inputs.declarationLanguage, inputs.timeZoneID), baseSize, bodyChain);
    ctx.y -= sectionGap;

    // Signature image (ATIO only, 60pt tall, centered).
    if (inputs.signature) {
      const sigImg = await pdf.embedPng(inputs.signature);
      const sigH = 60;
      const sigW = sigImg.width * (sigH / sigImg.height);
      _ensureSpace(ctx, sigH);
      ctx.page.drawImage(sigImg, { x: (pageW - sigW) / 2, y: ctx.y - sigH, width: sigW, height: sigH });
      ctx.y -= sigH + sectionGap;
    }

    // Stamp — STIBC only (ATIO declaration has no inline stamp per the C#
    // `if (associationShortName != "ATIO")` guard). Native PDF vector.
    if (!isAtio) {
      // Stamp's logical height is 100pt; scaled to contentW so actual height
      // is (100 / 480) * contentW. Reserve space before drawing.
      const stampH = (100 / 480) * contentW;
      _ensureSpace(ctx, stampH);
      await drawStibcStampNative(ctx.page, pdf, {
        firstName: inputs.translatorsFirstName,
        lastName: inputs.translatorsLastName,
        memberNumber: inputs.translatorsMemberNumber,
        stampColor: inputs.stampColor,
      }, marginX, ctx.y, contentW, stampFontsNeeded);
      ctx.y -= sectionGap;
    }

    // Verification text — body content (GenerateDeclaration.cs:405-433). Wording
    // differs between ATIO and non-ATIO; STIBC also gets a 100pt PaddingTop.
    if (!isAtio) ctx.y -= 100;
    if (isAtio) {
      const verifyText = isFrench
        ? "Cette traduction a été signée numériquement. Pour vérifier l'authenticité de ce document, visitez "
        : 'This translation has been digitally signed. To verify the authenticity of this document, visit ';
      const qrText = isFrench ? ' OU scannez le code QR.' : ' OR scan the QR code.';
      const vSize = isFrench ? 11 : baseSize;
      drawWrapped(ctx, verifyText, marginX, contentW, vSize, bodyChain);
      // URL + qrText on the same line: draw URL at current y (advances y), then
      // back-out one lineH and draw qrText to the right of URL on the same line.
      const lh = lineHFor(vSize);
      const urlW = measureRuns(inputs.verifyURL, vSize, bodyChain);
      _ensureSpace(ctx, lh);
      const sameLineY = ctx.y;
      drawRunsAtBaseline(ctx.page, inputs.verifyURL, marginX, sameLineY - ascentFor(vSize), vSize, bodyChain, { color: rgb(0, 0, 1) });
      drawRunsAtBaseline(ctx.page, qrText, marginX + urlW, sameLineY - ascentFor(vSize), vSize, bodyChain);
      ctx.y -= lh;
    } else {
      const verifyText = isFrench
        ? "Cette traduction a été signée numériquement et la version électronique de ce document ne nécessite pas de signature physique ni de tampon. Pour vérifier l'authenticité de ce document, visitez "
        : 'This translation has been digitally signed and the electronic version of this document does not require a physical signature or stamp. To verify the authenticity of this document, visit ';
      drawWrapped(ctx, verifyText, marginX, contentW, baseSize, bodyChain);
      const lh = lineHFor(baseSize);
      const urlW = measureRuns(inputs.verifyURL, baseSize, bodyChain);
      _ensureSpace(ctx, lh);
      const sameLineY = ctx.y;
      drawRunsAtBaseline(ctx.page, inputs.verifyURL, marginX, sameLineY - ascentFor(baseSize), baseSize, bodyChain, { color: rgb(0, 0, 1) });
      drawRunsAtBaseline(ctx.page, '.', marginX + urlW, sameLineY - ascentFor(baseSize), baseSize, bodyChain);
      ctx.y -= lh;
    }

    // Credential info (centered, flows immediately after verification text per
    // QuestPDF Column with x.Spacing — GenerateDeclaration.cs:435-438).
    if (inputs.credentialInfo) {
      ctx.y -= sectionGap;
      for (const line of wrapTextLines(inputs.credentialInfo, contentW, baseSize, bodyChain)) {
        drawCentered(ctx, line, baseSize, bodyChain);
      }
    }

    // Bilingual declaration (STIBC requested): a second declaration block in the
    // document's source language, stacked below the English one. Drawn only when
    // the association supplied a translation for this source language (matched by
    // languageName in _buildRenderInputs). Mirrors the English block's structure:
    // dotted rule, title, certification statement, documents label + list, date,
    // translator's note.
    if (tr) {
      ctx.y -= sectionGap;
      _ensureSpace(ctx, lineHFor(baseSize) * 3);
      drawWrapped(ctx, '. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .', marginX, contentW, baseSize, bodyChain, { color: rgb(0.6, 0.6, 0.6) });
      ctx.y -= sectionGap;
      if (tr.title) { drawCentered(ctx, _fillTranslationTokens(tr.title, inputs), baseSize, bodyChain); ctx.y -= sectionGap; }
      drawWrapped(ctx, _fillTranslationTokens(tr.certificationStatement, inputs), marginX, contentW, baseSize, bodyChain);
      if (tr.documentsLabel || inputs.documentDescription) {
        ctx.y -= sectionGap;
        if (tr.documentsLabel) drawLeft(ctx, _fillTranslationTokens(tr.documentsLabel, inputs), marginX, baseSize, bodyChain);
        drawWrapped(ctx, inputs.documentDescription, marginX, contentW, baseSize, bodyChain);
      }
      ctx.y -= sectionGap;
      drawCentered(ctx, formatDate(inputs.declarationLanguage, inputs.timeZoneID), baseSize, bodyChain);
      if (tr.translatorsNote) {
        ctx.y -= sectionGap;
        drawWrapped(ctx, _fillTranslationTokens(tr.translatorsNote, inputs), marginX, contentW, baseSize, bodyChain);
      }
    }

    return await pdf.save();
  }

  // === Canvas-based stamp PNG renderer (replaces the deleted /stamp endpoint) ===
  // Mirrors PDFSigningServer.GenerateStamp's SKBitmap + DrawStamp pipeline but in
  // Canvas. ATIO uses a 420×420 oversampled canvas with full text complexity
  // (Futura outer arc, Arial Bold + Times Bold + Arial Bold center stack with
  // TextScaleX squeezes). STIBC uses a 480×116 canvas with dashed dual rings and
  // simple firstName/memberNumber/lastName stack in Segoe UI.

  // Stamp fonts registered as FontFace so Canvas ctx.font='... "Arial" ...' uses
  // our bundled TTFs, not the OS's idea of those families.
  const _registeredStampFonts = new Set();
  async function ensureStampFontFace(canvasFamily, urlKey, descriptors = {}) {
    const key = canvasFamily + '|' + JSON.stringify(descriptors);
    if (_registeredStampFonts.has(key)) return;
    const cached = await loadFontBytes(urlKey);
    const ff = new FontFace(canvasFamily, cached.bytes.buffer, descriptors);
    await ff.load();
    document.fonts.add(ff);
    _registeredStampFonts.add(key);
  }
  async function ensureStampFonts(isAtio) {
    // Load only the fonts each stamp variant actually renders with:
    //   ATIO  uses Arial Bold (outer measurement + center stack), Times Bold
    //         ("atio" wordmark), and DejaVu Sans Bold (outer arc drawing —
    //         matches Skia's actual fallback for "Futura" on the Linux container).
    //   STIBC uses Segoe UI for everything (matches DefaultTypeFace).
    // Loading Segoe UI for ATIO or Arial regular / FuturaBoldCondensed for either
    // was just wasted parse+download time.
    if (isAtio) {
      await Promise.all([
        ensureStampFontFace('Arial', 'ArialBold', { weight: 'bold' }),
        ensureStampFontFace('TimesBold', 'TimesBold'),
        ensureStampFontFace('DejaVuSansBold', 'DejaVuSansBold', { weight: 'bold' }),
      ]);
    } else {
      await ensureStampFontFace('SegoeUI', 'SegoeUI');
    }
  }

  // fontkit-backed wrapper for measurement; Canvas does the rendering via canvasFamily.
  class _StampFont {
    constructor(canvasFamily, kitFont, weight = 'bold') {
      this.canvasFamily = canvasFamily; this.fk = kitFont; this.weight = weight;
    }
    fontStr(size, family = this.canvasFamily) { return `${this.weight} ${size}px "${family}"`.trim(); }
    top(size) { return -this.fk.bbox.maxY / this.fk.unitsPerEm * size; }
    bottom(size) { return -this.fk.bbox.minY / this.fk.unitsPerEm * size; }
    fontSpacing(size) { return (this.fk.ascent - this.fk.descent + this.fk.lineGap) / this.fk.unitsPerEm * size; }
    measure(text, size) { return this.fk.layout(text).advanceWidth / this.fk.unitsPerEm * size; }
    requiredSize(text, currentSize, radius) {
      const w = this.measure(text, currentSize);
      return w > radius * 2 ? currentSize * (radius * 2) / w : currentSize;
    }
  }

  // Draw text along a circular arc. See playground commentary for full derivation.
  // Uses Canvas's measureText (handles font fallback for partial fonts like Futura).
  function _drawArcTextCanvas(ctx, text, sf, cx, cy, radius, startAngle, topArc, size, scaleX = 1) {
    ctx.save();
    ctx.font = sf.fontStr(size);
    ctx.textAlign = 'center';
    ctx.textBaseline = topArc ? 'alphabetic' : 'hanging';
    const measure = s => ctx.measureText(s).width * scaleX;
    let angle = startAngle;
    for (const ch of text) {
      const chArc = measure(ch) / radius;
      const a = topArc ? angle + chArc / 2 : angle - chArc / 2;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.rotate(topArc ? a + Math.PI / 2 : a - Math.PI / 2);
      if (scaleX !== 1) ctx.scale(scaleX, 1);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
      angle += topArc ? chArc : -chArc;
    }
    ctx.restore();
  }

  function _drawCenteredSqueezed(ctx, text, sf, cx, baselineY, size, scaleX = 1, family = null) {
    ctx.save();
    ctx.font = sf.fontStr(size, family || sf.canvasFamily);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.translate(cx, baselineY);
    if (scaleX !== 1) ctx.scale(scaleX, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // Faithful port of DrawStamp (PDFSigningServer_GenerateDeclaration.cs:20-221).
  // Returns Uint8Array PNG bytes. params:
  //   { firstName, memberNumber, lastName, languagePairs, isFrench, isFemale,
  //     isAtio, stampColor }
  async function renderStampPng(params) {
    const { firstName, memberNumber, lastName, languagePairs, isFrench, isFemale, isAtio, stampColor } = params;
    await ensureStampFonts(isAtio);

    // Match the server's original PNG dimensions exactly (444×444 for ATIO,
    // 480×116 for STIBC). Oversampling here was a holdover from the playground
    // where the stamp was embedded inline at small PDF size and needed extra DPI
    // — irrelevant for the standalone PNG that AddQRCode (Blazor WASM iTextSharp)
    // receives, where it just inflates the bytes and stalls embed.
    const OVERSAMPLE = 1;
    // renderStampPng is the equivalent of the C# GenerateStamp function (the
    // standalone bitmap that AddQRCode/stamp-every-page consumes), NOT the
    // inline DrawStamp call that GenerateDeclaration made for STIBC body. Both
    // associations produce a square bitmap from GenerateStamp:
    //   width = 420 * stampMultiplier; radius = 200 * stampMultiplier
    //   stampMultiplier = isAtio ? (1.5/1.42) : 1
    // (See PDFSigningServer_GenerateDeclaration.cs:225-227.)
    const stampMult = isAtio ? (1.5 / 1.42) : 1;
    const lWidth = Math.round(420 * stampMult);
    const lFullR = Math.round(200 * stampMult);
    const lHeight = lWidth;
    const width = lWidth * OVERSAMPLE;
    const fullR = lFullR * OVERSAMPLE;
    const height = lHeight * OVERSAMPLE;
    const yOffset = (height - fullR * 2) / 2;
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    const leftCenter = width / 2 - fullR;
    const cxR = fullR + leftCenter;
    const cyR = fullR + yOffset;
    const mult = fullR / 50;
    const innerR = fullR * ((isAtio ? 21.7 : 19) / 25);
    const superInnerR = innerR - mult * 3;

    const arialBold = new _StampFont('Arial',           fontByteCache.ArialBold?.kitFont,           'bold');
    const timesBold = new _StampFont('TimesBold',       fontByteCache.TimesBold?.kitFont,           'bold');
    const segoeUI   = new _StampFont('SegoeUI',         fontByteCache.SegoeUI?.kitFont,             '');
    const dvSansBd  = new _StampFont('DejaVuSansBold',  fontByteCache.DejaVuSansBold?.kitFont,      'bold');

    ctx.fillStyle = stampColor; ctx.strokeStyle = stampColor;

    // 1. Outer ring (and inner ring for STIBC only). PathEffect.CreateDash is set
    // ONCE for STIBC before the outer DrawCircle and never cleared — so both rings
    // are dashed in C#. Don't reset setLineDash([]) between them.
    ctx.lineWidth = mult * (isAtio ? 2 : 4);
    if (!isAtio) ctx.setLineDash([mult * 1, mult * 0.5]);
    ctx.beginPath(); ctx.arc(cxR, cyR, fullR, 0, Math.PI * 2); ctx.stroke();
    if (!isAtio) {
      ctx.lineWidth = mult;
      ctx.beginPath(); ctx.arc(cxR, cyR, innerR - mult * 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);

    // 2. Outer arc text. Measurement font matches C# line 69 (Arial Bold for ATIO,
    // default Segoe UI for STIBC). ATIO halves outerSize and inflates by /0.75
    // before drawing in DejaVuSansBold (server's actual fallback for "Futura") with
    // TextScaleX = 0.6.
    const outerText = isAtio
      ? (isFrench
          ? "Association des traducteurs et interprètes de l'Ontario"
          : 'Association of Translators and Interpreters of Ontario')
      : 'B.C. (STIBC)        Society of Translators and Interpreters of ';
    const outerMeasureFont = isAtio ? arialBold : segoeUI;
    let outerSize = 100 * (2 * Math.PI * innerR) / outerMeasureFont.measure(outerText, 100);
    if (isAtio) outerSize /= 2;
    let curSize = outerSize;
    const outerDrawSize = isAtio ? outerSize / 0.75 : outerSize;
    const outerDrawFont = isAtio ? dvSansBd : segoeUI;
    const outerStartAngle = isAtio ? Math.PI : 0;
    _drawArcTextCanvas(ctx, outerText, outerDrawFont, cxR, cyR, innerR, outerStartAngle, true,
      outerDrawSize, isAtio ? 0.6 : 1);

    if (isAtio) {
      const fullName = [firstName, lastName].filter(s => s).join(' ');
      const certText = isFrench ? (isFemale ? 'Traductrice agréée' : 'Traducteur agréé') : 'Certified Translator';
      const SZ = { s1: 0.1022 * 10.3, s2: 0.1159 * 10.3, s3: 0.3615 * 10.3, s4: 0.1045 * 10.3, s5: 0.1252 * 10.3 };
      for (let n = 0; ; n++) {
        const fs = arialBold.fontSpacing(curSize);
        const mostExtreme = fs / 2 - arialBold.top(curSize) + arialBold.bottom(curSize);
        const lineRadius = Math.sqrt(Math.max(0, superInnerR * superInnerR - mostExtreme * mostExtreme));
        const oldSize = curSize;
        curSize = Math.min(
          arialBold.requiredSize(certText,      curSize, lineRadius) * SZ.s1,
          arialBold.requiredSize(languagePairs, curSize, lineRadius) * SZ.s2,
          arialBold.requiredSize('atio',        curSize, lineRadius) * SZ.s3,
          arialBold.requiredSize(fullName,      curSize, lineRadius) * SZ.s4,
          arialBold.requiredSize(memberNumber,  curSize, lineRadius) * SZ.s5,
        );
        if (Math.abs(oldSize - curSize) < 0.01 || n >= 2) break;
      }
      let textSize = curSize * SZ.s1;
      const baseFontSpacing = arialBold.fontSpacing(textSize);
      let off = -baseFontSpacing * 3.75;
      textSize *= SZ.s2 / SZ.s1;
      _drawCenteredSqueezed(ctx, languagePairs, arialBold, cxR, cyR + off, textSize);
      off += arialBold.fontSpacing(textSize) * 1.5;
      textSize *= SZ.s1 / SZ.s2;
      _drawCenteredSqueezed(ctx, certText, arialBold, cxR, cyR + off, textSize);
      off += arialBold.fontSpacing(textSize) * 0.5 + baseFontSpacing * 0.5;
      textSize *= SZ.s3 / SZ.s1;
      const atioOffset = timesBold.fontSpacing(textSize);
      off += atioOffset * 0.75;
      _drawCenteredSqueezed(ctx, 'atio', timesBold, cxR, cyR + off, textSize / 0.75, 0.75);
      textSize *= SZ.s4 / SZ.s3;
      off += arialBold.fontSpacing(textSize) * 1.5;
      _drawCenteredSqueezed(ctx, fullName, arialBold, cxR, cyR + off, textSize);
      off += arialBold.fontSpacing(textSize) * 2;
      textSize *= SZ.s5 / SZ.s4;
      _drawCenteredSqueezed(ctx,
        memberNumber.split('').join(' '),
        arialBold, cxR, cyR + off, textSize / 0.6, 0.6);
    } else {
      // STIBC iteration (size that fits both first and last names).
      for (let n = 0; ; n++) {
        const fs = segoeUI.fontSpacing(curSize);
        const mostExtreme = fs / 2 - segoeUI.top(curSize) + segoeUI.bottom(curSize);
        const lineRadius = Math.sqrt(Math.max(0, superInnerR * superInnerR - mostExtreme * mostExtreme));
        const oldSize = curSize;
        curSize = Math.min(
          segoeUI.requiredSize(firstName, curSize, lineRadius),
          segoeUI.requiredSize(lastName,  curSize, lineRadius),
        );
        if (Math.abs(oldSize - curSize) < 0.01 || n >= 2) break;
      }
      const fs = segoeUI.fontSpacing(curSize);
      _drawCenteredSqueezed(ctx, firstName,    segoeUI, cxR, cyR - fs * 0.75, curSize);
      _drawCenteredSqueezed(ctx, memberNumber, segoeUI, cxR, cyR + fs * 0.25, curSize);
      _drawCenteredSqueezed(ctx, lastName,     segoeUI, cxR, cyR + fs * 1.25, curSize);
    }

    return new Promise(resolve =>
      c.toBlob(b => b.arrayBuffer().then(ab => resolve(new Uint8Array(ab))), 'image/png'));
  }

  window.RenderDeclaration = { render, renderStampPng };
})();
