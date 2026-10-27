import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTxn, formatSummary } from '../src/notify/format.js';
import { createTelegram } from '../src/notify/telegram.js';
import { createNtfy } from '../src/notify/ntfy.js';
import { createNotifier } from '../src/notify/index.js';

const base = {
  source: 'isracard', accountNumber: '1234567', amount: -123.45, currency: 'ILS',
  description: 'שופרסל', category: 'מזון', date: '2026-03-10T10:30:00+02:00',
  status: 'completed', installmentNumber: null, installmentTotal: null,
};

test('formatTxn outgoing', () => {
  const f = formatTxn(base);
  assert.equal(f.title, '💳 ₪123.45 · שופרסל');
  assert.match(f.body, /ישראכרט • 4567/);
  assert.match(f.body, /מזון/);
  assert.match(f.body, /10\/03 10:30/);
  assert.equal(f.priority, 3);
  assert.deepEqual(f.tags, ['credit_card']);
});

test('formatTxn midnight shows date only', () => {
  const f = formatTxn({ ...base, date: '2026-03-09T22:00:00Z' });
  assert.match(f.body, /10\/03/);
  assert.doesNotMatch(f.body, /00:00/);
});

test('formatTxn incoming, high priority', () => {
  const f = formatTxn({ ...base, amount: 12000 });
  assert.equal(f.title, '💰 +₪12,000.00 · שופרסל');
  assert.equal(f.priority, 4);
  assert.deepEqual(f.tags, ['moneybag']);
});

test('formatTxn installments, foreign, pending', () => {
  const f = formatTxn({ ...base, installmentNumber: 2, installmentTotal: 12, originalAmount: -40, originalCurrency: 'USD', status: 'pending' });
  assert.match(f.body, /תשלום 2\/12/);
  assert.match(f.body, /\(\$40\.00\)/);
  assert.match(f.body, /⏳ ממתין לאישור/);
});

test('formatSummary', () => {
  const t = formatSummary([base, { ...base, amount: 500, description: 'משכורת' }]);
  assert.match(t, /2/);
  assert.match(t, /₪123\.45/);
  assert.match(t, /₪500\.00/);
  assert.match(t, /משכורת/);
});

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status }; };
  fn.calls = calls;
  return fn;
}

test('telegram request', async () => {
  const fetch = fakeFetch();
  await createTelegram({ token: 'TKN', chatId: '42' }, { fetch }).send({ title: 'a<b', body: 'x&y' });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.telegram.org/botTKN/sendMessage');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), {
    chat_id: '42', text: '<b>a&lt;b</b>\nx&amp;y', parse_mode: 'HTML', disable_web_page_preview: true,
  });
});

test('telegram error excludes token', async () => {
  const tg = createTelegram({ token: 'SECRET', chatId: '1' }, { fetch: fakeFetch(401) });
  await assert.rejects(tg.send({ title: 't', body: 'b' }), (e) => /401/.test(e.message) && !e.message.includes('SECRET'));
});

test('ntfy body and auth', async () => {
  const fetch = fakeFetch();
  await createNtfy({ server: 'https://ntfy.sh/', topic: 'top', token: 'tk' }, { fetch })
    .send({ title: 'כותרת', body: 'b', tags: ['moneybag'], priority: 4 });
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://ntfy.sh');
  assert.equal(init.headers.Authorization, 'Bearer tk');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { topic: 'top', title: 'כותרת', message: 'b', tags: ['moneybag'], priority: 4 });
});

test('ntfy no token => no auth header; error throws', async () => {
  const fetch = fakeFetch();
  await createNtfy({ server: 'https://x', topic: 't', token: '' }, { fetch }).send({ title: 'a', body: 'b' });
  assert.equal(fetch.calls[0].init.headers.Authorization, undefined);
  await assert.rejects(createNtfy({ server: 'https://x', topic: 't' }, { fetch: fakeFetch(500) }).send({ title: 'a', body: 'b' }), /500/);
});

const NTFY = { server: 'https://ntfy.sh', topic: 'x', token: '' };
const cfg = (o = {}) => ({ notifyMinAmount: 0, telegram: { token: '', chatId: '' }, ntfy: { server: 'https://ntfy.sh', topic: '', token: '' }, ...o });

test('notifier enables only configured channels', () => {
  assert.deepEqual(createNotifier(cfg(), { fetch: fakeFetch() }).channels, []);
  const n = createNotifier(cfg({ telegram: { token: 't', chatId: '1' }, ntfy: NTFY }), { fetch: fakeFetch() });
  assert.deepEqual(n.channels, ['telegram', 'ntfy']);
});

