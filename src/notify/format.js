import { SOURCE_LABELS } from '../normalize.js';

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

export function formatTxn(txn) {
  const incoming = txn.amount > 0;
  const abs = Math.abs(txn.amount);
  const amt = money(abs, 'ILS');
  const title = incoming ? `💰 +${amt} · ${txn.description}` : `💳 ${amt} · ${txn.description}`;
  const lines = [];
  const label = SOURCE_LABELS[txn.source] || txn.source;
  const last4 = txn.accountNumber ? String(txn.accountNumber).slice(-4) : '';
  lines.push(last4 ? `${label} • ${last4}` : label);
  if (txn.category) lines.push(txn.category);
  const when = formatDate(txn.date);
  if (when) lines.push(when);
  if (txn.installmentNumber && txn.installmentTotal) lines.push(`תשלום ${txn.installmentNumber}/${txn.installmentTotal}`);
  if (txn.originalCurrency && txn.originalCurrency !== (txn.currency || 'ILS') && txn.originalAmount != null) {
    lines.push(`(${money(Math.abs(txn.originalAmount), txn.originalCurrency)})`);
  }
  if (txn.status === 'pending') lines.push('⏳ ממתין לאישור');
  return {
    title,
    body: lines.join('\n'),
    tags: [incoming ? 'moneybag' : 'credit_card'],
    priority: abs >= 1000 ? 4 : 3,
  };
}

export function formatSummary(newTxns) {
  const out = newTxns.filter((t) => t.amount < 0).reduce((s, t) => s + -t.amount, 0);
  const inn = newTxns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const lines = [`${newTxns.length} תנועות חדשות`, `הוצאות: ${money(out)}`, `הכנסות: ${money(inn)}`];
  const top = [...newTxns].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5);
  if (top.length) {
    lines.push('');
    for (const t of top) lines.push(`• ${t.description} ${t.amount > 0 ? '+' : '-'}${money(Math.abs(t.amount))}`);
  }
  return lines.join('\n');
}
