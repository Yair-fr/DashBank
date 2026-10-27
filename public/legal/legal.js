/* Shared script for the legal pages: shows the article in the chosen language (both are in the
 * markup, so the page still works without JS), wires the language toggle and fills in the
 * accessibility contact from /api/public-config. */
(() => {
  'use strict';
  const I18N = window.I18N;

  function showLanguage() {
    for (const art of document.querySelectorAll('[data-legal-lang]')) art.hidden = art.dataset.legalLang !== I18N.lang;
    const target = I18N.t('lang.toggle_target');
    for (const id of ['lang-short', 'lang-name']) { const n = document.getElementById(id); if (n) n.lang = target; }
  }

  async function fillContact() {
    let contact = null;
    try {
      const res = await fetch('../api/public-config', { headers: { Accept: 'application/json' } });
      if (res.ok) contact = (await res.json()).accessibilityContact || null;
    } catch { /* offline: fall back to the default wording */ }
    for (const node of document.querySelectorAll('[data-a11y-contact]')) {
      const lang = node.closest('[data-legal-lang]')?.dataset.legalLang || I18N.lang;
      const fallback = lang === 'en' ? 'The system owner' : 'בעל המערכת';
      if (contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        const a = document.createElement('a');
        a.href = `mailto:${contact}`;
        a.textContent = contact;
        a.lang = 'en';
        node.replaceChildren(a);
      } else {
        node.textContent = contact || fallback;
      }
    }
  }

  I18N.ready.then(() => {
    showLanguage();
    document.getElementById('lang-btn')?.addEventListener('click', () => { I18N.toggle().catch(() => {}); });
    document.addEventListener('i18n:change', showLanguage);
    fillContact();
  });
})();
