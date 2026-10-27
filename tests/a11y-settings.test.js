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
