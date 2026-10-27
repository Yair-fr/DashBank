// Accessibility smoke tests (WCAG 2.1 AA essentials) against the demo dataset in a real browser.
// Playwright is not a package dependency: when it can't be loaded (e.g. CI), every test is skipped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/demo.js';
import { createApp } from '../src/server.js';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not resolvable as ESM */ }
  try { return createRequire(import.meta.url)('playwright'); } catch { /* honours NODE_PATH for global installs */ }
  return null;
}

let pw = null; let browser = null; let server = null; let db = null; let base = '';
let skipReason = '';

before(async () => {
  pw = await loadPlaywright();
  if (!pw) { skipReason = 'playwright not installed'; return; }
  try {
    browser = await pw.chromium.launch();
  } catch (err) {
    skipReason = `chromium unavailable: ${err.message.split('\n')[0]}`;
    return;
  }
  db = openDb(':memory:');
  seedDemo(db);
  const app = createApp({ db, config: { demo: true } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  db?.close();
});

async function openPage({ lang = 'he', width = 1280, colorScheme = 'light', mobile = false, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 }, colorScheme, reducedMotion,
    isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
  });
  await ctx.addInitScript((l) => { try { localStorage.setItem('dashbank.lang', l); } catch { /* ignore */ } }, lang);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  try {
    await page.waitForSelector('.txn-row', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#table-monthly tbody tr'));
  } catch (err) {
    const dump = await page.evaluate(() => ({ chart: typeof window.Chart, i18n: window.I18N?.lang, rows: document.querySelectorAll('.txn-row').length, kpis: document.querySelectorAll('.kpi-value').length, toast: document.getElementById('toast')?.textContent })).catch(() => null);
    await ctx.close();
    throw new Error(`page did not render: ${err.message.split('\n')[0]} ${JSON.stringify({ dump, errors })}`);
  }
  return { page, ctx, errors };
}

const guard = (t) => { if (!browser) { t.skip(skipReason); return true; } return false; };

// Lines of an ARIA snapshot for an interactive role with no accessible name.
function unnamed(snapshot) {
  return snapshot.split('\n').filter((l) => /^\s*- (button|link|textbox|searchbox|combobox|tab|radio|checkbox|img|dialog)(\s*\[[^\]]*\])*:?\s*$/.test(l));
}

for (const lang of ['he', 'en']) {
  for (const mobile of [false, true]) {
    test(`structure & names (${lang}, ${mobile ? 'phone' : 'desktop'})`, async (t) => {
      if (guard(t)) return;
      const { page, ctx, errors } = await openPage({ lang, mobile, width: mobile ? 390 : 1280 });
      try {
        const html = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir }));
        assert.deepEqual(html, lang === 'he' ? { lang: 'he', dir: 'rtl' } : { lang: 'en', dir: 'ltr' });

        assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, 'exactly one h1');
        for (const role of ['banner', 'main']) assert.ok(await page.getByRole(role).count() >= 1, `landmark ${role}`);
        // On phones the footer (legal links) lives on the Accounts tab.
        if (mobile) await page.click('#tab-accounts');
        assert.equal(await page.getByRole('contentinfo').count(), 1, 'landmark contentinfo');
        assert.equal(await page.getByRole('link', { name: lang === 'he' ? 'הצהרת נגישות' : 'Accessibility statement' }).count(), 1);
        assert.ok(await page.getByRole('navigation').count() >= 1, 'landmark navigation');

        const snap = await page.locator('body').ariaSnapshot();
        assert.deepEqual(unnamed(snap), [], 'every control has an accessible name');

        const imgs = await page.$$eval('img', (els) => els.filter((e) => !e.hasAttribute('alt')).map((e) => e.outerHTML));
        assert.deepEqual(imgs, [], 'all <img> have alt');

        const charts = await page.$$eval('canvas', (els) => els.map((e) => [e.getAttribute('role'), e.getAttribute('aria-label') || '']));
        for (const [role, label] of charts) { assert.equal(role, 'img'); assert.ok(label.length > 15, `chart summary: ${label}`); }
        for (const id of ['table-monthly', 'table-categories', 'table-daily']) {
          assert.ok(await page.$eval(`#${id}`, (e) => e.querySelectorAll('tbody tr').length > 0 && Boolean(e.querySelector('caption')?.textContent)), id);
        }
        assert.equal(await page.$eval('#sync-status', (e) => e.getAttribute('aria-live')), 'polite');
        assert.equal(await page.$eval('.toast-region', (e) => e.getAttribute('aria-live')), 'polite');
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });
  }
}

