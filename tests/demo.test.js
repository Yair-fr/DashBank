import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, CARD_SETTLEMENT_CATEGORY } from '../src/db.js';
import { seedDemo } from '../src/demo.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const all = (db) => db.allTransactionsSince('1970-01-01');

test('seedDemo produces a realistic dataset', () => {
  const db = openDb(':memory:');
  const res = seedDemo(db, { now: NOW });
  const txns = all(db);
  assert.ok(txns.length > 150, `got ${txns.length}`);
  assert.equal(res.inserted, txns.length);

  const accounts = db.listAccounts();
  assert.equal(accounts.length, 4);
  assert.deepEqual(accounts.map((a) => a.source).sort(), ['hapoalim', 'isracard', 'max', 'visaCal']);
  const bank = accounts.find((a) => a.source === 'hapoalim');
  assert.ok(Math.abs(bank.balance - 18450) < 500);

  assert.ok(db.listRecurring().length >= 5, `recurring ${db.listRecurring().length}`);
  assert.equal(db.lastSyncRuns().length, 4);
  assert.ok(db.lastSyncRuns().every((r) => r.ok));

  // nothing in the future, everything within ~6 months
  assert.ok(txns.every((t) => new Date(t.date) <= NOW));
  assert.ok(txns.every((t) => t.date >= '2026-05-01'));
  assert.ok(txns.every((t) => t.category));
});

test('seedDemo is deterministic and idempotent', () => {
  const a = openDb(':memory:');
  const b = openDb(':memory:');
  seedDemo(a, { now: NOW });
  seedDemo(b, { now: NOW });
  const hashes = (db) => all(db).map((t) => `${t.hash}|${t.amount}`).sort();
  assert.deepEqual(hashes(a), hashes(b));
  const again = seedDemo(a, { now: NOW });
  assert.equal(again.inserted, 0);
  assert.equal(all(a).length, all(b).length);
});

test('seedDemo contains the specified fixtures', () => {
  const db = openDb(':memory:');
  seedDemo(db, { now: NOW });
  const txns = all(db);
  const find = (re) => txns.filter((t) => re.test(t.description));

  const salary = find(/משכורת/);
  assert.ok(salary.length >= 6);
  assert.ok(salary.every((t) => t.amount === 14200 && t.date.slice(8, 10) === '10' && t.source === 'hapoalim'));
  const rent = find(/^הוראת קבע - שכר דירה$/);
  assert.ok(rent.length >= 6 && rent.every((t) => t.amount === -5200 && t.date.slice(8, 10) === '01'));
  assert.ok(find(/ביטוח לאומי/).length >= 5);
  assert.ok(find(/ועד בית/).length >= 5);
  assert.ok(find(/NETFLIX/i).every((t) => t.amount === -54.9));
  assert.ok(find(/SPOTIFY/i).every((t) => t.amount === -19.9));
  assert.ok(find(/סלקום/).every((t) => t.amount === -49));
  assert.ok(find(/חברת החשמל/).length >= 2);
  assert.ok(find(/שופרסל|רמי לוי/).length >= 20);
  assert.ok(find(/בר-אילן/).length >= 3);

  const inst = txns.filter((t) => t.installmentTotal === 12);
  assert.ok(inst.length >= 2);
  assert.equal(new Set(inst.map((t) => t.description)).size, 1);

  const usd = txns.filter((t) => t.originalCurrency === 'USD');
  assert.equal(usd.length, 1);
  assert.ok(usd[0].amount < usd[0].originalAmount); // ILS amount is larger in magnitude

  const pending = txns.filter((t) => t.status === 'pending');
  assert.equal(pending.length, 2);
  assert.ok(pending.every((t) => NOW - new Date(t.date) <= 2 * 86400000));
});

test('card settlement debits equal the previous month card totals', () => {
  const db = openDb(':memory:');
  seedDemo(db, { now: NOW });
  const txns = all(db);
  const settlements = txns.filter((t) => t.category === CARD_SETTLEMENT_CATEGORY);
  assert.ok(settlements.length >= 12, `settlements ${settlements.length}`);
  const cardOf = { 'ישראכרט': ['isracard', '02'], 'כאל': ['visaCal', '10'], 'מקס': ['max', '15'] };
  for (const s of settlements) {
    assert.equal(s.source, 'hapoalim');
    const [card, day] = cardOf[s.description];
    assert.equal(s.date.slice(8, 10), day);
    const d = new Date(s.date);
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const total = txns.filter((t) => t.source === card && t.date.slice(0, 7) === prev && t.status === 'completed')
      .reduce((sum, t) => sum + Math.round(t.amount * 100), 0) / 100;
    assert.equal(s.amount, total, `${s.description} ${s.date}`);
  }
});
