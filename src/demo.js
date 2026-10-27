// Deterministic demo dataset: six months of a young Israeli professional / 2nd-year
// student with a Hapoalim checking account and three credit cards.
import { normalizeTxn, SOURCE_LABELS } from './normalize.js';
import { categorize } from './categorize.js';
import { detectRecurring } from './recurring.js';

const MONTHS = 6;
const HOUR_MS = 3600000;
const SEED = 0xda5b4e;

const ACCOUNTS = {
  hapoalim: { accountNumber: '12-689-458213', balance: 18450.32 },
  isracard: { accountNumber: '4580', balance: null },
  visaCal: { accountNumber: '7712', balance: null },
  max: { accountNumber: '3391', balance: null },
};

// Bank-side card bill: description and debit day of month.
const SETTLEMENTS = [
  { card: 'isracard', description: 'ישראכרט', day: 2 },
  { card: 'visaCal', description: 'כאל', day: 10 },
  { card: 'max', description: 'מקס', day: 15 },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedDemo(db, { now = new Date() } = {}) {
  const rand = mulberry32(SEED);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const money = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 10) / 10; // prices end in .x0
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const nowMs = now.getTime();
  const raws = { hapoalim: [], isracard: [], visaCal: [], max: [] };
  const cardTotals = {}; // `${source}|YYYY-MM` -> agorot (completed charges only)
  let seq = 0;

  const dateOf = (y, m, d) => new Date(Date.UTC(y, m, d, 10)).toISOString();

  function add(source, { date, amount, description, memo = null, status = 'completed', installments, originalAmount, originalCurrency = 'ILS' }) {
    if (new Date(date).getTime() > nowMs) return;
    seq += 1;
    raws[source].push({
      type: installments ? 'installments' : 'normal',
      identifier: 700000000 + seq * 37,
      date,
      processedDate: date,
      originalAmount: originalAmount ?? amount,
      originalCurrency,
      chargedAmount: amount,
      chargedCurrency: 'ILS',
      description,
      memo,
      status,
      installments,
    });
    if (source !== 'hapoalim' && status === 'completed') {
      const key = `${source}|${date.slice(0, 7)}`;
      cardTotals[key] = (cardTotals[key] || 0) + Math.round(amount * 100);
    }
  }

  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1), 1));
  const ksp = { total: 5388, count: 12, startIndex: 1, day: 14 };

  for (let i = 0; i < MONTHS; i++) {
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth() + i;
    const first = new Date(Date.UTC(y, m, 1));
    const month = first.getUTCMonth();
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = () => int(1, dim);
    const at = (d) => dateOf(y, m, d);

    // --- Bank (Hapoalim) ---
    add('hapoalim', { date: at(1), amount: -5200, description: 'הוראת קבע - שכר דירה' });
    add('hapoalim', { date: at(3), amount: -123, description: 'הוראת קבע - ביטוח לאומי' });
    add('hapoalim', { date: at(5), amount: -150, description: 'הוראת קבע - ועד בית' });
    add('hapoalim', { date: at(10), amount: 14200, description: 'משכורת - אורבית טכנולוגיות בע"מ' });
    // Bar-Ilan tuition: 10 payments, October through July.
    if (month !== 7 && month !== 8) {
      const payment = ((month + 3) % 12) + 1;
      add('hapoalim', { date: at(20), amount: -1180, description: 'הוראת קבע - אוניברסיטת בר-אילן', memo: `שכר לימוד - תשלום ${payment} מתוך 10` });
    }
    add('hapoalim', { date: at(day()), amount: -pick([200, 300, 400]), description: 'משיכה מכספומט' });
    add('hapoalim', { date: at(day()), amount: money(90, 260), description: 'העברה מ-bit - שותף לדירה', memo: 'חשבונות' });
    for (let k = int(1, 2); k > 0; k--) add('hapoalim', { date: at(day()), amount: -money(40, 180), description: 'העברה ב-bit' });
    if (i > 0) {
      const prev = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 7);
      for (const s of SETTLEMENTS) {
        const agorot = cardTotals[`${s.card}|${prev}`] || 0;
        if (agorot) add('hapoalim', { date: at(s.day), amount: agorot / 100, description: s.description });
      }
    }

    // --- Isracard: groceries, delivery, subscriptions, phone ---
    for (let k = int(6, 9); k > 0; k--) {
      add('isracard', { date: at(day()), amount: -money(65, 420), description: pick(['שופרסל דיל', 'רמי לוי שיווק השקמה', 'שופרסל שלי', 'רמי לוי']) });
    }
    for (let k = int(3, 6); k > 0; k--) add('isracard', { date: at(day()), amount: -money(48, 145), description: 'וולט' });
    add('isracard', { date: at(5), amount: -54.9, description: 'NETFLIX.COM' });
    add('isracard', { date: at(12), amount: -19.9, description: 'SPOTIFY' });
    add('isracard', { date: at(20), amount: -49, description: 'סלקום ישראל בע"מ' });

    // --- Cal: transport, cafes, electricity, insurance, pharmacy ---
    for (let k = int(1, 2); k > 0; k--) add('visaCal', { date: at(day()), amount: -money(120, 260), description: pick(['פז ילו', 'סונול', 'דור אלון']) });
    for (let k = 2; k > 0; k--) add('visaCal', { date: at(day()), amount: -pick([50, 100, 112.5]), description: 'רב קו - טעינה' });
    for (let k = int(2, 4); k > 0; k--) add('visaCal', { date: at(day()), amount: -money(18, 48), description: 'ארומה' });
    if (month % 2 === 0) add('visaCal', { date: at(18), amount: -money(260, 430), description: 'חברת החשמל לישראל' });
    add('visaCal', { date: at(8), amount: -89.9, description: 'הראל חברה לביטוח' });
    for (let k = int(0, 2); k > 0; k--) add('visaCal', { date: at(day()), amount: -money(30, 160), description: 'סופר-פארם' });

    // --- Max: eating out, shopping, gym, one installment purchase, one USD purchase ---
    for (let k = int(1, 3); k > 0; k--) add('max', { date: at(day()), amount: -money(45, 180), description: pick(['קפה גרג', 'דומינו פיצה', 'מקדונלדס', 'תן ביס']) });
    for (let k = int(0, 2); k > 0; k--) add('max', { date: at(day()), amount: -money(80, 350), description: pick(['זארה', 'H&M', 'ALIEXPRESS', 'איקאה']) });
    if (rand() < 0.5) add('max', { date: at(day()), amount: -money(70, 110), description: 'סינמה סיטי' });
    add('max', { date: at(3), amount: -199, description: 'HOLMES PLACE' });
    if (i >= ksp.startIndex) {
      const number = i - ksp.startIndex + 1;
      add('max', {
        date: at(ksp.day), amount: -(ksp.total / ksp.count), originalAmount: -ksp.total,
        description: 'KSP מחשבים', memo: `תשלום ${number} מתוך ${ksp.count}`, installments: { number, total: ksp.count },
      });
    }
    if (i === 2) {
      add('max', { date: at(22), amount: -157.77, originalAmount: -42.99, originalCurrency: 'USD', description: 'AMAZON.COM' });
    }
  }

  // Two pending charges from the last two days.
  add('isracard', { date: new Date(nowMs - 30 * HOUR_MS).toISOString(), amount: -money(60, 130), description: 'וולט', status: 'pending' });
  add('isracard', { date: new Date(nowMs - 5 * HOUR_MS).toISOString(), amount: -money(120, 380), description: 'שופרסל אונליין', status: 'pending' });

  // --- Persist ---
  const startedAt = new Date(nowMs - 2 * 60000).toISOString();
  let inserted = 0;
  for (const [source, list] of Object.entries(raws)) {
    const { accountNumber, balance } = ACCOUNTS[source];
    db.upsertAccount({ source, accountNumber, label: SOURCE_LABELS[source], balance, balanceDate: balance != null ? now.toISOString() : null });
    const txns = list.map((raw) => {
      const t = normalizeTxn(raw, { source, accountNumber });
      t.category = categorize(t.description, { source, amount: t.amount });
      return t;
    });
    const fresh = db.insertTransactions(txns);
    inserted += fresh.length;
    db.logSyncRun({ startedAt, finishedAt: new Date(nowMs - 60000).toISOString(), source, label: SOURCE_LABELS[source], ok: true, newCount: fresh.length });
  }

  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, now.getUTCDate())).toISOString();
  const recurring = detectRecurring(db.allTransactionsSince(since), { now });
  db.saveRecurring(recurring);

  return { inserted, accounts: Object.keys(ACCOUNTS).length, recurring: recurring.length };
}
