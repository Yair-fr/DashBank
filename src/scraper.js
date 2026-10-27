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

// Human-readable Hebrew explanations for israeli-bank-scrapers error types.
export const ERROR_MESSAGES_HE = {
  INVALID_PASSWORD: 'סיסמה שגויה — עדכן אותה ב-npm run setup',
  CHANGE_PASSWORD: 'המוסד דורש להחליף סיסמה — היכנס ידנית לאתר',
  ACCOUNT_BLOCKED: 'החשבון חסום — היכנס ידנית לאתר',
  TIMEOUT: 'האתר לא הגיב בזמן — ננסה שוב בסנכרון הבא',
  TWO_FACTOR_RETRIEVER_MISSING: 'המוסד דורש קוד אימות (OTP) — לא נתמך בכניסה אוטומטית',
  GENERIC: 'שגיאה כללית בסנכרון — ננסה שוב בסנכרון הבא',
  GENERAL_ERROR: 'שגיאה כללית בסנכרון — ננסה שוב בסנכרון הבא',
};

export const describeError = (errorType, fallback) => ERROR_MESSAGES_HE[errorType] || fallback || ERROR_MESSAGES_HE.GENERIC;

/**
 * Scrape one vault account. Never throws.
 * returns { ok, accounts: [{ accountNumber, balance, txns }], error?, errorType? }
 */
export async function scrapeAccount(account, {
  startDate, createScraper = defaultCreateScraper, showBrowser = false, timeoutMs = 120000, failureDir = null,
} = {}) {
  const options = { companyId: account.companyId, startDate, combineInstallments: false, showBrowser, verbose: false };
  // Containers (Docker) run Chromium without a user namespace sandbox.
  if (process.env.DASHBANK_CHROMIUM_NO_SANDBOX === '1') options.args = ['--no-sandbox', '--disable-dev-shm-usage'];
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
