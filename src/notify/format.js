import { readFileSync } from 'node:fs';
import { SOURCE_LABELS } from '../normalize.js';

// English display names come from the dashboard's locale file so there is one translation source.
const EN = JSON.parse(readFileSync(new URL('../../public/locales/en.json', import.meta.url), 'utf8'));

const STRINGS = {
  he: {
    installment: (n, total) => `תשלום ${n}/${total}`,
    pending: '⏳ ממתין לאישור',
    newCount: (n) => `${n} תנועות חדשות`,
    expenses: 'הוצאות',
    income: 'הכנסות',
    noCategory: 'ללא קטגוריה',
  },
  en: {
    installment: (n, total) => `Installment ${n}/${total}`,
    pending: '⏳ Pending',
    newCount: (n) => (n === 1 ? '1 new transaction' : `${n} new transactions`),
    expenses: 'Expenses',
    income: 'Income',
    noCategory: 'Uncategorized',
  },
};

// en-IL yields "₪123.45" (he-IL puts the symbol after the number with bidi marks).
const ils = new Intl.NumberFormat('en-IL', { style: 'currency', currency: 'ILS' });
const dateFmt = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function money(amount, currency = 'ILS') {
  if (currency === 'ILS') return ils.format(amount);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(dateFmt.formatToParts(d).map((x) => [x.type, x.value]));
  const day = `${p.day}/${p.month}`;
  return p.hour === '00' && p.minute === '00' ? day : `${day} ${p.hour}:${p.minute}`;
}

const pick = (lang) => (lang === 'en' ? 'en' : 'he');
const category = (name, lang) => (lang === 'en' ? EN.categories?.[name] || name : name);
const sourceLabel = (source, lang) => (lang === 'en' ? EN.sources?.[source] : SOURCE_LABELS[source]) || source;

/**
 * opts.lang: 'he' (default) | 'en'.
 * opts.privacy: true → the title (what a lock screen shows) carries amount + category only, never the merchant.
 */
export function formatTxn(txn, { lang = 'he', privacy = false } = {}) {
  lang = pick(lang);
  const S = STRINGS[lang];
  const incoming = txn.amount > 0;
  const abs = Math.abs(txn.amount);
  const amt = money(abs, 'ILS');
  const cat = txn.category ? category(txn.category, lang) : '';
  const subject = privacy ? (cat || S.noCategory) : txn.description;
  const title = incoming ? `💰 +${amt} · ${subject}` : `💳 ${amt} · ${subject}`;
  const lines = [];
  const label = sourceLabel(txn.source, lang);
  const last4 = txn.accountNumber ? String(txn.accountNumber).slice(-4) : '';
  lines.push(last4 ? `${label} • ${last4}` : label);
  if (cat && !privacy) lines.push(cat);
  const when = formatDate(txn.date);
  if (when) lines.push(when);
  if (txn.installmentNumber && txn.installmentTotal) lines.push(S.installment(txn.installmentNumber, txn.installmentTotal));
  if (txn.originalCurrency && txn.originalCurrency !== (txn.currency || 'ILS') && txn.originalAmount != null) {
    lines.push(`(${money(Math.abs(txn.originalAmount), txn.originalCurrency)})`);
  }
  if (txn.status === 'pending') lines.push(S.pending);
  return {
    title,
    body: lines.join('\n'),
    tags: [incoming ? 'moneybag' : 'credit_card'],
    priority: abs >= 1000 ? 4 : 3,
  };
}

export function formatSummary(newTxns, { lang = 'he', privacy = false } = {}) {
  lang = pick(lang);
  const S = STRINGS[lang];
  const out = newTxns.filter((t) => t.amount < 0).reduce((s, t) => s + -t.amount, 0);
  const inn = newTxns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const lines = [S.newCount(newTxns.length), `${S.expenses}: ${money(out)}`, `${S.income}: ${money(inn)}`];
  const top = [...newTxns].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5);
  if (top.length) {
    lines.push('');
    for (const t of top) {
      const name = privacy ? (t.category ? category(t.category, lang) : S.noCategory) : t.description;
      lines.push(`• ${name} ${t.amount > 0 ? '+' : '-'}${money(Math.abs(t.amount))}`);
    }
  }
  return lines.join('\n');
}
