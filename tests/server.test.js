import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, CARD_SETTLEMENT_CATEGORY } from '../src/db.js';
import { normalizeTxn, SOURCE_LABELS } from '../src/normalize.js';
import { createApp, monthRange } from '../src/server.js';

const mk = (o) => {
  const t = normalizeTxn({
    identifier: o.id, date: o.date, chargedAmount: o.amount, originalAmount: o.amount,
    description: o.description, status: o.status || 'completed',
  }, { source: o.source || 'hapoalim', accountNumber: o.account || '9' });
  return { ...t, category: o.category ?? null };
};

function seed(db) {
  db.insertTransactions([
    mk({ id: 1, date: '2026-10-01T08:00:00.000Z', amount: 12000, description: 'משכורת', category: 'הכנסה' }),
    mk({ id: 2, date: '2026-10-05T08:00:00.000Z', amount: -3000, description: 'ישראכרט', category: CARD_SETTLEMENT_CATEGORY }),
    mk({ id: 3, date: '2026-10-07T08:00:00.000Z', amount: -250, description: 'שופרסל דיל', category: 'מזון', source: 'isracard', account: '1234' }),
    mk({ id: 4, date: '2026-10-09T08:00:00.000Z', amount: -80, description: 'נטפליקס', category: 'מנויים', source: 'max', account: '5678', status: 'pending' }),
    mk({ id: 5, date: '2026-09-15T08:00:00.000Z', amount: -400, description: 'פז דלק', category: 'רכב', source: 'visaCal', account: '4321' }),
    mk({ id: 6, date: '2026-09-01T08:00:00.000Z', amount: 11000, description: 'משכורת', category: 'הכנסה' }),
  ]);
  db.upsertAccount({ source: 'hapoalim', accountNumber: '9', label: 'עו"ש', balance: 5000 });
  db.saveRecurring([{ key: 'netflix', description: 'נטפליקס', source: 'max', avgAmount: -80, cadence: 'monthly', count: 4,
    lastDate: '2026-10-09', nextDate: '2026-11-09', kind: 'subscription' }]);
  db.logSyncRun({ startedAt: '2026-10-10T10:00:00.000Z', source: 'hapoalim', ok: true, newCount: 3 });
}

