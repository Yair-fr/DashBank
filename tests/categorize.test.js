import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, CATEGORIES, RULES } from '../src/categorize.js';
import { CARD_SETTLEMENT_CATEGORY } from '../src/db.js';

test('card settlement only for bank sources', () => {
  assert.equal(categorize('ישראכרט בע"מ', { source: 'hapoalim', amount: -2000 }), CARD_SETTLEMENT_CATEGORY);
  assert.equal(categorize('MAX IT', { source: 'leumi', amount: -100 }), CARD_SETTLEMENT_CATEGORY);
  assert.notEqual(categorize('ישראכרט', { source: 'isracard', amount: -100 }), CARD_SETTLEMENT_CATEGORY);
  assert.notEqual(categorize('כאל', { amount: -100 }), CARD_SETTLEMENT_CATEGORY);
});

test('salary and income', () => {
  assert.equal(categorize('משכורת חברת X', { source: 'hapoalim', amount: 15000 }), 'משכורת');
  assert.equal(categorize('Salary ACME', { amount: 9000 }), 'משכורת');
  assert.equal(categorize('העברה מיוסי', { amount: 500 }), 'העברות');
  assert.equal(categorize('ביטוח לאומי', { amount: 1200 }), 'קצבאות');
  assert.equal(categorize('זיכוי כלשהו', { amount: 50 }), 'הכנסה');
  assert.equal(categorize('שכר דירה', { amount: -4000 }), 'אחר');
});

test('representative merchants', () => {
  const c = (d) => categorize(d, { amount: -50 });
  assert.equal(c('שופרסל דיל'), 'מזון וסופר');
  assert.equal(c('רמי לוי שיווק'), 'מזון וסופר');
  assert.equal(c('WOLT'), 'מסעדות וקפה');
  assert.equal(c('סונול תחנה'), 'תחבורה ודלק');
  assert.equal(c('סלקום'), 'תקשורת');
  assert.equal(c('NETFLIX.COM'), 'מנויים ודיגיטל');
  assert.equal(c('חברת החשמל'), 'חשבונות בית');
  assert.equal(c('מי אביבים'), 'חשבונות בית');
  assert.equal(c('הראל ביטוח'), 'ביטוח ובריאות');
  assert.equal(c('IKEA'), 'קניות');
  assert.equal(c('Udemy'), 'חינוך');
  assert.equal(c('סינמה סיטי'), 'פנאי');
  assert.equal(c('משיכת מזומן כספומט'), 'משיכת מזומן');
  assert.equal(c('עמלה על פעולה'), 'עמלות');
  assert.equal(c('הוראת קבע ארגון'), 'הוראות קבע');
});

test('short latin tokens use word boundaries', () => {
  assert.equal(categorize('Tennis club', { amount: -1 }), 'אחר');
  assert.equal(categorize('Yesterday store', { amount: -1 }), 'אחר');
  assert.equal(categorize('TEN', { amount: -1 }), 'תחבורה ודלק');
  assert.equal(categorize('YES PLUS', { amount: -1 }), 'תקשורת');
});

test('fallback and exports', () => {
  assert.equal(categorize('xyzzy unknown'), 'אחר');
  assert.equal(categorize(''), 'אחר');
  assert.ok(CATEGORIES.includes('אחר') && CATEGORIES.includes(CARD_SETTLEMENT_CATEGORY));
  assert.ok(RULES.every((r) => r.category && Array.isArray(r.patterns)));
});
