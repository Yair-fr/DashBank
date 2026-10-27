import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createSyncer, cronExpression } from '../src/sync.js';
import { scrapeAccount } from '../src/scraper.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');
const config = { monthsBack: 6, dataDir: '/nonexistent-dashbank-test' };

const rawTxn = (over = {}) => ({
  type: 'normal', identifier: 1, date: '2026-10-20T10:00:00.000Z', processedDate: '2026-11-02T00:00:00.000Z',
  originalAmount: -100, originalCurrency: 'ILS', chargedAmount: -100, description: 'שופרסל דיל', status: 'completed', ...over,
});

function fakeNotifier() {
  const calls = { txn: [], summary: [], error: [] };
  return {
    calls,
    channels: ['fake'],
    async notifyTxn(t) { calls.txn.push(t); return { sent: 1, failed: 0 }; },
    async notifySummary(list, label) { calls.summary.push({ list, label }); return { sent: 1, failed: 0 }; },
    async notifyError(label, message) { calls.error.push({ label, message }); return { sent: 1, failed: 0 }; },
  };
}

const ACCOUNTS = [
  { id: 'a1', companyId: 'isracard', label: 'ישראכרט שלי', credentials: { id: 'x', card6Digits: 'y', password: 'z' } },
  { id: 'a2', companyId: 'hapoalim', label: 'עו"ש', credentials: { userCode: 'u', password: 'p' } },
];

function setup({ scrape, accounts = ACCOUNTS } = {}) {
  const db = openDb(':memory:');
  const notifier = fakeNotifier();
  const scrapeCalls = [];
  const syncer = createSyncer({
    db, config, notifier, now: () => NOW,
    getAccounts: async () => accounts,
    scrape: async (account, opts) => { scrapeCalls.push({ account, opts }); return scrape(account, opts); },
  });
  return { db, notifier, syncer, scrapeCalls };
}

const bySource = {
  isracard: [rawTxn({ identifier: 1, description: 'שופרסל דיל', chargedAmount: -100, originalAmount: -100 }),
    rawTxn({ identifier: 2, description: 'NETFLIX.COM', chargedAmount: -54.9, originalAmount: -54.9, date: '2026-10-05T10:00:00.000Z' })],
  hapoalim: [rawTxn({ identifier: 3, description: 'משכורת', chargedAmount: 14200, originalAmount: 14200, date: '2026-10-10T10:00:00.000Z' }),
    rawTxn({ identifier: 4, description: 'ישראכרט', chargedAmount: -2300, originalAmount: -2300, date: '2026-10-02T10:00:00.000Z' })],
};
const okScrape = (extra = {}) => async (account) => ({
  ok: true,
  accounts: [{
    accountNumber: account.companyId === 'hapoalim' ? '12-345-678' : '4580',
    balance: account.companyId === 'hapoalim' ? 18450 : null,
    txns: [...bySource[account.companyId], ...(extra[account.companyId] || [])],
  }],
});

test('first sync inserts, categorizes, upserts accounts and sends summary (not per-txn)', async () => {
  const { db, notifier, syncer, scrapeCalls } = setup({ scrape: okScrape() });
  const report = await syncer.run();
  assert.deepEqual(report.results.map((r) => [r.label, r.ok, r.newCount]), [['ישראכרט שלי', true, 2], ['עו"ש', true, 2]]);
  assert.ok(report.startedAt && report.finishedAt);

  const { rows } = db.listTransactions({});
  assert.equal(rows.length, 4);
  const cat = Object.fromEntries(rows.map((r) => [r.description, r.category]));
  assert.equal(cat['שופרסל דיל'], 'מזון וסופר');
  assert.equal(cat['NETFLIX.COM'], 'מנויים ודיגיטל');
  assert.equal(cat['משכורת'], 'משכורת');
  assert.equal(cat['ישראכרט'], 'חיוב כרטיס אשראי');

  const accts = db.listAccounts();
  assert.equal(accts.length, 2);
  const bank = accts.find((a) => a.source === 'hapoalim');
  assert.equal(bank.balance, 18450);
  assert.equal(bank.label, 'עו"ש');

  assert.equal(notifier.calls.txn.length, 0);
  assert.equal(notifier.calls.summary.length, 2);
  assert.equal(notifier.calls.summary[0].label, 'ישראכרט שלי');
  assert.equal(notifier.calls.summary[0].list.length, 2);

  // first run: start date = monthsBack months ago
  assert.equal(scrapeCalls[0].opts.startDate.toISOString().slice(0, 10), '2026-04-27');
  assert.equal(scrapeCalls[0].opts.failureDir, '/nonexistent-dashbank-test/failures');
  assert.equal(db.lastSyncRuns().length, 2);
  assert.ok(db.lastSyncRuns().every((r) => r.ok));
});

