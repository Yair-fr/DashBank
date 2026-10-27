import path from 'node:path';
import { scrapeAccount, describeError } from './scraper.js';
import { normalizeTxn } from './normalize.js';
import { categorize } from './categorize.js';
import { detectRecurring } from './recurring.js';
import { log } from './log.js';

const DAY_MS = 86400000;
const INCREMENTAL_DAYS = 45;
const RECURRING_LOOKBACK_MONTHS = 13;

function monthsAgo(date, n) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

/** node-cron expression for an interval in minutes (minute field max 59, otherwise hourly). */
export function cronExpression(minutes) {
  const n = Math.max(1, Math.floor(Number(minutes) || 0));
  return n >= 60 ? '0 * * * *' : `*/${n} * * * *`;
}

async function safely(what, fn) {
  try {
    return await fn();
  } catch (e) {
    log.warn(`${what} failed`, { error: e.message });
    return null;
  }
}

export function createSyncer({ db, config, getAccounts, scrape = scrapeAccount, notifier, now = () => new Date() }) {
  let running = false;

  async function syncOne(account) {
    const startedAt = new Date().toISOString();
    const source = account.companyId;
    const label = account.label || source;
    const at = now();
    const hadPrior = db.hasTransactions(source);
    const startDate = hadPrior ? new Date(at.getTime() - INCREMENTAL_DAYS * DAY_MS) : monthsAgo(at, config.monthsBack);

    let res;
    try {
      res = await scrape(account, { startDate, failureDir: path.join(config.dataDir, 'failures') });
    } catch (e) {
      res = { ok: false, accounts: [], error: e?.message || String(e), errorType: 'GENERIC' };
    }

    if (!res?.ok) {
      const error = res?.error || res?.errorType || 'scrape failed';
      db.logSyncRun({ startedAt, source, label, ok: false, newCount: 0, error });
      if (notifier) await safely('notifyError', () => notifier.notifyError(label, describeError(res?.errorType, error)));
      return { label, ok: false, newCount: 0, error };
    }

    let fresh = [];
    try {
      for (const acct of res.accounts || []) {
        db.upsertAccount({ source, accountNumber: acct.accountNumber, label, balance: acct.balance ?? null, balanceDate: acct.balance != null ? at.toISOString() : null });
        const txns = (acct.txns || []).map((raw) => {
          const t = normalizeTxn(raw, { source, accountNumber: acct.accountNumber });
          if (t.category == null) t.category = categorize(t.description, { source, amount: t.amount });
          return t;
        });
        fresh = fresh.concat(db.insertTransactions(txns));
      }
    } catch (e) {
      const error = e.message;
      db.logSyncRun({ startedAt, source, label, ok: false, newCount: fresh.length, error });
      if (notifier) await safely('notifyError', () => notifier.notifyError(label, error));
      return { label, ok: false, newCount: fresh.length, error };
    }

    db.logSyncRun({ startedAt, source, label, ok: true, newCount: fresh.length });
    log.info('account synced', { source, label, newCount: fresh.length });

    if (notifier && fresh.length) {
      if (!hadPrior) {
        await safely('notifySummary', () => notifier.notifySummary(fresh, label));
      } else {
        const ordered = [...fresh].sort((a, b) => new Date(a.date) - new Date(b.date));
        for (const t of ordered) await safely('notifyTxn', () => notifier.notifyTxn(t));
      }
    }
    return { label, ok: true, newCount: fresh.length, error: null };
  }

  async function run() {
    if (running) return { skipped: true };
    running = true;
    try {
      const startedAt = new Date().toISOString();
      const accounts = await getAccounts();
      const results = [];
      for (const account of accounts) results.push(await syncOne(account));

      await safely('recurring detection', () => {
        const at = now();
        const since = monthsAgo(at, RECURRING_LOOKBACK_MONTHS).toISOString();
        db.saveRecurring(detectRecurring(db.allTransactionsSince(since), { now: at }));
      });

      return { startedAt, finishedAt: new Date().toISOString(), results };
    } finally {
      running = false;
    }
  }

  return { run, isRunning: () => running };
}
