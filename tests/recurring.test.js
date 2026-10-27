import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRecurring } from '../src/recurring.js';

const t = (date, amount, description = 'NETFLIX.COM', extra = {}) => ({ source: 'isracard', date: `${date}T10:00:00.000Z`, amount, description, installmentTotal: null, ...extra });
const now = new Date('2026-05-10T00:00:00Z');

test('monthly Netflix x4 is a subscription with nextDate', () => {
  const r = detectRecurring([t('2026-01-31', -50), t('2026-02-28', -50), t('2026-03-31', -50), t('2026-04-30', -50)], { now });
  assert.equal(r.length, 1);
  assert.equal(r[0].cadence, 'monthly');
  assert.equal(r[0].kind, 'subscription');
  assert.equal(r[0].count, 4);
  assert.equal(r[0].lastDate, '2026-04-30');
  assert.equal(r[0].nextDate, '2026-05-30');
  assert.equal(r[0].avgAmount, -50);
  assert.equal(r[0].active, true);
});

test('nextDate clamps to month end', () => {
  const r = detectRecurring([t('2025-11-30', -50), t('2025-12-31', -50), t('2026-01-31', -50)], { now: new Date('2026-02-05T00:00:00Z') });
  assert.equal(r[0].nextDate, '2026-02-28');
});

test('weekly detected', () => {
  const r = detectRecurring([t('2026-04-01', -30, 'חוג'), t('2026-04-08', -30, 'חוג'), t('2026-04-15', -30, 'חוג')], { now: new Date('2026-04-20T00:00:00Z') });
  assert.equal(r[0].cadence, 'weekly');
  assert.equal(r[0].nextDate, '2026-04-22');
});

test('amounts outside 15% rejected', () => {
  assert.equal(detectRecurring([t('2026-01-05', -50), t('2026-02-05', -50), t('2026-03-05', -80)], { now }).length, 0);
});

test('only 2 monthly occurrences rejected', () => {
  assert.equal(detectRecurring([t('2026-03-05', -50), t('2026-04-05', -50)], { now }).length, 0);
});

test('yearly needs only 2', () => {
  const r = detectRecurring([t('2024-06-01', -400, 'ביטוח רכב'), t('2025-06-01', -400, 'ביטוח רכב')], { now });
  assert.equal(r[0].cadence, 'yearly');
  assert.equal(r[0].nextDate, '2026-06-01');
});

test('installments ignored', () => {
  const rows = [t('2026-01-05', -50, 'חנות', { installmentTotal: 3 }), t('2026-02-05', -50, 'חנות', { installmentTotal: 3 }), t('2026-03-05', -50, 'חנות', { installmentTotal: 3 })];
  assert.equal(detectRecurring(rows, { now }).length, 0);
});

test('inactive flagged', () => {
  const r = detectRecurring([t('2025-10-05', -50), t('2025-11-05', -50), t('2025-12-05', -50)], { now });
  assert.equal(r[0].active, false);
});

test('standing order and salary income, digits ignored in key, sorted', () => {
  const rows = [
    { source: 'hapoalim', date: '2026-01-10T00:00:00Z', amount: -1000, description: 'הוראת קבע 123' },
    { source: 'hapoalim', date: '2026-02-10T00:00:00Z', amount: -1000, description: 'הוראת קבע 456' },
    { source: 'hapoalim', date: '2026-03-10T00:00:00Z', amount: -1000, description: 'הוראת קבע 789' },
    { source: 'hapoalim', date: '2026-01-01T00:00:00Z', amount: 15000, description: 'משכורת' },
    { source: 'hapoalim', date: '2026-02-01T00:00:00Z', amount: 15000, description: 'משכורת' },
    { source: 'hapoalim', date: '2026-03-01T00:00:00Z', amount: 15000, description: 'משכורת' },
    { source: 'hapoalim', date: '2026-01-01T00:00:00Z', amount: 300, description: 'העברה' },
    { source: 'hapoalim', date: '2026-02-01T00:00:00Z', amount: 300, description: 'העברה' },
    { source: 'hapoalim', date: '2026-03-01T00:00:00Z', amount: 300, description: 'העברה' },
  ];
  const r = detectRecurring(rows, { now: new Date('2026-03-20T00:00:00Z') });
  assert.equal(r.length, 2);
  assert.equal(r[0].kind, 'standing_order');
  assert.equal(r[0].count, 3);
  assert.equal(r[1].kind, 'income');
});
