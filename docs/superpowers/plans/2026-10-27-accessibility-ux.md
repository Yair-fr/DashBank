# Accessibility Panel and Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-device display and accessibility panel (text size, high contrast, theme, dyslexia font and spacing, motion override) and smoother, switch-off-able motion to the DashBank dashboard.

**Architecture:** A framework-free settings module (`public/a11y-settings.js`) saves five choices in `localStorage` and applies them as `data-*` attributes on `<html>`; CSS variables and attribute selectors do the rest. A gear button in the header opens the existing bottom sheet with the panel. Motion helpers consult the same settings.

**Tech Stack:** Vanilla JS classic scripts (no build step), CSS custom properties, Node 22 `node:test`, Playwright (optional, tests skip without it).

## Global Constraints
- No new runtime dependencies. No external hosts: fonts are self-hosted in `public/fonts/`, no CDN.
- Node >= 22.22.2. Tests: `npm test` must pass before every commit. Browser tests skip when Playwright is missing.
- Settings key: `dashbank.a11y` (JSON). Values: text `100|115|130|150`; contrast `normal|high`; theme `system|light|dark`; font `default|dyslexia`; motion `system|on|off`.
- Attributes on `<html>`: `data-text`, `data-contrast`, `data-theme`, `data-font`, `data-motion`.
- All new UI strings go in both `public/locales/en.json` and `public/locales/he.json` under the key group `a11y` (the i18n parity test enforces this). Code and comments in English.
- High-contrast palettes must reach **7:1** for text tokens on bg, surface, surface-2 and surface-3.
- Only `transform` and `opacity` are animated. With motion off, no animation or transition runs.
- Every commit message ends with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UrKkXFXAGtpfQyroaWdvfw`.
- Correction to the spec: the month label already has `aria-live="polite"` (index.html line 39), so no change is needed there.

## File Structure
| File | Responsibility |
|---|---|
| `public/a11y-settings.js` (create) | Pure settings logic + early boot that applies saved attributes before first paint |
| `public/a11y-panel.js` (create) | Gear button wiring and the panel contents inside the shared bottom sheet |
| `public/styles.css` (modify) | rem font sizes, theme attribute blocks, high-contrast palettes, dyslexia font, motion switches, panel styles |
| `public/app.js` (modify) | Replace the fixed `reducedMotion` constant with a live check, expose sheet helpers, re-render charts on settings change, motion upgrades |
| `public/index.html` (modify) | Script tags, gear button |
| `public/locales/en.json`, `he.json` (modify) | `a11y.*` strings |
| `public/sw.js` (modify) | Precache new files, bump `VERSION` |
| `public/fonts/` (create) | Self-hosted Atkinson Hyperlegible (OFL) |
| `tests/a11y-settings.test.js`, `tests/css-a11y.test.js`, `tests/a11y-panel.test.js` (create) | Unit, CSS and browser tests |
| `tests/helpers/css.js` (create) | CSS parsing and contrast helpers |

---

### Task 1: Settings module

**Files:**
- Create: `public/a11y-settings.js`
- Test: `tests/a11y-settings.test.js`

**Interfaces:**
- Produces: `window.A11Y` (or `globalThis.A11Y` in Node) with `KEY`, `CHOICES`, `DEFAULTS`, `normalise(raw) → settings`, `load(storage) → settings`, `save(storage, settings) → boolean`, `toAttributes(settings) → { 'data-text', 'data-contrast', 'data-theme', 'data-font', 'data-motion' }`, `apply(el, settings)`, `isMotionOff(settings, systemPrefersReduced) → boolean`. `settings` is `{ text, contrast, theme, font, motion }`, all strings.

- [ ] **Step 1: Write the failing test**

Create `tests/a11y-settings.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../public/a11y-settings.js');
const { A11Y } = globalThis;

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};
const throwingStorage = () => ({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });

test('normalise returns defaults for missing or garbage input', () => {
  assert.deepEqual(A11Y.normalise(null), A11Y.DEFAULTS);
  assert.deepEqual(A11Y.normalise('nope'), A11Y.DEFAULTS);
  assert.deepEqual(A11Y.normalise([]), A11Y.DEFAULTS);
});

test('normalise keeps valid values and drops invalid ones individually', () => {
  const s = A11Y.normalise({ text: '130', contrast: 'high', theme: 'purple', font: 'dyslexia', motion: 7 });
  assert.deepEqual(s, { text: '130', contrast: 'high', theme: 'system', font: 'dyslexia', motion: 'system' });
});

test('normalise accepts numbers for text size', () => {
  assert.equal(A11Y.normalise({ text: 115 }).text, '115');
  assert.equal(A11Y.normalise({ text: 200 }).text, '100');
});

test('load reads stored JSON and falls back to defaults on bad JSON or blocked storage', () => {
  assert.equal(A11Y.load(memoryStorage({ [A11Y.KEY]: '{"theme":"dark"}' })).theme, 'dark');
  assert.deepEqual(A11Y.load(memoryStorage({ [A11Y.KEY]: '{not json' })), A11Y.DEFAULTS);
  assert.deepEqual(A11Y.load(memoryStorage()), A11Y.DEFAULTS);
  assert.deepEqual(A11Y.load(throwingStorage()), A11Y.DEFAULTS);
});

test('save round-trips and reports failure when storage is blocked', () => {
  const storage = memoryStorage();
  assert.equal(A11Y.save(storage, { text: '150', theme: 'light' }), true);
  const back = A11Y.load(storage);
  assert.equal(back.text, '150');
  assert.equal(back.theme, 'light');
  assert.equal(back.contrast, 'normal');
  assert.equal(A11Y.save(throwingStorage(), { text: '150' }), false);
});

test('toAttributes maps every setting to a data attribute', () => {
  assert.deepEqual(
    A11Y.toAttributes({ text: '115', contrast: 'high', theme: 'dark', font: 'dyslexia', motion: 'off' }),
    { 'data-text': '115', 'data-contrast': 'high', 'data-theme': 'dark', 'data-font': 'dyslexia', 'data-motion': 'off' },
  );
});

test('apply sets all five attributes on an element', () => {
  const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  A11Y.apply(el, { motion: 'on' });
  assert.equal(el.attrs['data-motion'], 'on');
  assert.equal(el.attrs['data-text'], '100');
  assert.equal(Object.keys(el.attrs).length, 5);
});