async function start(opts) {
  const app = createApp(opts);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

let db; let srv;
before(async () => {
  db = openDb(':memory:');
  seed(db);
  srv = await start({ db, config: { demo: false } });
});
after(async () => { await srv.close(); db.close(); });

test('monthRange computes [first, first-of-next) and rejects bad input', () => {
  assert.deepEqual(monthRange('2026-10'), { from: '2026-10-01', to: '2026-11-01' });
  assert.deepEqual(monthRange('2026-12'), { from: '2026-12-01', to: '2027-01-01' });
  assert.equal(monthRange('2026-13'), null);
  assert.equal(monthRange('2026-1'), null);
  assert.equal(monthRange('abc'), null);
});

test('GET /api/health', async () => {
  const res = await fetch(`${srv.base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /api/overview returns shape and numbers for month', async () => {
  const res = await fetch(`${srv.base}/api/overview?month=2026-10`);
  assert.equal(res.status, 200);
  const o = await res.json();
  assert.equal(o.month, '2026-10');
  assert.equal(o.summary.income, 12000);
  assert.equal(o.summary.expense, 330); // settlement excluded
  assert.equal(o.summary.net, 11670);
  assert.equal(o.summary.balance, 5000);
  assert.equal(o.summary.pending, 80);
  assert.equal(o.prevSummary.income, 11000);
  assert.equal(o.prevSummary.expense, 400);
  assert.equal(o.accounts.length, 1);
  assert.equal(o.monthly.length, 12);
  assert.equal(o.monthly.at(-1).month, '2026-10');
  assert.equal(o.monthly.at(-2).expense, 400);
  assert.deepEqual(o.categories.map((c) => c.category), ['מזון', 'מנויים']);
  assert.deepEqual(o.daily.map((d) => d.day), ['2026-10-07', '2026-10-09']);
  assert.deepEqual(o.prevDaily.map((d) => d.day), ['2026-09-15']);
  assert.equal(o.recurring.length, 1);
  assert.equal(o.recurring[0].kind, 'subscription');
  assert.equal(o.syncRuns.length, 1);
  assert.equal(o.syncRuns[0].ok, true);
  assert.equal(o.demo, false);
  assert.equal(o.syncing, false);
  assert.deepEqual(o.sourceLabels, SOURCE_LABELS);
});

test('GET /api/overview defaults to current month', async () => {
  const o = await (await fetch(`${srv.base}/api/overview`)).json();
  assert.match(o.month, /^\d{4}-\d{2}$/);
  assert.equal(o.month, new Date().toISOString().slice(0, 7));
});

test('GET /api/overview 400 on bad month', async () => {
  const res = await fetch(`${srv.base}/api/overview?month=2026-1x`);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('GET /api/transactions filters', async () => {
  let r = await (await fetch(`${srv.base}/api/transactions`)).json();
  assert.equal(r.total, 6);
  r = await (await fetch(`${srv.base}/api/transactions?direction=in`)).json();
  assert.equal(r.total, 2);
  r = await (await fetch(`${srv.base}/api/transactions?direction=out&source=isracard`)).json();
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].description, 'שופרסל דיל');
  r = await (await fetch(`${srv.base}/api/transactions?q=${encodeURIComponent('משכורת')}&from=2026-10-01&to=2026-11-01`)).json();
  assert.equal(r.total, 1);
  r = await (await fetch(`${srv.base}/api/transactions?category=${encodeURIComponent('רכב')}`)).json();
  assert.equal(r.total, 1);
  r = await (await fetch(`${srv.base}/api/transactions?limit=2&offset=2`)).json();
  assert.equal(r.rows.length, 2);
  assert.equal(r.total, 6);
});

test('GET /api/transactions validates params', async () => {
  for (const qs of ['from=yesterday', 'to=2026-99-99x', 'direction=sideways', 'limit=-5', 'offset=abc', 'limit=1.5']) {
    const res = await fetch(`${srv.base}/api/transactions?${qs}`);
    assert.equal(res.status, 400, qs);
  }
  const big = await (await fetch(`${srv.base}/api/transactions?limit=99999`)).json();
  assert.equal(big.total, 6); // clamped, still works
});

test('POST /api/sync: 400 without syncer, 400 in demo, 409 running, 202 otherwise', async () => {
  let res = await fetch(`${srv.base}/api/sync`, { method: 'POST' });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);

  let running = false; let calls = 0; let release;
  const syncer = {
    isRunning: () => running,
    run: () => { calls++; running = true; return new Promise((r) => { release = () => { running = false; r(); }; }); },
  };
  const demo = await start({ db, syncer, config: { demo: true } });
  res = await fetch(`${demo.base}/api/sync`, { method: 'POST' });
  assert.equal(res.status, 400);
  await demo.close();

  const live = await start({ db, syncer, config: {} });
  res = await fetch(`${live.base}/api/sync`, { method: 'POST' });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { started: true });
  assert.equal(calls, 1);
  const ov = await (await fetch(`${live.base}/api/overview?month=2026-10`)).json();
  assert.equal(ov.syncing, true);
  res = await fetch(`${live.base}/api/sync`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.ok((await res.json()).error);
  release();
  await live.close();
});

test('POST /api/sync swallows background rejection', async () => {
  const syncer = { isRunning: () => false, run: () => Promise.reject(new Error('boom')) };
  const s = await start({ db, syncer, config: {} });
  const res = await fetch(`${s.base}/api/sync`, { method: 'POST' });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
  await s.close();
});

test('security headers present', async () => {
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('/ serves HTML and /vendor/chart.umd.js is served', async () => {
  let res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /dir="rtl"/);
  assert.match(html, /DashBank/);
  res = await fetch(`${srv.base}/vendor/chart.umd.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.ok((await res.text()).length > 1000);
});

test('unknown /api route → 404 JSON; thrown errors → 500 {error:"internal"}', async () => {
  let res = await fetch(`${srv.base}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });

  const broken = { ...db, summary: () => { throw new Error('db exploded'); } };
  const s = await start({ db: broken, config: {} });
  res = await fetch(`${s.base}/api/overview?month=2026-10`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal' });
  await s.close();
});
