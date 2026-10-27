/* DashBank i18n — tiny, dependency-free. Exposes window.I18N for app.js, the legal pages and the login page.
 * Load it as a classic (non-deferred) script in <head>: it sets <html lang dir> before first paint and starts
 * fetching the locale file; pages then `await I18N.ready` before rendering text.
 *
 *   I18N.t('sync.synced', { when })          → interpolates {when}; numbers are locale-formatted
 *   I18N.t('time.minutes_ago', { count: 5 }) → plural object { one, two, other } picked by Intl.PluralRules
 *   I18N.term('categories', name)            → display name for a data value (falls back to the value)
 *   I18N.setLang('en')                       → switches, persists, re-applies data-i18n*, fires 'i18n:change'
 *   I18N.apply(root)                         → fills [data-i18n], [data-i18n-label|placeholder|title|alt]
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'dashbank.lang';
  const SUPPORTED = ['he', 'en'];
  const LOCALES = { he: 'he-IL', en: 'en-IL' };
  const DIRS = { he: 'rtl', en: 'ltr' };
  // Resolve locale files next to this script so pages in sub-folders (legal/) work too.
  const BASE = (document.currentScript && document.currentScript.src) || location.href;

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }
  function persist(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode etc. */ }
  }
  function detect() {
    const s = stored();
    if (SUPPORTED.includes(s)) return s;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    return /^(he|iw)\b/i.test(nav) ? 'he' : 'en';
  }

  let lang = detect();
  let dict = {};
  let plural = new Intl.PluralRules(LOCALES[lang]);
  let numFmt = new Intl.NumberFormat(LOCALES[lang]);

  function setDocAttrs(l) {
    const html = document.documentElement;
    html.lang = l;
    html.dir = DIRS[l];
  }
  setDocAttrs(lang);

  async function load(l) {
    const res = await fetch(new URL(`locales/${l}.json`, BASE), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`locale ${l}: HTTP ${res.status}`);
    return res.json();
  }

  function lookup(key) {
    let node = dict;
    for (const part of String(key).split('.')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }

  function interpolate(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, (m, name) => {
      if (!(name in vars)) return m;
      const v = vars[name];
      return typeof v === 'number' ? numFmt.format(v) : String(v ?? '');
    });
  }

  function t(key, vars) {
    let v = lookup(key);
    if (v && typeof v === 'object' && 'other' in v) {
      const n = Number(vars?.count);
      v = (Number.isFinite(n) && v[plural.select(n)]) || v.other;
    }
    if (typeof v !== 'string') return key;
    return interpolate(v, vars);
  }

  // Data values (category names, kinds, sources) keyed by their raw value — no dot-splitting.
  function term(group, value) {
    if (value == null || value === '') return value;
    const g = dict[group];
    const v = g && Object.prototype.hasOwnProperty.call(g, value) ? g[value] : undefined;
    return typeof v === 'string' ? v : value;
  }

  const ATTRS = [['i18nLabel', 'aria-label'], ['i18nPlaceholder', 'placeholder'], ['i18nTitle', 'title'], ['i18nAlt', 'alt']];
  function apply(root = document) {
    for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const [ds, attr] of ATTRS) {
      const sel = `[data-${ds.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
      for (const node of root.querySelectorAll(sel)) node.setAttribute(attr, t(node.dataset[ds]));
    }
    const pageTitle = document.documentElement.dataset.i18nPageTitle;
    if (pageTitle) document.title = t(pageTitle);
  }

  function use(l, data) {
    lang = l;
    dict = data || {};
    plural = new Intl.PluralRules(LOCALES[l]);
    numFmt = new Intl.NumberFormat(LOCALES[l]);
    setDocAttrs(l);
  }

  async function setLang(l, { save = true } = {}) {
    if (!SUPPORTED.includes(l)) l = 'he';
    const data = await load(l);
    use(l, data);
    if (save) persist(l);
    apply(document);
    document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: l } }));
    return l;
  }

  const ready = load(lang)
    .catch(() => (lang === 'he' ? {} : load('he').then((d) => { lang = 'he'; return d; }).catch(() => ({}))))
    .then((data) => {
      use(lang, data);
      if (document.readyState === 'loading') {
        return new Promise((r) => document.addEventListener('DOMContentLoaded', () => { apply(document); r(lang); }, { once: true }));
      }
      apply(document);
      return lang;
    })
    .finally(() => document.documentElement.classList.remove('i18n-loading'));

  // Hide text only while a non-default language loads, so Hebrew markup never flashes for English users.
  if (lang !== 'he') document.documentElement.classList.add('i18n-loading');

  window.I18N = {
    ready,
    t,
    term,
    apply,
    setLang,
    toggle: () => setLang(lang === 'he' ? 'en' : 'he'),
    get lang() { return lang; },
    get dir() { return DIRS[lang]; },
    get locale() { return LOCALES[lang]; },
    SUPPORTED,
    STORAGE_KEY,
  };
})();