test('isMotionOff: explicit choice wins over the system preference', () => {
  assert.equal(A11Y.isMotionOff({ motion: 'off' }, false), true);
  assert.equal(A11Y.isMotionOff({ motion: 'on' }, true), false);
  assert.equal(A11Y.isMotionOff({ motion: 'system' }, true), true);
  assert.equal(A11Y.isMotionOff({ motion: 'system' }, false), false);
  assert.equal(A11Y.isMotionOff(null, true), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test tests/a11y-settings.test.js`
Expected: FAIL (`Cannot find module '../public/a11y-settings.js'`).

- [ ] **Step 3: Write the implementation**

Create `public/a11y-settings.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test tests/a11y-settings.test.js`
Expected: PASS, 8 tests, 0 fail.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add public/a11y-settings.js tests/a11y-settings.test.js
git commit -m "feat(a11y): settings module with validation and per-device storage" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UrKkXFXAGtpfQyroaWdvfw"
```
Expected: all tests pass before the commit.

---

### Task 2: CSS foundation (text scaling, themes, contrast, font, motion switches)

**Files:**
- Modify: `public/styles.css`
- Create: `tests/helpers/css.js`, `tests/css-a11y.test.js`, `public/fonts/atkinson-hyperlegible-latin-400-normal.woff2`, `public/fonts/atkinson-hyperlegible-latin-700-normal.woff2`, `public/fonts/OFL.txt`

**Interfaces:**
- Consumes: the `data-*` attributes from Task 1 on `<html>`.
- Produces: CSS selectors `:root[data-text="115|130|150"]`, `:root[data-contrast="high"]`, `:root[data-theme="light|dark"]`, `:root[data-font="dyslexia"]`, `:root[data-motion="on|off"]`.

- [ ] **Step 1: Write the CSS test helper**

Create `tests/helpers/css.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const readCss = () => fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

/** Body of the first rule written exactly as `<selector> {` (balanced braces). */
export function blockBody(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  let i = css.indexOf('{', start) + 1;
  const from = i;
  let depth = 1;
  while (depth && i < css.length) {
    const c = css[i++];
    if (c === '{') depth++; else if (c === '}') depth--;
  }
  return css.slice(from, i - 1);
}

/** Custom-property declarations of a rule body as a Map. */
export function parseTokens(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const channel = (hex, i) => {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
```

- [ ] **Step 2: Write the failing CSS tests**

Create `tests/css-a11y.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCss, blockBody, parseTokens, contrast } from './helpers/css.js';

const css = readCss();

test('no font-size is declared in px, so text scales with the root size', () => {
  const offenders = css.match(/font-size:\s*[\d.]+px/g) || [];
  assert.deepEqual(offenders, []);
});

test('root text sizes exist for 115, 130 and 150 percent', () => {
  for (const n of ['115', '130', '150']) {
    assert.match(blockBody(css, `:root[data-text="${n}"]`), new RegExp(`font-size:\\s*${n}%`));
  }
});

test('manual dark theme mirrors the system dark theme token for token', () => {
  const system = parseTokens(blockBody(css, ':root:not([data-theme="light"])'));
  const manual = parseTokens(blockBody(css, ':root[data-theme="dark"]'));
  assert.ok(system.size > 20, 'system dark block should define many tokens');
  assert.deepEqual([...manual], [...system]);
});

const TEXT_TOKENS = ['--text', '--text-2', '--text-3', '--accent', '--pos-text', '--neg-text', '--warn-text', '--sub-text'];
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3'];

const HIGH = {
  light: ':root[data-contrast="high"]',
  'dark (system)': ':root[data-contrast="high"]:not([data-theme="light"])',
  'dark (manual)': ':root[data-contrast="high"][data-theme="dark"]',
};

for (const [name, selector] of Object.entries(HIGH)) {
  test(`high contrast ${name}: every text token reaches 7:1 on every surface`, () => {
    const tokens = parseTokens(blockBody(css, selector));
    const failures = [];
    for (const t of TEXT_TOKENS) for (const s of SURFACES) {
      const ratio = contrast(tokens.get(t), tokens.get(s));
      if (ratio < 7) failures.push(`${t} on ${s}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('high contrast dark blocks are identical (system and manual)', () => {
  assert.deepEqual(
    [...parseTokens(blockBody(css, HIGH['dark (manual)']))],
    [...parseTokens(blockBody(css, HIGH['dark (system)']))],
  );
});

test('motion off and system reduced motion both disable animation', () => {
  assert.match(css, /:root\[data-motion="off"\]\s*\*/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*:root:not\(\[data-motion="on"\]\)/);
});

test('dyslexia font is self-hosted', () => {
  assert.match(css, /@font-face\s*\{[^}]*fonts\/atkinson-hyperlegible-latin-400-normal\.woff2/);
  assert.doesNotMatch(css, /https?:\/\//);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test tests/css-a11y.test.js`
Expected: FAIL (px font sizes found, selectors not found).

- [ ] **Step 4: Capture "before" screenshots to prove the default look does not change**

```bash
mkdir -p /tmp/a11y-before && node --disable-warning=ExperimentalWarning scripts/screenshots.mjs && cp docs/screenshots/*.png /tmp/a11y-before/
```
Expected: seven `✓` lines.

- [ ] **Step 5: Convert every `font-size` from px to rem (same visual size)**

```bash
node -e "
const fs=require('fs');
let css=fs.readFileSync('public/styles.css','utf8');
let n=0;
css=css.replace(/font-size:\s*([\d.]+)px/g,(m,px)=>{n++;const rem=Math.round(parseFloat(px)/16*10000)/10000;return 'font-size: '+rem+'rem';});
fs.writeFileSync('public/styles.css',css);
console.log('converted',n);"
```
Expected: `converted 75` (the count may be slightly different if styles changed; any number is fine as long as the test in Step 3 no longer finds px sizes).

- [ ] **Step 6: Add root text-size rules**

In `public/styles.css`, replace the line `html { -webkit-text-size-adjust: 100%; }` with:

```css
html { -webkit-text-size-adjust: 100%; font-size: 100%; }
:root[data-text="115"] { font-size: 115%; }
:root[data-text="130"] { font-size: 130%; }
:root[data-text="150"] { font-size: 150%; }
/* Large text: stack two-column cards so nothing is squeezed. */
:root[data-text="130"] .span-8, :root[data-text="130"] .span-4,
:root[data-text="150"] .span-8, :root[data-text="150"] .span-4 { grid-column: span 12; }
```

- [ ] **Step 7: Make dark mode switchable (system block + manual mirror)**

```bash
node -e "
const fs=require('fs');
let css=fs.readFileSync('public/styles.css','utf8');
const head='@media (prefers-color-scheme: dark) {\n  :root {\n';
const i=css.indexOf(head);
if(i<0) throw new Error('system dark block not found');
// find the end of the inner :root rule
let j=i+head.length, depth=1;
while(depth){const c=css[j++]; if(c==='{')depth++; else if(c==='}')depth--;}
const body=css.slice(i+head.length, j-1);                 // declarations of the :root rule
const afterMedia=css.indexOf('\n}\n', j)+3;               // end of the @media block
css=css.slice(0,i)+'@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n'+body+'  }\n}\n\n/* Manual dark theme: must stay identical to the block above (tests/css-a11y.test.js). */\n:root[data-theme=\"dark\"] {\n'+body.replace(/^  /gm,'')+'}\n'+css.slice(afterMedia);
fs.writeFileSync('public/styles.css',css);"
sed -n '/prefers-color-scheme: dark/,+3p' public/styles.css | head -8
```
Expected: the first lines show `:root:not([data-theme="light"]) {`, and a `:root[data-theme="dark"] {` rule exists below the media block. Then add `color-scheme: light;` to a new rule so forced themes also style form controls:

```css
:root[data-theme="light"] { color-scheme: light; }
```
(`color-scheme: dark;` is already inside the dark token body.) Run `git diff --stat public/styles.css` and read the diff once: only the selector line and the copied block should differ in that area.

- [ ] **Step 8: Mirror the dark avatar colours for the manual theme**

Find the second `@media (prefers-color-scheme: dark)` block (the one containing `.txn-avatar[data-src="hapoalim"]`). Replace it with:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .txn-avatar[data-src="hapoalim"] { color: #ff8787; }
  :root:not([data-theme="light"]) .txn-avatar[data-src="isracard"] { color: #74c0fc; }
  :root:not([data-theme="light"]) .txn-avatar[data-src="visaCal"] { color: #63e6be; }
  :root:not([data-theme="light"]) .txn-avatar[data-src="max"] { color: #b197fc; }
}
:root[data-theme="dark"] .txn-avatar[data-src="hapoalim"] { color: #ff8787; }
:root[data-theme="dark"] .txn-avatar[data-src="isracard"] { color: #74c0fc; }
:root[data-theme="dark"] .txn-avatar[data-src="visaCal"] { color: #63e6be; }
:root[data-theme="dark"] .txn-avatar[data-src="max"] { color: #b197fc; }
```
(Keep any other rules that were inside the old media block; copy them in both forms the same way.)

- [ ] **Step 9: Add the high-contrast palettes**

Append to `public/styles.css`:

```css
/* ---------- high contrast (WCAG AAA, 7:1) ---------- */
:root[data-contrast="high"] {
  --bg: #ffffff; --surface: #ffffff; --surface-2: #f2f3f5; --surface-3: #e4e6ea;
  --border: #4b5563; --border-strong: #1f2937;
  --text: #000000; --text-2: #1f2937; --text-3: #374151;
  --accent: #312e81; --accent-strong: #1e1b4b; --accent-soft: #e0e7ff; --accent-contrast: #ffffff;
  --pos: #065f46; --pos-text: #064e3b;
  --neg: #991b1b; --neg-text: #7f1d1d;
  --warn: #92400e; --warn-text: #5b2c06;
  --sub-text: #831843;
  --muted-line: #4b5563; --grid: rgba(0, 0, 0, 0.25); --tick: #1f2937;
}
@media (prefers-color-scheme: dark) {
  :root[data-contrast="high"]:not([data-theme="light"]) {
    --bg: #000000; --surface: #0a0a0a; --surface-2: #141414; --surface-3: #1f1f1f;
    --border: #9ca3af; --border-strong: #e5e7eb;
    --text: #ffffff; --text-2: #e5e7eb; --text-3: #d1d5db;
    --accent: #c7d2fe; --accent-strong: #e0e7ff; --accent-soft: rgba(199, 210, 254, 0.18); --accent-contrast: #000000;
    --pos: #6ee7b7; --pos-text: #6ee7b7;
    --neg: #fca5a5; --neg-text: #fca5a5;
    --warn: #fde68a; --warn-text: #fde68a;
    --sub-text: #f9a8d4;
    --muted-line: #9ca3af; --grid: rgba(255, 255, 255, 0.3); --tick: #e5e7eb;
  }
}
:root[data-contrast="high"][data-theme="dark"] {
  --bg: #000000; --surface: #0a0a0a; --surface-2: #141414; --surface-3: #1f1f1f;
  --border: #9ca3af; --border-strong: #e5e7eb;
  --text: #ffffff; --text-2: #e5e7eb; --text-3: #d1d5db;
  --accent: #c7d2fe; --accent-strong: #e0e7ff; --accent-soft: rgba(199, 210, 254, 0.18); --accent-contrast: #000000;
  --pos: #6ee7b7; --pos-text: #6ee7b7;
  --neg: #fca5a5; --neg-text: #fca5a5;
  --warn: #fde68a; --warn-text: #fde68a;
  --sub-text: #f9a8d4;
  --muted-line: #9ca3af; --grid: rgba(255, 255, 255, 0.3); --tick: #e5e7eb;
}
:root[data-contrast="high"] :focus-visible { outline-width: 3px; outline-offset: 3px; }
:root[data-contrast="high"] .card, :root[data-contrast="high"] .kpi,
:root[data-contrast="high"] .insight-metric { border: 2px solid var(--border); box-shadow: none; }
```

- [ ] **Step 10: Add the dyslexia font and spacing**

Self-host the font (one-time download; it is not added as a project dependency):

```bash
mkdir -p /tmp/fontpack public/fonts && cd /tmp/fontpack && npm pack @fontsource/atkinson-hyperlegible >/dev/null && tar xzf fontsource-atkinson-hyperlegible-*.tgz && cd - >/dev/null
cp /tmp/fontpack/package/files/atkinson-hyperlegible-latin-400-normal.woff2 /tmp/fontpack/package/files/atkinson-hyperlegible-latin-700-normal.woff2 public/fonts/
cp /tmp/fontpack/package/LICENSE public/fonts/OFL.txt
ls -l public/fonts
```
Expected: two `.woff2` files and `OFL.txt`. If `npm pack` cannot find the package or the files are missing, stop and report; do not substitute a CDN.

Append to `public/styles.css`:

```css
/* ---------- dyslexia-friendly font and spacing (Atkinson Hyperlegible, OFL) ---------- */
@font-face {
  font-family: "Atkinson Hyperlegible"; font-weight: 400; font-style: normal; font-display: swap;
  src: url("fonts/atkinson-hyperlegible-latin-400-normal.woff2") format("woff2");
}
@font-face {
  font-family: "Atkinson Hyperlegible"; font-weight: 700; font-style: normal; font-display: swap;
  src: url("fonts/atkinson-hyperlegible-latin-700-normal.woff2") format("woff2");
}
:root[data-font="dyslexia"] { --font: "Atkinson Hyperlegible", "Heebo", "Assistant", "Rubik", system-ui, -apple-system, "Segoe UI", "Arial Hebrew", Arial, sans-serif; }
:root[data-font="dyslexia"] body { line-height: 1.8; letter-spacing: 0.02em; word-spacing: 0.08em; }
```

- [ ] **Step 11: Replace the reduced-motion block with attribute-aware rules**

Replace this existing block:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```
with:

```css
/* Motion: "system" follows the device, "off" always stops animation, "on" overrides the device. */
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion="on"]) *, :root:not([data-motion="on"]) *::before, :root:not([data-motion="on"]) *::after {
    animation: none !important; transition: none !important;
  }
}
:root[data-motion="off"] *, :root[data-motion="off"] *::before, :root[data-motion="off"] *::after {
  animation: none !important; transition: none !important;
}
```

- [ ] **Step 12: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --test tests/css-a11y.test.js`
Expected: PASS, 9 tests. If a high-contrast test reports a ratio below 7, darken that token until it passes.

Run: `npm test`
Expected: all pass (the existing browser tests still pass; default colours are unchanged).

- [ ] **Step 13: Prove the default look is unchanged**

```bash
node --disable-warning=ExperimentalWarning scripts/screenshots.mjs
for f in /tmp/a11y-before/*.png; do cmp "$f" "docs/screenshots/$(basename "$f")" && echo "same: $(basename "$f")"; done
```
Expected: `same:` for all seven images. If any differ, open both with the Read tool and find the cause before continuing (a 1px layout shift from rounding means a conversion error). Then restore the committed screenshots: `git checkout docs/screenshots`.

- [ ] **Step 14: Commit**

```bash
git add public/styles.css public/fonts tests/helpers/css.js tests/css-a11y.test.js
git commit -m "feat(a11y): rem text scaling, manual themes, high contrast, dyslexia font, motion switches" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UrKkXFXAGtpfQyroaWdvfw"
```

---

### Task 3: Panel UI, wiring and translations

**Files:**
- Create: `public/a11y-panel.js`
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`, `public/locales/en.json`, `public/locales/he.json`, `public/sw.js`
- Test: `tests/a11y-panel.test.js` (browser, created here, extended in Task 5)

**Interfaces:**
- Consumes: `window.A11Y` (Task 1). From `app.js`: `window.DashBankUI = { el, t, toast, openSheet(renderBody, returnFocusEl), closeSheet() }` (added in Step 3 below). `renderBody` is a function that fills `#sheet-body` and must include an element with `id="sheet-title"`.
- Produces: `a11y:change` CustomEvent on `document` with `detail: settings` after any settings change; `<button id="a11y-btn">` in the header.

- [ ] **Step 1: Write the failing browser test**

Create `tests/a11y-panel.test.js`:

```js
// Browser tests for the display and accessibility panel. Skipped when Playwright or Chromium is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/demo.js';
import { createApp } from '../src/server.js';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not resolvable as ESM */ }
  try { return createRequire(import.meta.url)('playwright'); } catch { /* honours NODE_PATH */ }
  return null;
}

let pw = null; let browser = null; let server = null; let db = null; let base = ''; let skip = '';

before(async () => {
  pw = await loadPlaywright();
  if (!pw) { skip = 'playwright not installed'; return; }
  try { browser = await pw.chromium.launch(); } catch (e) { skip = `chromium unavailable: ${e.message.split('\n')[0]}`; return; }
  db = openDb(':memory:');
  seedDemo(db);
  server = createApp({ db, config: { demo: true } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  db?.close();
});

async function openPage({ width = 1280, mobile = false, colorScheme = 'light', reducedMotion = 'no-preference', stored = null } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 }, colorScheme, reducedMotion,
    isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
  });
  await ctx.addInitScript(([lang, s]) => {
    try { localStorage.setItem('dashbank.lang', lang); if (s) localStorage.setItem('dashbank.a11y', s); } catch { /* ignore */ }
  }, ['en', stored]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('.txn-row', { state: 'attached' });
  return { page, ctx, errors };
}

const attr = (page, name) => page.evaluate((n) => document.documentElement.getAttribute(n), name);

test('saved settings are applied before the app renders', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage({ stored: JSON.stringify({ text: '130', theme: 'dark', contrast: 'high' }) });
  assert.equal(await attr(page, 'data-text'), '130');
  assert.equal(await attr(page, 'data-theme'), 'dark');
  assert.equal(await attr(page, 'data-contrast'), 'high');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '20.8px');
  await ctx.close();
});

test('gear button opens the panel as a dialog, and Escape closes it and returns focus', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx, errors } = await openPage();
  await page.click('#a11y-btn');
  await page.waitForSelector('#sheet:not([hidden]) #a11y-panel');
  assert.equal(await page.getAttribute('#sheet', 'role'), 'dialog');
  assert.match(await page.textContent('#sheet-title'), /Display/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'a11y-btn');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('each control changes its attribute and persists across a reload', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage();
  await page.click('#a11y-btn');
  await page.check('input[name="a11y-text"][value="150"]');
  await page.check('input[name="a11y-theme"][value="dark"]');
  await page.check('input[name="a11y-motion"][value="off"]');
  await page.check('#a11y-contrast');
  await page.check('#a11y-font');
  assert.equal(await attr(page, 'data-text'), '150');
  assert.equal(await attr(page, 'data-theme'), 'dark');
  assert.equal(await attr(page, 'data-motion'), 'off');
  assert.equal(await attr(page, 'data-contrast'), 'high');
  assert.equal(await attr(page, 'data-font'), 'dyslexia');
  await page.reload();
  await page.waitForSelector('.txn-row', { state: 'attached' });
  assert.equal(await attr(page, 'data-text'), '150');
  assert.equal(await attr(page, 'data-contrast'), 'high');
  await ctx.close();
});

test('reset restores defaults', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage({ stored: JSON.stringify({ text: '150', contrast: 'high' }) });
  await page.click('#a11y-btn');
  await page.click('#a11y-reset');
  assert.equal(await attr(page, 'data-text'), '100');
  assert.equal(await attr(page, 'data-contrast'), 'normal');
  await ctx.close();
});

test('changing a setting is announced in a live region', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage();
  await page.click('#a11y-btn');
  await page.check('input[name="a11y-text"][value="115"]');
  await page.waitForFunction(() => /updated/i.test(document.querySelector('#a11y-status')?.textContent || ''));
  assert.equal(await page.getAttribute('#a11y-status', 'aria-live'), 'polite');
  await ctx.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test tests/a11y-panel.test.js`
Expected: FAIL (no `#a11y-btn`). If Playwright is missing the tests are skipped; in this environment it is installed, so a failure is expected.

- [ ] **Step 3: Expose sheet helpers and make motion/theme changes live in `public/app.js`**

3a. Replace line 9:
```js
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```
with:
```js
  // Live check: honours the in-app motion setting (on / off / system) and the device preference.
  const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isReducedMotion = () => A11Y.isMotionOff(A11Y.load(localStorage), systemReduced.matches);
```
3b. Replace each remaining use of `reducedMotion` (4 places) with `isReducedMotion()`:
- `if (reducedMotion || from === to)` → `if (isReducedMotion() || from === to)`
- `animation: reducedMotion ? false : { duration: 600, easing: 'easeOutCubic' },` → `animation: isReducedMotion() ? false : { duration: 600, easing: 'easeOutCubic' },`
- `behavior: reducedMotion ? 'auto' : 'smooth'` → `behavior: isReducedMotion() ? 'auto' : 'smooth'`
- `if (instant || reducedMotion) return;` → `if (instant || isReducedMotion()) return;`
- `if (reducedMotion) done(); else setTimeout(done, 380);` → `if (isReducedMotion()) done(); else setTimeout(done, 380);`

3c. Generalise the sheet. Replace `function openSheet(tx, from) { sheet.txn = tx; renderSheetBody(tx);` with:
```js
  function openSheet(tx, from) {
    sheet.txn = tx;
    openSheetWith(() => renderSheetBody(tx), from);
  }

  // Opens the shared bottom sheet with any content. renderBody must fill #sheet-body and include #sheet-title.
  function openSheetWith(renderBody, from) {
    renderBody();
```
and keep the rest of the old function body (from `sheet.returnFocus = from || document.activeElement;` onward) as the remainder of `openSheetWith`.

3d. Just before the final `I18N.ready.then(() => {` add:
```js
  window.DashBankUI = { el, t, toast, openSheet: openSheetWith, closeSheet };

  // Re-colour charts when the user changes theme, contrast or text size.
  document.addEventListener('a11y:change', () => { if (state.overview) renderCharts(state.overview); });
  new MutationObserver(() => { if (state.overview) renderCharts(state.overview); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-contrast', 'data-text'] });
```
(The observer covers settings applied outside the panel; the event covers the panel. Rendering twice is harmless.)

3e. Scale chart text with the root size. In `renderCharts(o)` add as the first line after the `if (!window.Chart) return;` guard:
```js
    Chart.defaults.font.size = 12 * (parseFloat(getComputedStyle(document.documentElement).fontSize) / 16);
```

- [ ] **Step 4: Add the translations**

Add to `public/locales/en.json` a new top-level group:
```json
"a11y": {
  "open": "Display and accessibility settings",
  "title": "Display & accessibility",
  "text_size": "Text size",
  "contrast": "High contrast",
  "contrast_hint": "Stronger text and borders",
  "theme": "Theme",
  "theme_system": "System",
  "theme_light": "Light",
  "theme_dark": "Dark",
  "font": "Dyslexia-friendly font and spacing",
  "font_hint": "Rounded letters and wider spacing",
  "motion": "Animations",
  "motion_system": "System",
  "motion_on": "On",
  "motion_off": "Off",
  "reset": "Reset to defaults",
  "updated": "Settings updated",
  "reset_done": "Settings reset to defaults",
  "not_saved": "This browser can't save settings. They apply until you close the page."
}
```
and to `public/locales/he.json`:
```json
"a11y": {
  "open": "הגדרות תצוגה ונגישות",
  "title": "תצוגה ונגישות",
  "text_size": "גודל טקסט",
  "contrast": "ניגודיות גבוהה",
  "contrast_hint": "טקסט וקווים מודגשים יותר",
  "theme": "ערכת נושא",
  "theme_system": "לפי המכשיר",
  "theme_light": "בהיר",
  "theme_dark": "כהה",
  "font": "גופן ומרווחים ידידותיים לדיסלקציה",
  "font_hint": "אותיות עגולות ומרווחים רחבים",
  "motion": "אנימציות",
  "motion_system": "לפי המכשיר",
  "motion_on": "פעיל",
  "motion_off": "כבוי",
  "reset": "איפוס לברירת מחדל",
  "updated": "ההגדרות עודכנו",
  "reset_done": "ההגדרות אופסו",
  "not_saved": "הדפדפן לא מאפשר לשמור הגדרות. הן יחולו עד לסגירת הדף."
}
```
(Insert each group before the final closing brace, keeping valid JSON: validate with `node -e "JSON.parse(require('fs').readFileSync('public/locales/en.json','utf8'))"` for both files.)

- [ ] **Step 5: Add the gear button and script tags in `public/index.html`**

Add `<script src="a11y-settings.js"></script>` as the first script tag in `<head>`, right before `<script src="i18n.js"></script>` (so settings apply before first paint). Add `<script src="a11y-panel.js" defer></script>` right after `<script src="app.js" defer></script>`. Add the gear button inside `<div class="sync">`, after the `#lang-btn` button:

```html
        <button class="icon-btn" id="a11y-btn" type="button" aria-haspopup="dialog" aria-label="הגדרות תצוגה ונגישות" data-i18n-label="a11y.open" data-i18n-title="a11y.open" title="הגדרות תצוגה ונגישות">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></svg>
        </button>
```

- [ ] **Step 6: Write the panel**

Create `public/a11y-panel.js`:

```js
// Display and accessibility panel. Rendered into the shared bottom sheet exposed by app.js.
(function () {
  'use strict';

  const SIZES = ['100', '115', '130', '150'];
  let settings = A11Y.load(localStorage);

  function commit(next, messageKey) {
    settings = A11Y.normalise(next);
    A11Y.apply(document.documentElement, settings);
    const saved = A11Y.save(localStorage, settings);
    document.dispatchEvent(new CustomEvent('a11y:change', { detail: settings }));
    const status = document.getElementById('a11y-status');
    if (status) status.textContent = DashBankUI.t(saved ? messageKey : 'a11y.not_saved');
  }

  function radioGroup({ name, legend, options }) {
    const { el, t } = DashBankUI;
    return el('fieldset', { class: 'a11y-group' }, [
      el('legend', { text: legend }),
      el('div', { class: 'a11y-segmented' }, options.map(({ value, label }) => {
        const id = `a11y-${name}-${value}`;
        return el('span', { class: 'a11y-option' }, [
          el('input', {
            type: 'radio', id, name: `a11y-${name}`, value, checked: settings[name] === value,
            onchange: () => commit({ ...settings, [name]: value }, 'a11y.updated'),
          }),
          el('label', { for: id, text: label }),
        ]);
      })),
    ]);
  }

  function switchRow({ id, key, label, hint, on, off }) {
    const { el } = DashBankUI;
    return el('div', { class: 'a11y-switch' }, [
      el('div', {}, [
        el('label', { for: id, text: label }),
        el('span', { class: 'a11y-hint', id: `${id}-hint`, text: hint }),
      ]),
      el('input', {
        type: 'checkbox', role: 'switch', id, 'aria-describedby': `${id}-hint`, checked: settings[key] === on,
        onchange: (e) => commit({ ...settings, [key]: e.target.checked ? on : off }, 'a11y.updated'),
      }),
    ]);
  }

  function renderBody() {
    const { el, t } = DashBankUI;
    settings = A11Y.load(localStorage);
    document.getElementById('sheet-body').replaceChildren(
      el('div', { id: 'a11y-panel' }, [
        el('h2', { id: 'sheet-title', class: 'sheet-title', text: t('a11y.title') }),
        radioGroup({ name: 'text', legend: t('a11y.text_size'), options: SIZES.map((n) => ({ value: n, label: `${n}%` })) }),
        radioGroup({
          name: 'theme', legend: t('a11y.theme'),
          options: [
            { value: 'system', label: t('a11y.theme_system') },
            { value: 'light', label: t('a11y.theme_light') },
            { value: 'dark', label: t('a11y.theme_dark') },
          ],
        }),
        switchRow({ id: 'a11y-contrast', key: 'contrast', label: t('a11y.contrast'), hint: t('a11y.contrast_hint'), on: 'high', off: 'normal' }),
        switchRow({ id: 'a11y-font', key: 'font', label: t('a11y.font'), hint: t('a11y.font_hint'), on: 'dyslexia', off: 'default' }),
        radioGroup({
          name: 'motion', legend: t('a11y.motion'),
          options: [
            { value: 'system', label: t('a11y.motion_system') },
            { value: 'on', label: t('a11y.motion_on') },
            { value: 'off', label: t('a11y.motion_off') },
          ],
        }),
        el('p', { id: 'a11y-status', class: 'sr-only', role: 'status', 'aria-live': 'polite' }),
        el('div', { class: 'sheet-actions' }, [
          el('button', {
            type: 'button', class: 'btn btn-ghost', id: 'a11y-reset',
            onclick: () => { commit(A11Y.DEFAULTS, 'a11y.reset_done'); renderBody(); document.getElementById('a11y-status').textContent = t('a11y.reset_done'); },
            text: t('a11y.reset'),
          }),
        ]),
      ]),
    );
  }

  function init() {
    const btn = document.getElementById('a11y-btn');
    if (!btn || !window.DashBankUI) return;
    btn.addEventListener('click', () => DashBankUI.openSheet(renderBody, btn));
    // Re-render the open panel in the new language.
    document.addEventListener('i18n:change', () => {
      if (document.getElementById('a11y-panel')) renderBody();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
```

- [ ] **Step 7: Style the panel**

Append to `public/styles.css`:

```css
/* ---------- display and accessibility panel ---------- */
#a11y-panel { display: grid; gap: 18px; padding-bottom: 8px; }
.a11y-group { border: 0; margin: 0; padding: 0; min-width: 0; }
.a11y-group legend { font-weight: 650; padding: 0; margin-bottom: 8px; }
.a11y-segmented { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: var(--surface-3); }
.a11y-option { flex: 1; position: relative; }
.a11y-option input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.a11y-option label {
  display: grid; place-items: center; min-height: 44px; padding: 6px 8px; border-radius: 9px;
  text-align: center; font-size: 0.875rem; font-weight: 600; color: var(--text-2);
  transition: background .2s var(--ease), color .2s var(--ease);
}
.a11y-option input:checked + label { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.a11y-option input:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 2px; }
.a11y-switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 44px; }
.a11y-switch label { font-weight: 650; display: block; }
.a11y-hint { display: block; font-size: 0.8125rem; color: var(--text-3); }
.a11y-switch input[type="checkbox"] {
  appearance: none; flex: none; width: 52px; height: 32px; border-radius: 16px; position: relative; cursor: pointer;
  background: var(--border-strong); transition: background .2s var(--ease);
}
.a11y-switch input[type="checkbox"]::after {
  content: ""; position: absolute; top: 3px; inset-inline-start: 3px; width: 26px; height: 26px; border-radius: 50%;
  background: var(--surface); box-shadow: var(--shadow); transition: transform .25s var(--ease);
}
.a11y-switch input[type="checkbox"]:checked { background: var(--accent); }
.a11y-switch input[type="checkbox"]:checked::after { transform: translateX(20px); }
[dir="rtl"] .a11y-switch input[type="checkbox"]:checked::after { transform: translateX(-20px); }
```

- [ ] **Step 8: Precache the new files and bump the service worker version**

In `public/sw.js`: change `const VERSION = 'v5';` to `const VERSION = 'v6';`, and add `'a11y-settings.js', 'a11y-panel.js', 'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',` to the `SHELL` array.

- [ ] **Step 9: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --test tests/a11y-panel.test.js`
Expected: PASS, 5 tests.

Run: `npm test`
Expected: all pass, including the i18n parity test (new `a11y.*` keys exist in both locales) and the existing browser a11y suite.

- [ ] **Step 10: Look at it**

Take screenshots of the open panel and of the dashboard with text 150%, high contrast and dark theme at 390px and 1440px (use the Playwright snippet pattern from `scripts/screenshots.mjs` with `localStorage` pre-set to `{"text":"150","contrast":"high","theme":"dark"}`). Read each image and confirm: no clipped text, no horizontal scrollbar, panel readable, focus ring visible. Fix any layout issue before committing.

- [ ] **Step 11: Commit**

```bash
git add public tests/a11y-panel.test.js
git commit -m "feat(a11y): display and accessibility panel with live settings" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UrKkXFXAGtpfQyroaWdvfw"
```

---

### Task 4: Motion upgrades and tooltips

**Files:**
- Modify: `public/app.js`, `public/styles.css`, `public/index.html`
- Test: `tests/a11y-panel.test.js` (append)

**Interfaces:**
- Consumes: `isReducedMotion()` from Task 3, `TABS`, `setTab`, `animateValue`, `goToMonth`.
- Produces: `html[data-tab-dir="1|-1"]` set during tab transitions; `body.month-swap` class briefly set on month change.

- [ ] **Step 1: Write the failing tests (append to `tests/a11y-panel.test.js`)**

```js
test('motion off: animations and transitions have zero duration', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage({ stored: JSON.stringify({ motion: 'off' }) });
  const durations = await page.evaluate(() => [...document.querySelectorAll('.card, .kpi, .tab, .btn, .icon-btn')]
    .map((n) => getComputedStyle(n)).map((s) => `${s.animationDuration}|${s.transitionDuration}`));
  assert.ok(durations.length > 0);
  assert.ok(durations.every((d) => d.split('|').every((v) => v.split(',').every((x) => parseFloat(x) === 0))), durations.join(' '));
  await ctx.close();
});

test('motion on overrides a device that asks for reduced motion', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage({ reducedMotion: 'reduce', stored: JSON.stringify({ motion: 'on' }) });
  const anyAnimated = await page.evaluate(() => [...document.querySelectorAll('.card, .tab, .btn')]
    .some((n) => { const s = getComputedStyle(n); return parseFloat(s.transitionDuration) > 0 || parseFloat(s.animationDuration) > 0; }));
  assert.equal(anyAnimated, true);
  await ctx.close();
});

test('icon-only buttons have a tooltip', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage();
  const missing = await page.evaluate(() => [...document.querySelectorAll('button.icon-btn')]
    .filter((b) => !b.closest('#sheet') && !b.getAttribute('title')).map((b) => b.id || b.className));
  assert.deepEqual(missing, []);
  await ctx.close();
});

test('switching tab on a phone sets a direction for the transition', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage({ mobile: true, width: 390 });
  await page.click('#tabbar .tab[data-tab="txns"]');
  const dir = await page.evaluate(() => document.documentElement.getAttribute('data-tab-dir'));
  assert.ok(['1', '-1'].includes(dir), `data-tab-dir was ${dir}`);
  await ctx.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test tests/a11y-panel.test.js`
Expected: FAIL (tooltips missing, no `data-tab-dir`). The two motion tests may already pass; that is fine.

- [ ] **Step 3: Tooltips for icon-only buttons**

In `public/index.html`, add a `title` and `data-i18n-title` to each `button.icon-btn` outside the sheet, reusing the keys of its existing `data-i18n-label` (month prev/next, any others). Example for the month buttons:
```html
<button class="icon-btn" id="month-prev" type="button" aria-label="החודש הקודם" data-i18n-label="month.prev" title="החודש הקודם" data-i18n-title="month.prev">
```
Repeat for every `icon-btn` the test lists as missing (the failing test prints their ids).

- [ ] **Step 4: Directional tab transition**

In `public/app.js` `setTab`, replace the block that starts at `if (!changed || !isMobile()) return;` with:

```js
    if (!changed || !isMobile()) return;
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (instant || isReducedMotion()) return;
    // Slide in the direction of the tab (mirrored in RTL), via View Transitions when the browser has them.
    const dir = (TABS.indexOf(tab) > TABS.indexOf(previous) ? 1 : -1) * (I18N.dir === 'rtl' ? -1 : 1);
    document.documentElement.setAttribute('data-tab-dir', String(dir));
    const page = $('page');
    page.classList.remove('tab-in');
    void page.offsetWidth;
    page.classList.add('tab-in');
```
and capture the previous tab at the top of `setTab`: after `const changed = ...` add `const previous = document.body.dataset.tab || 'overview';` placed **before** `document.body.dataset.tab = tab;` (move the `changed` line accordingly so `previous` is read before the assignment).

In `public/styles.css` replace the rule `.page.tab-in .kpis, .page.tab-in .card, .page.tab-in .large-title { animation: rise-in .32s var(--ease) both; }` with:

```css
@keyframes slide-in { from { opacity: 0; transform: translate3d(calc(var(--tab-dir, 1) * 28px), 0, 0); } }
html[data-tab-dir] { --tab-dir: 1; }
html[data-tab-dir="-1"] { --tab-dir: -1; }
.page.tab-in .kpis, .page.tab-in .card, .page.tab-in .large-title { animation: slide-in .34s var(--ease) both; animation-delay: calc(var(--i, 0) * 30ms); }
```

- [ ] **Step 5: Month change replays the entrance**

In `public/app.js` find `goToMonth(`; at the start of the function body add:
```js
    if (!isReducedMotion()) {
      document.body.classList.remove('intro');
      void document.body.offsetWidth;
      document.body.classList.add('intro');
    }
```
(`body.intro .kpi, body.intro .card` already animate with a stagger.)

- [ ] **Step 6: Count-up for the Insights numbers**

In `renderInsights`, give the average-daily and projected metrics a numeric node that uses `animateValue`: change the two `metric(...)` calls for `avg_daily` and `projected` so that after the `$('insight-metrics').replaceChildren(...)` call you run:
```js
    const animate = (index, to) => {
      const node = $('insight-metrics').children[index]?.querySelector('.insight-value');
      if (node && to != null) animateValue(node, to, ils);
    };
    animate(1, ins.avgDailySpend);
    animate(2, ins.projectedSpend);
```

- [ ] **Step 7: Run the tests and look at it**

Run: `node --disable-warning=ExperimentalWarning --test tests/a11y-panel.test.js` → PASS.
Run: `npm test` → all pass.
Record a short check in the browser: open `npm run demo`, switch tabs on a 390px viewport, change month, and confirm the slide direction mirrors in Hebrew vs English and that turning motion off in the panel stops all movement. Note anything off before committing.

- [ ] **Step 8: Bump the service worker and commit**

Change `const VERSION = 'v6';` to `'v7'` in `public/sw.js`, then:
```bash
npm test
git add public tests/a11y-panel.test.js
git commit -m "feat(ui): directional tab transitions, month entrance replay, tooltips, animated insights" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UrKkXFXAGtpfQyroaWdvfw"
```

---

### Task 5: Layout checks, screenshots, README, final verification

**Files:**
- Modify: `tests/a11y-panel.test.js`, `README.md`, `docs/screenshots/*` (regenerated), `scripts/screenshots.mjs` (add panel shot)
- Test: `tests/a11y-panel.test.js`

- [ ] **Step 1: Add layout-safety tests (append to `tests/a11y-panel.test.js`)**

```js
for (const [width, mobile] of [[390, true], [1280, false]]) {
  test(`largest text and high contrast cause no horizontal overflow at ${width}px`, async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await openPage({ width, mobile, stored: JSON.stringify({ text: '150', contrast: 'high', font: 'dyslexia' }) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px`);
    await ctx.close();
  });
}

test('panel controls are at least 44px tall and keyboard operable', async (t) => {
  if (skip) return t.skip(skip);
  const { page, ctx } = await openPage({ mobile: true, width: 390 });
  await page.click('#a11y-btn');
  const small = await page.evaluate(() => [...document.querySelectorAll('#a11y-panel .a11y-option label, #a11y-panel input[type="checkbox"], #a11y-reset')]
    .filter((n) => n.getBoundingClientRect().height < 44 && getComputedStyle(n).display !== 'none').map((n) => n.id || n.textContent));
  assert.deepEqual(small, []);
  await page.focus('input[name="a11y-text"]:checked');
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await attr(page, 'data-text'), '100');
  await ctx.close();
});
```

- [ ] **Step 2: Run, fix any real layout problem found, re-run**

Run: `node --disable-warning=ExperimentalWarning --test tests/a11y-panel.test.js`
Expected: PASS. If the 150% overflow test fails, find the offending element (`document.querySelectorAll('*')` with `getBoundingClientRect().right > innerWidth`), fix its CSS (for example `min-width: 0`, `overflow-wrap: anywhere`, or a smaller `gap`), and re-run until it passes.

- [ ] **Step 3: Add the panel to the screenshot script**

In `scripts/screenshots.mjs`, add after the `mobile-detail` shot:
```js
  await shot('mobile-accessibility', mobile, async (page) => { await page.click('#a11y-btn'); await page.waitForSelector('#a11y-panel'); });
  await shot('desktop-large-text-contrast', { ...desktop, colorScheme: 'dark' }, async (page) => {
    await page.evaluate(() => { localStorage.setItem('dashbank.a11y', JSON.stringify({ text: '130', contrast: 'high' })); });
    await page.reload(); await page.waitForTimeout(1200);
  });
```
Run `npm run screenshots` and open the two new images with the Read tool to confirm they look right.

- [ ] **Step 4: Update the README**

In `README.md`: add the two new screenshots to the Screenshots table; add a row to "Daily use": `| Change text size, contrast, theme, font or motion | Tap the ⚙ gear in the top bar. Settings are saved on that device only |`; and a new short section **Accessibility** listing the five controls and that settings are per device.

- [ ] **Step 5: Final verification (run these fresh, read the output)**

```bash
npm test
npm audit
node --disable-warning=ExperimentalWarning --test tests/a11y-settings.test.js tests/css-a11y.test.js tests/a11y-panel.test.js
git status --short
```
Expected: all tests pass with 0 failures, `found 0 vulnerabilities`, a clean tree except files you are about to commit. Do not claim completion without this output.

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -m "feat(a11y): layout checks, new screenshots, README accessibility section" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UrKkXFXAGtpfQyroaWdvfw"
git push -u origin claude/financial-tracking-dashboard-0lwfh3
```
Expected: push succeeds. Bump `VERSION` in `public/sw.js` again first if any `public/` file changed after the last bump.

---

## Self-Review

**Spec coverage:**
- Text size 4 steps, layout still fits → Task 2 (rem conversion, 130/150% stacking) + Task 5 (overflow tests).
- High contrast 7:1 → Task 2 Step 9 (palettes verified numerically before writing) + Task 2 tests.
- Theme system/light/dark → Task 2 Steps 7–8, Task 3 panel.
- Dyslexia font and spacing, self-hosted → Task 2 Step 10.
- Motion system/on/off, override both directions → Task 2 Step 11, Task 3 Step 3, Task 4 tests.
- Panel via gear button in a bottom sheet, live region, reset, per-device storage → Task 1, Task 3.
- Animations (tab slide, entrance replay, count-up, charts) → Task 4. Cards-in stagger and sheet easing already exist.
- UX fix 1 (month announcement) → already present; spec corrected in Global Constraints. UX fix 2 (tooltips) → Task 4 Step 3. UX fix 3 (theme switch) → Task 3.
- Testing: unit (Task 1), CSS (Task 2), browser (Tasks 3–5), screenshots (Tasks 2, 3, 5).

**Placeholder scan:** none; every code step contains the code. Two steps deliberately say "repeat for every icon button the test lists" because the list is produced by the failing test and the pattern is shown.

**Type consistency:** `A11Y.load/save/apply/normalise/isMotionOff/DEFAULTS` (Task 1) are used with the same names in Tasks 3 and 4. `DashBankUI.openSheet(renderBody, from)`, `.el`, `.t`, `.toast` (Task 3 Step 3d) match their use in `a11y-panel.js`. The `a11y:change` event and `data-tab-dir` attribute names match across tasks and tests.

**Known limitation (not in scope):** `<meta name="theme-color">` still follows the device colour scheme, so the phone status bar colour will not follow a forced light or dark theme.