test('second sync with one new txn sends exactly one notifyTxn and uses 45-day window', async () => {
  let extra = {};
  const { notifier, syncer, scrapeCalls } = setup({ scrape: (a, o) => okScrape(extra)(a, o) });
  await syncer.run();
  extra = { isracard: [rawTxn({ identifier: 9, description: 'וולט', chargedAmount: -62, originalAmount: -62, date: '2026-10-26T10:00:00.000Z' })] };
  const report = await syncer.run();
  assert.equal(notifier.calls.txn.length, 1);
  assert.equal(notifier.calls.txn[0].description, 'וולט');
  assert.equal(notifier.calls.txn[0].category, 'מסעדות וקפה');
  assert.equal(notifier.calls.summary.length, 2); // only from the first run
  assert.deepEqual(report.results.map((r) => r.newCount), [1, 0]);
  assert.equal(scrapeCalls[2].opts.startDate.toISOString().slice(0, 10), '2026-09-12');
});

test('new txns are notified oldest first', async () => {
  let extra = {};
  const { notifier, syncer } = setup({ scrape: (a, o) => okScrape(extra)(a, o) });
  await syncer.run();
  extra = { isracard: [
    rawTxn({ identifier: 11, description: 'B', date: '2026-10-26T10:00:00.000Z' }),
    rawTxn({ identifier: 10, description: 'A', date: '2026-10-21T10:00:00.000Z' }),
  ] };
  await syncer.run();
  assert.deepEqual(notifier.calls.txn.map((t) => t.description), ['A', 'B']);
});

test('failed account logs run, notifies error, and other accounts continue', async () => {
  const { db, notifier, syncer } = setup({
    scrape: async (account, opts) => (account.companyId === 'isracard'
      ? { ok: false, accounts: [], error: 'bad password', errorType: 'INVALID_PASSWORD' }
      : okScrape()(account, opts)),
  });
  const report = await syncer.run();
  assert.deepEqual(report.results.map((r) => [r.ok, r.newCount]), [[false, 0], [true, 2]]);
  assert.equal(report.results[0].error, 'bad password');
  assert.deepEqual(notifier.calls.error, [{ label: 'ישראכרט שלי', message: 'Wrong password — update it with npm run setup' }]);
  const failed = db.lastSyncRuns().find((r) => r.source === 'isracard');
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'bad password');
  assert.equal(db.listTransactions({}).total, 2);
});

test('a scrape that throws is treated as a failure, not a crash', async () => {
  const { notifier, syncer } = setup({
    scrape: async (account, opts) => { if (account.companyId === 'isracard') throw new Error('boom'); return okScrape()(account, opts); },
  });
  const report = await syncer.run();
  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[0].error, 'boom');
  assert.equal(report.results[1].ok, true);
  assert.equal(notifier.calls.error.length, 1);
});

test('concurrent run is skipped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { syncer } = setup({ scrape: async (a, o) => { await gate; return okScrape()(a, o); } });
  const first = syncer.run();
  assert.equal(syncer.isRunning(), true);
  assert.deepEqual(await syncer.run(), { skipped: true });
  release();
  const report = await first;
  assert.equal(report.results.length, 2);
  assert.equal(syncer.isRunning(), false);
});

