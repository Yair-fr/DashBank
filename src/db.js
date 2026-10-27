import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Bank-side debits that settle a credit card bill. The individual card charges are
// already tracked from the card itself, so these are excluded from income/expense
// totals to avoid counting every purchase twice. They still affect the bank balance.
export const CARD_SETTLEMENT_CATEGORY = 'חיוב כרטיס אשראי';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  account_number TEXT NOT NULL,
  label TEXT,
  balance REAL,
  balance_date TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  hash TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  account_number TEXT NOT NULL,
  identifier TEXT,
  date TEXT NOT NULL,
  processed_date TEXT,
  amount REAL NOT NULL,
  currency TEXT,
  original_amount REAL,
  original_currency TEXT,
  description TEXT NOT NULL,
  memo TEXT,
  category TEXT,
  status TEXT NOT NULL,
  installment_number INTEGER,
  installment_total INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_source ON transactions(source);
CREATE TABLE IF NOT EXISTS recurring (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  source TEXT,
  avg_amount REAL NOT NULL,
  cadence TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_date TEXT,
  next_date TEXT,
  kind TEXT
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source TEXT NOT NULL,
  label TEXT,
  ok INTEGER NOT NULL,
  new_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
`;

const TXN_COLUMNS = `hash, source, account_number AS accountNumber, identifier, date,
  processed_date AS processedDate, amount, currency, original_amount AS originalAmount,
  original_currency AS originalCurrency, description, memo, category, status,
  installment_number AS installmentNumber, installment_total AS installmentTotal,
  created_at AS createdAt`;

const plain = (row) => (row ? { ...row } : row);

function rangeWhere({ from, to } = {}, params) {
  const parts = [];
  if (from) { parts.push('date >= :from'); params.from = from; }
  if (to) { parts.push('date < :to'); params.to = to; }
  return parts;
}

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const stmts = {
    upsertAccount: db.prepare(`INSERT INTO accounts (id, source, account_number, label, balance, balance_date, updated_at)
      VALUES (:id, :source, :accountNumber, :label, :balance, :balanceDate, :updatedAt)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label,
        balance = COALESCE(excluded.balance, accounts.balance),
        balance_date = COALESCE(excluded.balance_date, accounts.balance_date),
        updated_at = excluded.updated_at`),
    getTxnStatus: db.prepare('SELECT status FROM transactions WHERE hash = ?'),
    insertTxn: db.prepare(`INSERT INTO transactions (hash, source, account_number, identifier, date, processed_date,
      amount, currency, original_amount, original_currency, description, memo, category, status,
      installment_number, installment_total, created_at)
      VALUES (:hash, :source, :accountNumber, :identifier, :date, :processedDate, :amount, :currency,
      :originalAmount, :originalCurrency, :description, :memo, :category, :status,
      :installmentNumber, :installmentTotal, :createdAt)`),
    completeTxn: db.prepare(`UPDATE transactions SET status = 'completed', processed_date = COALESCE(:processedDate, processed_date) WHERE hash = :hash`),
    countBySource: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE source = ?'),
    insertRun: db.prepare(`INSERT INTO sync_runs (started_at, finished_at, source, label, ok, new_count, error)
      VALUES (:startedAt, :finishedAt, :source, :label, :ok, :newCount, :error)`),
  };

  function upsertAccount({ source, accountNumber, label = null, balance = null, balanceDate = null }) {
    stmts.upsertAccount.run({
      id: `${source}:${accountNumber}`, source, accountNumber: String(accountNumber), label,
      balance: balance ?? null, balanceDate: balanceDate ?? null, updatedAt: new Date().toISOString(),
    });
  }

  /** Insert transactions; returns only the ones that were not seen before. */
  function insertTransactions(txns) {
    const fresh = [];
    const createdAt = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const t of txns) {
        const existing = stmts.getTxnStatus.get(t.hash);
        if (!existing) {
          stmts.insertTxn.run({
            hash: t.hash, source: t.source, accountNumber: t.accountNumber, identifier: t.identifier ?? null,
            date: t.date, processedDate: t.processedDate ?? null, amount: t.amount, currency: t.currency ?? 'ILS',
            originalAmount: t.originalAmount ?? t.amount, originalCurrency: t.originalCurrency ?? 'ILS',
            description: t.description, memo: t.memo ?? null, category: t.category ?? null, status: t.status,
            installmentNumber: t.installmentNumber ?? null, installmentTotal: t.installmentTotal ?? null, createdAt,
          });
          fresh.push(t);
        } else if (existing.status === 'pending' && t.status === 'completed') {
          stmts.completeTxn.run({ hash: t.hash, processedDate: t.processedDate ?? null });
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return fresh;
  }

  function hasTransactions(source) {
    return stmts.countBySource.get(source).n > 0;
  }

  function listAccounts() {
    return db.prepare(`SELECT id, source, account_number AS accountNumber, label, balance,
      balance_date AS balanceDate, updated_at AS updatedAt FROM accounts ORDER BY source`).all().map(plain);
  }

  /**
   * filter: { from, to, source, category, q, direction: 'in'|'out', limit, offset }
   * returns { rows, total }
   */
  function listTransactions(filter = {}) {
    const params = {};
    const where = rangeWhere(filter, params);
    if (filter.source) { where.push('source = :source'); params.source = filter.source; }
    if (filter.category === 'אחר') where.push("(category IS NULL OR category = 'אחר')");
    else if (filter.category) { where.push('category = :category'); params.category = filter.category; }
    if (filter.q) { where.push('(description LIKE :q OR memo LIKE :q)'); params.q = `%${filter.q}%`; }
    if (filter.direction === 'in') where.push('amount > 0');
    if (filter.direction === 'out') where.push('amount < 0');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 1000);
    const offset = Math.max(Number(filter.offset) || 0, 0);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions ${clause}`).get(params).n;
    const rows = db.prepare(`SELECT ${TXN_COLUMNS} FROM transactions ${clause}
      ORDER BY date DESC, created_at DESC LIMIT ${limit} OFFSET ${offset}`).all(params).map(plain);
    return { rows, total };
  }

  /** Income/expense totals for a date range, excluding card-bill settlements. */
  function summary(range = {}) {
    const params = { settle: CARD_SETTLEMENT_CATEGORY };
    const where = rangeWhere(range, params);
    where.push("COALESCE(category, '') != :settle");
    const r = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS expense,
        COUNT(*) AS count
      FROM transactions WHERE ${where.join(' AND ')}`).get(params);
    const balances = db.prepare("SELECT COALESCE(SUM(balance), 0) AS b FROM accounts WHERE balance IS NOT NULL").get();
    const pending = db.prepare("SELECT COALESCE(SUM(-amount), 0) AS p FROM transactions WHERE status = 'pending' AND amount < 0").get();
    const income = round(r.income);
    const expense = round(r.expense);
    return { income, expense, net: round(income - expense), count: r.count, balance: round(balances.b), pending: round(pending.p) };
  }

  /** Last n calendar months (oldest first) relative to `now`. */
  function monthly(n = 6, now = new Date()) {
    const months = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const rows = db.prepare(`SELECT substr(date, 1, 7) AS month,
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS income,
        COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END), 0) AS expense
      FROM transactions WHERE date >= :from AND COALESCE(category, '') != :settle
      GROUP BY month`).all({ from: `${months[0]}-01`, settle: CARD_SETTLEMENT_CATEGORY });
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    return months.map((m) => ({ month: m, income: round(byMonth.get(m)?.income ?? 0), expense: round(byMonth.get(m)?.expense ?? 0) }));
  }

  /** Expense totals by category for a range, largest first. */
  function categories(range = {}) {
    const params = { settle: CARD_SETTLEMENT_CATEGORY };
    const where = rangeWhere(range, params);
    where.push('amount < 0', "COALESCE(category, '') != :settle");
    return db.prepare(`SELECT COALESCE(category, 'אחר') AS category, ROUND(SUM(-amount), 2) AS total, COUNT(*) AS count
      FROM transactions WHERE ${where.join(' AND ')} GROUP BY 1 ORDER BY total DESC`).all(params).map(plain);
  }

  /** Expense per account for a range (used to show monthly card spend). Keyed by `${source}:${accountNumber}`. */
  function accountSpend(range = {}) {
    const params = { settle: CARD_SETTLEMENT_CATEGORY };
    const where = rangeWhere(range, params);
    where.push('amount < 0', "COALESCE(category, '') != :settle");
    const rows = db.prepare(`SELECT source || ':' || account_number AS id, ROUND(SUM(-amount), 2) AS spend
      FROM transactions WHERE ${where.join(' AND ')} GROUP BY 1`).all(params);
    return Object.fromEntries(rows.map((r) => [r.id, r.spend]));
  }

  /** Daily expense totals for a range (for cumulative spend charts). */
  function daily(range = {}) {
    const params = { settle: CARD_SETTLEMENT_CATEGORY };
    const where = rangeWhere(range, params);
    where.push('amount < 0', "COALESCE(category, '') != :settle");
    return db.prepare(`SELECT substr(date, 1, 10) AS day, ROUND(SUM(-amount), 2) AS expense
      FROM transactions WHERE ${where.join(' AND ')} GROUP BY day ORDER BY day`).all(params).map(plain);
  }

  /** All transactions since `from` (ascending) — input for recurring detection. */
  function allTransactionsSince(from) {
    return db.prepare(`SELECT ${TXN_COLUMNS} FROM transactions WHERE date >= ? ORDER BY date`).all(from).map(plain);
  }

  function saveRecurring(list) {
    const ins = db.prepare(`INSERT INTO recurring (key, description, source, avg_amount, cadence, count, last_date, next_date, kind)
      VALUES (:key, :description, :source, :avgAmount, :cadence, :count, :lastDate, :nextDate, :kind)`);
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM recurring');
      for (const r of list) {
        ins.run({ key: r.key, description: r.description, source: r.source ?? null, avgAmount: r.avgAmount,
          cadence: r.cadence, count: r.count, lastDate: r.lastDate ?? null, nextDate: r.nextDate ?? null, kind: r.kind ?? null });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function listRecurring() {
    return db.prepare(`SELECT key, description, source, avg_amount AS avgAmount, cadence, count,
      last_date AS lastDate, next_date AS nextDate, kind FROM recurring ORDER BY avg_amount ASC`).all().map(plain);
  }

  function logSyncRun({ startedAt, finishedAt, source, label = null, ok, newCount = 0, error = null }) {
    stmts.insertRun.run({ startedAt, finishedAt: finishedAt ?? new Date().toISOString(), source, label, ok: ok ? 1 : 0, newCount, error });
  }

  function lastSyncRuns(limit = 20) {
    return db.prepare(`SELECT id, started_at AS startedAt, finished_at AS finishedAt, source, label, ok, new_count AS newCount, error
      FROM sync_runs ORDER BY id DESC LIMIT ?`).all(limit).map((r) => ({ ...r, ok: Boolean(r.ok) }));
  }

  return {
    raw: db, upsertAccount, insertTransactions, hasTransactions, listAccounts, listTransactions,
    summary, monthly, categories, accountSpend, daily, allTransactionsSince, saveRecurring, listRecurring,
    logSyncRun, lastSyncRuns, close: () => db.close(),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
