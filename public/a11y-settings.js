// DashBank display and accessibility settings: pure logic plus an early boot step.
// Loaded as a classic <script> in <head> (sets window.A11Y and applies saved settings before
// first paint) and imported by Node tests (sets globalThis.A11Y).
(function (root) {
  'use strict';

  const KEY = 'dashbank.a11y';
  const CHOICES = {
    text: ['100', '115', '130', '150'],
    contrast: ['normal', 'high'],
    theme: ['system', 'light', 'dark'],
    font: ['default', 'dyslexia'],
    motion: ['system', 'on', 'off'],
  };
  const DEFAULTS = { text: '100', contrast: 'normal', theme: 'system', font: 'default', motion: 'system' };

  function normalise(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      const v = String(src[k]);
      out[k] = CHOICES[k].includes(v) ? v : DEFAULTS[k];
    }
    return out;
  }

  function load(storage) {
    try { return normalise(JSON.parse(storage.getItem(KEY))); } catch { return normalise(null); }
  }

  function save(storage, settings) {
    try { storage.setItem(KEY, JSON.stringify(normalise(settings))); return true; } catch { return false; }
  }

  function toAttributes(settings) {
    const s = normalise(settings);
    return { 'data-text': s.text, 'data-contrast': s.contrast, 'data-theme': s.theme, 'data-font': s.font, 'data-motion': s.motion };
  }

  function apply(el, settings) {
    const attrs = toAttributes(settings);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
  }

  function isMotionOff(settings, systemPrefersReduced) {
    const m = normalise(settings).motion;
    return m === 'off' || (m === 'system' && Boolean(systemPrefersReduced));
  }

  root.A11Y = { KEY, CHOICES, DEFAULTS, normalise, load, save, toAttributes, apply, isMotionOff };

  if (typeof document !== 'undefined') {
    let storage = null;
    try { storage = root.localStorage; } catch { /* storage blocked: defaults apply */ }
    apply(document.documentElement, storage ? load(storage) : null);
  }
})(typeof window !== 'undefined' ? window : globalThis);
