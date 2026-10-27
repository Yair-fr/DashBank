import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../src/categorize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const read = (p) => fs.readFileSync(path.join(PUB, p), 'utf8');
const he = JSON.parse(read('locales/he.json'));
const en = JSON.parse(read('locales/en.json'));
const HEBREW = /[\u0590-\u05FF]/;

// Plural objects ({ one, two, other }) are leaves: languages legitimately have different plural forms.
const isPlural = (v) => v && typeof v === 'object' && typeof v.other === 'string';
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}\u0000${k}` : k;
    if (v && typeof v === 'object' && !isPlural(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}
const show = (k) => k.replaceAll('\u0000', '.');

test('every key in he.json exists in en.json and vice versa', () => {
  const a = flatten(he); const b = flatten(en);
  const missingInEn = [...a.keys()].filter((k) => !b.has(k)).map(show);
  const missingInHe = [...b.keys()].filter((k) => !a.has(k)).map(show);
  assert.deepEqual(missingInEn, [], 'missing in en.json');
  assert.deepEqual(missingInHe, [], 'missing in he.json');
});

test('all locale values are non-empty strings or plural objects with "other"', () => {
  for (const [name, dict] of [['he', he], ['en', en]]) {
    for (const [k, v] of flatten(dict)) {
      if (isPlural(v)) {
        for (const [form, s] of Object.entries(v)) assert.ok(['zero', 'one', 'two', 'few', 'many', 'other'].includes(form) && s, `${name}:${show(k)}.${form}`);
      } else {
        assert.equal(typeof v, 'string', `${name}:${show(k)}`);
        assert.ok(v.length > 0, `${name}:${show(k)} is empty`);
      }
    }
  }
});

test('placeholders match between languages', () => {
  const vars = (v) => [...new Set((isPlural(v) ? Object.values(v).join(' ') : v).match(/\{\w+\}/g) || [])].filter((x) => x !== '{count}').sort();
  const b = flatten(en);
  for (const [k, v] of flatten(he)) assert.deepEqual(vars(b.get(k)), vars(v), `placeholders differ for ${show(k)}`);
});

test('en.json translates every category, kind and cadence', () => {
  for (const c of [...CATEGORIES, 'דיור']) {
    assert.ok(en.categories[c] && !HEBREW.test(en.categories[c]), `category ${c}`);
    assert.equal(he.categories[c], c, `he.json keeps the data value for ${c}`);
  }
  for (const k of ['standing_order', 'subscription', 'income', 'recurring']) assert.ok(en.kinds[k] && he.kinds[k], `kind ${k}`);
  for (const k of ['monthly', 'weekly', 'yearly']) assert.ok(en.cadences[k] && he.cadences[k], `cadence ${k}`);
});

test('English strings contain no Hebrew (except the language switch label and category keys)', () => {
  for (const [k, v] of flatten(en)) {
    if (show(k).startsWith('lang.')) continue;
    const text = isPlural(v) ? Object.values(v).join(' ') : v;
    assert.ok(!HEBREW.test(text), `en:${show(k)} contains Hebrew`);
  }
});

test('login keys exist for the login page', () => {
  for (const d of [he, en]) {
    for (const k of ['title', 'username', 'password', 'code', 'continue', 'google', 'logout']) assert.ok(d.login[k], k);
    for (const k of ['invalid', 'rate_limited', 'setup_required']) assert.ok(d.login.errors[k], k);
  }
});

function stripComments(src) {
  // Remove block and line comments while keeping string/regex contents intact enough for a char scan.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

test('no hard-coded Hebrew left in app.js / login.js (outside comments)', () => {
  for (const file of ['app.js', 'login.js']) {
    const p = path.join(PUB, file);
    if (!fs.existsSync(p)) continue;
    const lines = stripComments(fs.readFileSync(p, 'utf8')).split('\n');
    const offenders = lines.map((l, i) => [i + 1, l]).filter(([, l]) => HEBREW.test(l));
    assert.deepEqual(offenders, [], `${file} has Hebrew outside comments`);
  }
});

test('every data-i18n key used in the HTML pages exists', () => {
  const b = flatten(he);
  const files = ['index.html', ...fs.readdirSync(path.join(PUB, 'legal')).filter((f) => f.endsWith('.html')).map((f) => `legal/${f}`)];
  if (fs.existsSync(path.join(PUB, 'login.html'))) files.push('login.html');
  for (const f of files) {
    const html = read(f);
    for (const m of html.matchAll(/data-i18n(?:-label|-placeholder|-title|-alt|-page-title)?="([^"]+)"/g)) {
      assert.ok(b.has(m[1].split('.').join('\u0000')), `${f}: unknown key ${m[1]}`);
    }
  }
});

test('app.js only references keys that exist', () => {
  const b = flatten(he);
  const src = read('app.js');
  for (const m of src.matchAll(/\bt\('([a-z_]+\.[a-z_.]+)'/g)) {
    assert.ok(b.has(m[1].split('.').join('\u0000')), `unknown key ${m[1]}`);
  }
});

test('service worker precaches the i18n, locale and legal files', () => {
  const sw = read('sw.js');
  for (const f of ['i18n.js', 'locales/he.json', 'locales/en.json', 'legal/privacy.html', 'legal/terms.html', 'legal/accessibility.html']) {
    assert.ok(sw.includes(`'${f}'`), f);
    assert.ok(fs.existsSync(path.join(PUB, f)), `${f} exists`);
  }
});

test('legal pages have both languages, the not-legal-advice mark and lang attributes', () => {
  for (const f of ['privacy', 'terms', 'accessibility']) {
    const html = read(`legal/${f}.html`);
    assert.match(html, /<article[^>]*lang="he"[^>]*dir="rtl"/);
    assert.match(html, /<article[^>]*lang="en"[^>]*dir="ltr"/);
    assert.match(html, /אינו מהווה ייעוץ משפטי/);
    assert.match(html, /Not legal advice/);
  }
  assert.match(read('legal/accessibility.html'), /5568/);
  assert.match(read('legal/accessibility.html'), /WCAG 2\.1/);
  assert.match(read('legal/accessibility.html'), /data-a11y-contact/);
});