test('recurring detection runs after sync and is saved', async () => {
  const months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const netflix = months.map((m, i) => rawTxn({
    identifier: 100 + i, description: 'NETFLIX.COM', chargedAmount: -54.9, originalAmount: -54.9, date: `${m}-05T10:00:00.000Z`,
  }));
  const { db, syncer } = setup({
    accounts: [ACCOUNTS[0]],
    scrape: async () => ({ ok: true, accounts: [{ accountNumber: '4580', txns: netflix }] }),
  });
  await syncer.run();
  const rec = db.listRecurring();
  assert.equal(rec.length, 1);
  assert.equal(rec[0].kind, 'subscription');
  assert.equal(rec[0].cadence, 'monthly');
});

test('cronExpression clamps to valid cron', () => {
  assert.equal(cronExpression(30), '*/30 * * * *');
  assert.equal(cronExpression(59), '*/59 * * * *');
  assert.equal(cronExpression(60), '0 * * * *');
  assert.equal(cronExpression(240), '0 * * * *');
});

// --- scrapeAccount -------------------------------------------------------

const account = { id: 'a1', companyId: 'max', label: 'מקס', credentials: { username: 'u', password: 'p' } };

test('scrapeAccount passes options and maps success', async () => {
  let gotOptions, gotCreds;
  const createScraper = (options) => {
    gotOptions = options;
    return { scrape: async (c) => { gotCreds = c; return { success: true, accounts: [{ accountNumber: '3391', balance: 12, txns: [rawTxn()] }] }; } };
  };
  const startDate = new Date('2026-09-01T00:00:00.000Z');
  const res = await scrapeAccount(account, { startDate, createScraper, failureDir: '/tmp/x' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.accounts.map((a) => [a.accountNumber, a.balance, a.txns.length]), [['3391', 12, 1]]);
  assert.equal(gotOptions.companyId, 'max');
  assert.equal(gotOptions.startDate, startDate);
  assert.equal(gotOptions.combineInstallments, false);
  assert.equal(gotOptions.showBrowser, false);
  assert.equal(gotOptions.verbose, false);
  assert.match(gotOptions.storeFailureScreenShotPath, /^\/tmp\/x\/.+\.png$/);
  assert.deepEqual(gotCreds, account.credentials);
});

test('scrapeAccount maps scraper failure', async () => {
  const createScraper = () => ({ scrape: async () => ({ success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'wrong' }) });
  const res = await scrapeAccount(account, { startDate: new Date(), createScraper });
  assert.deepEqual(res, { ok: false, accounts: [], error: 'wrong', errorType: 'INVALID_PASSWORD' });
});

test('scrapeAccount never throws', async () => {
  const res = await scrapeAccount(account, { startDate: new Date(), createScraper: () => ({ scrape: async () => { throw new Error('chrome crashed'); } }) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'chrome crashed');
  const res2 = await scrapeAccount(account, { startDate: new Date(), createScraper: () => { throw new Error('ctor'); } });
  assert.equal(res2.ok, false);
  assert.equal(res2.error, 'ctor');
});

test('scrapeAccount times out', async () => {
  const res = await scrapeAccount(account, { startDate: new Date(), createScraper: () => ({ scrape: () => new Promise(() => {}) }), timeoutMs: 20 });
  assert.equal(res.ok, false);
  assert.equal(res.errorType, 'TIMEOUT');
});

test('scrapeAccount redacts credential values from error messages', async () => {
  const acct = { ...account, credentials: { username: 'u', password: 'secretpw1' } };
  const createScraper = () => ({ scrape: async () => ({ success: false, errorType: 'GENERIC', errorMessage: 'login secretpw1 failed' }) });
  const res = await scrapeAccount(acct, { startDate: new Date(), createScraper });
  assert.ok(!res.error.includes('secretpw1'));
  assert.match(res.error, /login \*\*\* failed/);
});