test('skip link is the first focusable element and moves focus to main', async (t) => {
  if (guard(t)) return;
  const { page, ctx } = await openPage();
  try {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(250); // slide-in transition
    const skip = await page.evaluate(() => {
      const a = document.activeElement;
      const r = a.getBoundingClientRect();
      return { cls: a.className, visible: r.top >= 0 && r.bottom <= innerHeight && r.width > 0 };
    });
    assert.equal(skip.cls, 'skip-link');
    assert.ok(skip.visible, 'skip link visible when focused');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'page');
  } finally { await ctx.close(); }
});

test('visible focus ring on keyboard focus', async (t) => {
  if (guard(t)) return;
  const { page, ctx } = await openPage();
  try {
    await page.focus('#month-prev');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    assert.notEqual(outline.style, 'none');
    assert.ok(outline.width >= 2);
  } finally { await ctx.close(); }
});

test('bottom sheet: focus moves in, Tab is trapped, Esc closes and restores focus', async (t) => {
  if (guard(t)) return;
  const { page, ctx } = await openPage();
  try {
    await page.focus('.txn-row');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#sheet.open');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sheet-close');
    assert.equal(await page.getByRole('dialog').count(), 1);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.getElementById('sheet').contains(document.activeElement)), 'focus stays in the dialog');
    }
    await page.keyboard.press('Shift+Tab');
    assert.ok(await page.evaluate(() => document.getElementById('sheet').contains(document.activeElement)));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('sheet').classList.contains('open'));
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('txn-row')), 'focus returns to the row');
  } finally { await ctx.close(); }
});

test('tabs: role=tablist with arrow-key navigation (RTL and LTR)', async (t) => {
  if (guard(t)) return;
  for (const [lang, nextKey] of [['he', 'ArrowLeft'], ['en', 'ArrowRight']]) {
    const { page, ctx } = await openPage({ lang, mobile: true, width: 390 });
    try {
      assert.equal(await page.getByRole('tablist').count(), 1);
      await page.focus('#tab-overview');
      await page.keyboard.press(nextKey);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-txns');
      assert.equal(await page.getAttribute('#tab-txns', 'aria-selected'), 'true');
      assert.equal(await page.getAttribute('#tab-overview', 'aria-selected'), 'false');
      assert.equal(await page.evaluate(() => document.body.dataset.tab), 'txns');
      await page.keyboard.press('End');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-accounts');
    } finally { await ctx.close(); }
  }
});

test('language switch flips lang/dir, translates the UI and persists', async (t) => {
  if (guard(t)) return;
  const { page, ctx } = await openPage({ lang: 'he' });
  try {
    await page.click('#lang-btn');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'ltr');
    await page.waitForFunction(() => document.querySelector('#txn-sub').textContent.includes('transactions'));
    assert.match(await page.textContent('h2[data-i18n="txns.title"]'), /Transactions/);
    assert.equal(await page.evaluate(() => localStorage.getItem('dashbank.lang')), 'en');
    const hebrewLeft = await page.evaluate(() => [...document.querySelectorAll('.kpi-label, .card-head h2, .tab span, .foot-links a')].filter((n) => /[\u0590-\u05FF]/.test(n.textContent)).length);
    assert.equal(hebrewLeft, 0);
  } finally { await ctx.close(); }
});

