import { createHash } from 'node:crypto';

export const SOURCE_LABELS = {
  hapoalim: 'בנק הפועלים',
  isracard: 'ישראכרט',
  visaCal: 'כאל',
  max: 'מקס',
  amex: 'אמריקן אקספרס',
  leumi: 'בנק לאומי',
  discount: 'דיסקונט',
  mizrahi: 'מזרחי טפחות',
};

export const BANK_SOURCES = new Set(['hapoalim', 'leumi', 'discount', 'mizrahi', 'mercantile', 'otsarHahayal', 'union', 'beinleumi', 'massad', 'yahav', 'oneZero']);

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

/**
 * Stable identity for a transaction. Status is deliberately excluded so a pending
 * transaction that later completes maps to the same row.
 */
export function txnHash(t) {
  const key = [t.source, t.accountNumber, t.identifier ?? '', day(t.date), round2(t.amount), (t.description || '').trim(), t.installmentNumber ?? ''].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Convert an israeli-bank-scrapers Transaction into DashBank's Txn shape. */
export function normalizeTxn(raw, { source, accountNumber }) {
  const amount = round2(raw.chargedAmount ?? raw.originalAmount ?? 0);
  const t = {
    source,
    accountNumber: String(accountNumber ?? ''),
    identifier: raw.identifier != null ? String(raw.identifier) : null,
    date: raw.date ? new Date(raw.date).toISOString() : new Date().toISOString(),
    processedDate: raw.processedDate ? new Date(raw.processedDate).toISOString() : null,
    amount,
    currency: raw.chargedCurrency || 'ILS',
    originalAmount: round2(raw.originalAmount ?? amount),
    originalCurrency: raw.originalCurrency || 'ILS',
    description: (raw.description || '').replace(/\s+/g, ' ').trim(),
    memo: raw.memo ? String(raw.memo).trim() : null,
    category: raw.category || null,
    status: raw.status === 'pending' ? 'pending' : 'completed',
    installmentNumber: raw.installments?.number ?? null,
    installmentTotal: raw.installments?.total ?? null,
  };
  t.hash = txnHash(t);
  return t;
}