test('notifyTxn min amount filter (outgoing only)', async () => {
  const fetch = fakeFetch();
  const n = createNotifier(cfg({ notifyMinAmount: 100, ntfy: NTFY }), { fetch });
  assert.deepEqual(await n.notifyTxn({ ...base, amount: -50 }), { sent: 0, failed: 0 });
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(await n.notifyTxn({ ...base, amount: -150 }), { sent: 1, failed: 0 });
  assert.deepEqual(await n.notifyTxn({ ...base, amount: 50 }), { sent: 1, failed: 0 });
});

test('failing channel does not throw', async () => {
  const n = createNotifier(cfg({ telegram: { token: 't', chatId: '1' }, ntfy: NTFY }), {
    fetch: async (url) => { if (url.includes('telegram')) throw new Error('boom'); return { ok: true, status: 200 }; },
  });
  assert.deepEqual(await n.notifyTxn(base), { sent: 1, failed: 1 });
});

test('notifyError dedupes per day', async () => {
  const fetch = fakeFetch();
  const n = createNotifier(cfg({ ntfy: NTFY }), { fetch });
  assert.equal((await n.notifyError('הפועלים', 'fail')).sent, 1);
  assert.equal((await n.notifyError('הפועלים', 'fail')).sent, 0);
  assert.equal((await n.notifyError('הפועלים', 'other')).sent, 1);
  assert.equal(fetch.calls.length, 2);
});

test('notifySummary and sendRaw', async () => {
  const fetch = fakeFetch();
  const n = createNotifier(cfg({ ntfy: NTFY }), { fetch });
  assert.equal((await n.notifySummary([base, base], 'הפועלים')).sent, 1);
  assert.equal((await n.notifySummary([], 'x')).sent, 0);
  assert.equal((await n.sendRaw('t', 'b')).sent, 1);
});

test('formatTxn privacy mode: title has amount + category only, no merchant anywhere', () => {
  const f = formatTxn(base, { privacy: true });
  assert.equal(f.title, '💳 ₪123.45 · מזון');
  assert.doesNotMatch(f.title + f.body, /שופרסל/);
  const g = formatTxn({ ...base, category: null }, { privacy: true });
  assert.equal(g.title, '💳 ₪123.45 · ללא קטגוריה');
});

test('formatTxn English: translated category, source, pending, installments', () => {
  const f = formatTxn({ ...base, category: 'מזון וסופר', installmentNumber: 2, installmentTotal: 3, status: 'pending' }, { lang: 'en' });
  assert.equal(f.title, '💳 ₪123.45 · שופרסל');
  assert.match(f.body, /Isracard • 4567/);
  assert.match(f.body, /Groceries/);
  assert.match(f.body, /Installment 2\/3/);
  assert.match(f.body, /Pending/);
  assert.doesNotMatch(f.body, /[\u0590-\u05FF]/);
  const p = formatTxn({ ...base, category: 'מזון וסופר' }, { lang: 'en', privacy: true });
  assert.equal(p.title, '💳 ₪123.45 · Groceries');
});

test('formatSummary English + privacy hides merchants', () => {
  const t = formatSummary([{ ...base, category: 'מזון וסופר' }, { ...base, amount: 500, description: 'משכורת', category: 'משכורת' }], { lang: 'en', privacy: true });
  assert.match(t, /^2 new transactions/);
  assert.match(t, /Expenses: ₪123\.45/);
  assert.match(t, /Income: ₪500\.00/);
  assert.match(t, /• Groceries -₪123\.45/);
  assert.match(t, /• Salary \+₪500\.00/);
  assert.doesNotMatch(t, /שופרסל|משכורת/);
});

test('notifier applies NOTIFY_LANG / NOTIFY_PRIVACY from config', async () => {
  const fetch = fakeFetch();
  const n = createNotifier(cfg({ ntfy: NTFY, notifyLang: 'en', notifyPrivacy: true }), { fetch });
  await n.notifyTxn(base);
  const sent = JSON.stringify(fetch.calls[0].init);
  assert.doesNotMatch(sent, /שופרסל/);
});

test('loadConfig reads NOTIFY_LANG, NOTIFY_PRIVACY and ACCESSIBILITY_CONTACT', async () => {
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig({ NOTIFY_LANG: 'en', NOTIFY_PRIVACY: '1', ACCESSIBILITY_CONTACT: ' me@x.io ' }, []);
  assert.equal(c.notifyLang, 'en');
  assert.equal(c.notifyPrivacy, true);
  assert.equal(c.accessibilityContact, 'me@x.io');
  const d = loadConfig({ NOTIFY_LANG: 'fr' }, []);
  assert.equal(d.notifyLang, 'he');
  assert.equal(d.notifyPrivacy, false);
  assert.equal(d.accessibilityContact, '');
});
