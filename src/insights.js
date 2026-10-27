// Business-intelligence metrics derived from the overview aggregates. Pure functions, no I/O.

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/** Days in a YYYY-MM month. */
export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * month: 'YYYY-MM'; today: Date (used to tell the current month from past ones).
 * summary/prevSummary: db.summary() output; categories/prevCategories: db.categories() output;
 * recurring: db.listRecurring() output.
 */
export function computeInsights({ month, today = new Date(), summary, categories = [], prevCategories = [], recurring = [], topMerchants = [] }) {
  const total = daysInMonth(month);
  const todayIso = today.toISOString().slice(0, 7);
  const isCurrent = todayIso === month;
  const elapsed = isCurrent ? today.getUTCDate() : total;

  const savingsRate = summary.income > 0 ? round1((summary.net / summary.income) * 100) : null;
  const avgDailySpend = elapsed > 0 ? round2(summary.expense / elapsed) : 0;
  const projectedSpend = isCurrent ? round2(avgDailySpend * total) : null;

  // Monthly outflow from recurring items (standing orders, subscriptions) as a share of spending.
  const fixedMonthly = recurring
    .filter((r) => r.avgAmount < 0 && r.cadence === 'monthly')
    .reduce((s, r) => s - r.avgAmount, 0);
  const fixedShare = summary.expense > 0 ? round1((fixedMonthly / summary.expense) * 100) : null;

  const top = categories[0] || null;
  const topShare = top && summary.expense > 0 ? round1((top.total / summary.expense) * 100) : null;

  const prevByCat = new Map(prevCategories.map((c) => [c.category, c.total]));
  const increases = categories
    .map((c) => {
      const before = prevByCat.get(c.category) ?? 0;
      const changePct = before > 0 ? round1(((c.total - before) / before) * 100) : null;
      return { category: c.category, total: c.total, before, changePct };
    })
    .filter((c) => c.changePct !== null && c.changePct >= 50 && c.total - c.before >= 100)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 3);

  return {
    savingsRate,
    avgDailySpend,
    projectedSpend,
    fixedMonthly: round2(fixedMonthly),
    fixedShare,
    topCategory: top ? { category: top.category, total: top.total, share: topShare } : null,
    increases,
    topMerchants,
  };
}