test('touch targets are at least 44px on a phone', async (t) => {
  if (guard(t)) return;
  const { page, ctx } = await openPage({ mobile: true, width: 390 });
  try {
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a[href], select, input')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('.sr-only') || el.classList.contains('skip-link')) continue;
        const after = getComputedStyle(el, '::after');
        const w = Math.max(r.width, after.content !== 'none' ? parseFloat(after.width) || 0 : 0);
        const h = Math.max(r.height, after.content !== 'none' ? parseFloat(after.height) || 0 : 0);
        // Inline text links and full-width rows are exempt or already large.
        if ((w < 44 || h < 44) && !el.matches('.txn-row, .cat-item') && !el.closest('label.search')) out.push(`${el.id || el.className || el.tagName} ${Math.round(w)}x${Math.round(h)}`);
      }
      return out;
    });
    assert.deepEqual(small, []);
  } finally { await ctx.close(); }
});

test('prefers-reduced-motion disables animation', async (t) => {
  if (guard(t)) return;
  const { page, ctx } = await openPage({ reducedMotion: 'reduce' });
  try {
    const anim = await page.$eval('.kpi', (e) => getComputedStyle(e).animationName);
    assert.equal(anim, 'none');
  } finally { await ctx.close(); }
});

// WCAG relative-luminance contrast, compositing translucent tokens over the card surface.
function parseColor(s) {
  s = s.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error(`unparsed colour ${s}`);
}
const over = (c, bg) => [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3]));
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TEXT_PAIRS = [
  ['--text', '--bg'], ['--text', '--surface'], ['--text-2', '--surface'], ['--text-2', '--surface-3'],
  ['--text-3', '--bg'], ['--text-3', '--surface'], ['--text-3', '--surface-2'], ['--text-3', '--surface-3'],
  ['--tick', '--surface'], ['--accent', '--surface'], ['--accent', '--accent-soft'], ['--accent-contrast', '--accent'],
  ['--pos-text', '--surface'], ['--pos-text', '--pos-soft'], ['--neg-text', '--surface'], ['--neg-text', '--neg-soft'],
  ['--warn-text', '--warn-soft'], ['--sub-text', '--surface'], ['--tooltip-text', '--tooltip-bg'],
];
const UI_PAIRS = [['--pos', '--surface'], ['--neg', '--surface'], ['--accent', '--surface'], ['--muted-line', '--surface']];

for (const colorScheme of ['light', 'dark']) {
  test(`contrast of key token pairs (${colorScheme})`, async (t) => {
    if (guard(t)) return;
    const { page, ctx } = await openPage({ colorScheme });
    try {
      const names = [...new Set([...TEXT_PAIRS, ...UI_PAIRS].flat())];
      const vars = await page.evaluate((list) => Object.fromEntries(list.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n)])), names);
      const surface = parseColor(vars['--surface']);
      const solid = (n) => over(parseColor(vars[n]), surface);
      const fails = [];
      for (const [fg, bg] of TEXT_PAIRS) { const r = ratio(solid(fg), solid(bg)); if (r < 4.5) fails.push(`${fg} on ${bg}: ${r.toFixed(2)}`); }
      for (const [fg, bg] of UI_PAIRS) { const r = ratio(solid(fg), solid(bg)); if (r < 3) fails.push(`${fg} on ${bg}: ${r.toFixed(2)} (UI)`); }
      assert.deepEqual(fails, []);
    } finally { await ctx.close(); }
  });
}

test('legal pages: lang/dir, one visible h1, contact placeholder filled', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('dashbank.lang', 'en'); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  try {
    for (const f of ['privacy', 'terms', 'accessibility']) {
      await page.goto(`${base}legal/${f}.html`);
      await page.waitForFunction(() => document.querySelector('[data-legal-lang="he"]').hidden);
      assert.equal(await page.evaluate(() => `${document.documentElement.lang}/${document.documentElement.dir}`), 'en/ltr');
      assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
      assert.deepEqual(unnamed(await page.locator('body').ariaSnapshot()), []);
    }
    await page.waitForFunction(() => document.querySelector('[data-legal-lang="en"] [data-a11y-contact]').textContent.length > 0);
    assert.equal(await page.textContent('[data-legal-lang="en"] [data-a11y-contact]'), 'The system owner');
  } finally { await ctx.close(); }
});
