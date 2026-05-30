// Shared paper-UI shell glue, loaded by both the certify (index.html) and
// verify (verify-document.html) pages. Lives in an external file (not inline)
// because verify-document.html ships a strict CSP with no 'unsafe-inline' for
// script-src.
//
// Three responsibilities, each guarded so the script is a no-op when the
// relevant element is absent:
//   1. Tenant branding — read window.ORG_NAME (set by the wrapper SW's
//      injected /__tenant-globals.js) to swap the topbar logo, reveal the
//      "Powered by LynxSeal" attribution, and point the wordmark at the
//      tenant's parent domain.
//   2. Language toggle — wire #langToggleBtn to the page's global
//      switchLanguage() (defined by index-page.js / verify-document.js).
//   3. Drop zones — drag/drop + filled-card rendering for every .drop.

'use strict';

(function () {
  function initBranding() {
    // Wordmark links to the tenant's top-level domain — derived by stripping
    // the first subdomain label of location.hostname:
    //   portal.lynxseal.com             → lynxseal.com
    //   certify.stibc.org               → stibc.org
    //   certify.atio.on.ca              → atio.on.ca
    //   certify-atio-test.lynxseal.com  → lynxseal.com
    const host = location.hostname;
    const i = host.indexOf('.');
    const homeUrl = i > 0 ? 'https://' + host.substring(i + 1) : null;
    const wordmark = document.getElementById('tenantWordmark');
    if (wordmark && homeUrl) wordmark.href = homeUrl;

    if (window.ORG_NAME && window.ORG_NAME !== 'LynxSeal') {
      const logoEl = document.getElementById('tenantLogo');
      if (logoEl) { logoEl.src = '/logo.png'; logoEl.alt = window.ORG_NAME; }
      document.querySelectorAll('.powered-by, .powered-sep').forEach(el => el.hidden = false);
      // The browser-tab title gets its "· <ORG_NAME>" suffix from
      // portal-bridge.js; we deliberately don't touch document.title here to
      // avoid a double suffix.
    }
  }

  function initLangToggle() {
    const langBtn = document.getElementById('langToggleBtn');
    if (!langBtn) return;
    langBtn.addEventListener('click', () => {
      const next = document.body.classList.contains('lang-fr') ? 'en' : 'fr';
      if (typeof window.switchLanguage === 'function') window.switchLanguage(next);
    });
  }

  function initDropZones() {
    for (const drop of document.querySelectorAll('.drop')) {
      const input = drop.querySelector('input[type=file]');
      const fileCard = drop.querySelector('.drop-file');
      if (!input || !fileCard) continue;
      ['dragenter', 'dragover'].forEach(ev =>
        drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev =>
        drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          input.files = e.dataTransfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      input.addEventListener('change', () => {
        const f = input.files && input.files[0];
        if (!f) { drop.classList.remove('filled'); fileCard.replaceChildren(); return; }
        drop.classList.add('filled');
        const sizeKb = (f.size / 1024).toFixed(0);
        // Build with DOM APIs (no innerHTML) so the strict-CSP verify page is
        // happy and filenames can't inject markup.
        fileCard.replaceChildren();
        const icon = document.createElement('span');
        icon.className = 'drop-icon';
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l3 3v9H4V2z" stroke="currentColor" stroke-width="1.2"/></svg>';
        const meta = document.createElement('span');
        meta.className = 'drop-meta';
        const name = document.createElement('span');
        name.className = 'drop-name';
        name.textContent = f.name;
        const sub = document.createElement('span');
        sub.className = 'drop-sub';
        sub.textContent = `${sizeKb} KB · ${f.type || 'file'}`;
        meta.append(name, sub);
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'drop-clear';
        clear.textContent = 'Remove';
        clear.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          input.value = '';
          drop.classList.remove('filled');
          fileCard.replaceChildren();
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        fileCard.append(icon, meta, clear);
      });
    }
  }

  function init() {
    initBranding();
    initLangToggle();
    initDropZones();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
