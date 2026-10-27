import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

async function defaultCreateScraper(options) {
  const { createScraper } = await import('israeli-bank-scrapers');
  return createScraper(options);
}

/** Remove any credential value that a scraper may have echoed into an error message. */
function redact(message, credentials = {}) {
  let out = String(message ?? '');
  for (const v of Object.values(credentials)) {
    const s = v == null ? '' : String(v);
    if (s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}

/**
 * Scrape one vault account. Never throws.
 * returns { ok, accounts: [{ accountNumber, balance, txns }], error?, errorType? }
 */
export async function scrapeAccount(account, {
  startDate, createScraper = defaultCreateScraper, showBrowser = false, timeoutMs = 120000, failureDir = null,
} = {}) {
  const options = { companyId: account.companyId, startDate, combineInstallments: false, showBrowser, verbose: false };
  if (failureDir) {
    try { fs.mkdirSync(failureDir, { recursive: true }); } catch { /* screenshot is best-effort */ }
    options.storeFailureScreenShotPath = path.join(failureDir, `${account.companyId}-${Date.now()}.png`);
  }

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, accounts: [], error: `timeout after ${timeoutMs}ms`, errorType: 'TIMEOUT' }), timeoutMs);
  });

  const attempt = (async () => {
    const scraper = await createScraper(options);
    const res = await scraper.scrape(account.credentials);
    if (!res?.success) {
      return { ok: false, accounts: [], error: redact(res?.errorMessage || res?.errorType || 'scrape failed', account.credentials), errorType: res?.errorType || 'GENERIC' };
    }
    return {
      ok: true,
      accounts: (res.accounts || []).map((a) => ({ accountNumber: String(a.accountNumber ?? ''), balance: a.balance ?? null, txns: a.txns || [] })),
    };
  })().catch((e) => ({ ok: false, accounts: [], error: redact(e?.message || String(e), account.credentials), errorType: 'GENERIC' }));

  try {
    const result = await Promise.race([attempt, timeout]);
    if (!result.ok) log.warn('scrape failed', { companyId: account.companyId, errorType: result.errorType, error: result.error });
    return result;
  } finally {
    clearTimeout(timer);
  }
}
