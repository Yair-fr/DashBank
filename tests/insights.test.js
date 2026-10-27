import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInsights, daysInMonth } from '../src/insights.js';

test('daysInMonth handles leap years and month lengths', () => {
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(daysInMonth('2026-10'), 31);
});

test('savings rate, daily average and projection for the current month', () => {
  const i = computeInsights({
    month: '2026-10', today: new Date('2026-10-10T12:00:00Z'),
    summary: { income: 10000, expense: 4000, net: 6000 },
  });
  assert.equal(i.savingsRate, 60);
  assert.equal(i.avgDailySpend, 400); // 4000 over 10 elapsed days
  assert.equal(i.projectedSpend, 12400); // 400 × 31 days
});

test('past months have no projection and use the full month for averages', () => {
  const i = computeInsights({ month: '2026-09', today: new Date('2026-10-10T12:00:00Z'), summary: { income: 0, expense: 3000, net: -3000 } });
  assert.equal(i.projectedSpend, null);
  assert.equal(i.savingsRate, null); // no income → rate undefined, not Infinity
  assert.equal(i.avgDailySpend, 100); // 3000 / 30
});

test('fixed-cost share counts only monthly outflows', () => {
  const i = computeInsights({
    month: '2026-10', today: new Date('2026-10-31T12:00:00Z'),
    summary: { income: 0, expense: 2000, net: -2000 },
    recurring: [
      { avgAmount: -500, cadence: 'monthly' },
      { avgAmount: -100, cadence: 'weekly' }, // ignored: not monthly
      { avgAmount: 9000, cadence: 'monthly' }, // income, ignored
    ],
  });
  assert.equal(i.fixedMonthly, 500);
  assert.equal(i.fixedShare, 25);
});

test('flags categories that rose at least 50% and by at least 100 ILS', () => {
  const i = computeInsights({
    month: '2026-10', today: new Date('2026-10-31T12:00:00Z'),
    summary: { income: 0, expense: 1000, net: -1000 },
    categories: [{ category: 'מסעדות', total: 600 }, { category: 'מזון', total: 400 }, { category: 'קניות', total: 120 }],
    prevCategories: [{ category: 'מסעדות', total: 300 }, { category: 'מזון', total: 390 }, { category: 'קניות', total: 100 }],
  });
  assert.deepEqual(i.increases.map((c) => c.category), ['מסעדות']); // +100% ✓; קניות +20% ✗; מזון small ✗
  assert.equal(i.increases[0].changePct, 100);
  assert.deepEqual(i.topCategory, { category: 'מסעדות', total: 600, share: 60 });
});
