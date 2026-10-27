import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, CARD_SETTLEMENT_CATEGORY } from '../src/db.js';
import { normalizeTxn, txnHash } from '../src/normalize.js';

const raw = (over = {}) => ({
  type: 'normal', identifier: 111, date: '2026-10-01T00:00:00.000Z', processedDate: '2026-10-10T00:00:00.000Z',
  originalAmount: -50, originalCurrency: 'ILS', chargedAmount: -50, description: '  שופרסל   דיל ', status: 'completed', ...over,
});

test('normalizeTxn maps fields and collapses whitespace', () => {
  const t = normalizeTxn(raw(), { source: 'max', accountNumber: '1234' });
  assert.equal(t.description, 'שופרסל דיל');
  assert.equal(t.amount, -50);
  assert.equal(t.identifier, '111');
  assert.equal(t.status, 'completed');
  assert.equal(t.hash.length, 32);
});

test('txnHash ignores status so pending → completed is the same txn', () => {
  const a = normalizeTxn(raw({ status: 'pending' }), { source: 'max', accountNumber: '1' });
  const b = normalizeTxn(raw({ status: 'completed' }), { source: 'max', accountNumber: '1' });
  assert.equal(a.hash, b.hash);
  assert.notEqual(txnHash({ ...a, amount: -51 }), a.hash);
});

test('insertTransactions dedupes and completes pending', () => {
  const db = openDb(':memory:');
  const pending = normalizeTxn(raw({ status: 'pending' }), { source: 'max', accountNumber: '1' });
  assert.equal(db.insertTransactions([pending]).length, 1);
  const done = normalizeTxn(raw(), { source: 'max', accountNumber: '1' });
  assert.equal(db.insertTransactions([done, done]).length, 0);
  assert.equal(db.listTransactions().rows[0].status, 'completed');
  assert.equal(db.hasTransactions('max'), true);
  assert.equal(db.hasTransactions('isracard'), false);
});

test('summary/monthly/categories exclude card settlements', () => {
  const db = openDb(':memory:');
  const mk = (o) => normalizeTxn(raw(o), { source: o.source || 'hapoalim', accountNumber: '9' });
  const txns = [
    { ...mk({ identifier: 1, chargedAmount: 10000, description: 'משכורת' }), category: 'הכנסה' },
    { ...mk({ identifier: 2, chargedAmount: -3000, description: 'ישראכרט' }), category: CARD_SETTLEMENT_CATEGORY },
    { ...mk({ identifier: 3, chargedAmount: -200, description: 'שופרסל', source: 'isracard' }), category: 'מזון' },
  ];
  db.insertTransactions(txns);
  db.upsertAccount({ source: 'hapoalim', accountNumber: '9', label: 'עו"ש', balance: 5000 });
  const s = db.summary({ from: '2026-10-01', to: '2026-11-01' });
  assert.deepEqual([s.income, s.expense, s.net, s.balance], [10000, 200, 9800, 5000]);
  assert.deepEqual(db.categories({ from: '2026-10-01' }).map((c) => c.category), ['מזון']);
  const m = db.monthly(2, new Date('2026-10-15'));
  assert.deepEqual(m, [{ month: '2026-09', income: 0, expense: 0 }, { month: '2026-10', income: 10000, expense: 200 }]);
  assert.equal(db.listTransactions({ direction: 'out' }).total, 2);
  assert.equal(db.listTransactions({ q: 'שופר' }).total, 1);
});

test('recurring and sync runs round-trip', () => {
  const db = openDb(':memory:');
  db.saveRecurring([{ key: 'k', description: 'נטפליקס', source: 'max', avgAmount: -54.9, cadence: 'monthly', count: 4, lastDate: '2026-10-01', nextDate: '2026-11-01', kind: 'subscription' }]);
  assert.equal(db.listRecurring()[0].description, 'נטפליקס');
  db.logSyncRun({ startedAt: new Date().toISOString(), source: 'max', ok: false, error: 'INVALID_PASSWORD' });
  assert.equal(db.lastSyncRuns()[0].ok, false);
});
