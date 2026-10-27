import express from 'express';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { SOURCE_LABELS } from './normalize.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CHART_JS = path.join(path.dirname(createRequire(import.meta.url).resolve('chart.js')), 'chart.umd.js');

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const SOURCE_RE = /^[A-Za-z]{1,32}$/;
const MAX_LIMIT = 500;
const MAX_TEXT = 100;

class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' → { from: 'YYYY-MM-01', to: first day of next month } or null if invalid. */
export function monthRange(month) {
  const m = MONTH_RE.exec(String(month ?? ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  return { from: `${m[1]}-${m[2]}-01`, to: `${next}-01` };
}

function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function optText(value, name) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new BadRequest(`invalid ${name}`);
  return value.trim() || undefined;
}

function optDate(value, name) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new BadRequest(`invalid ${name}`);
  return value;
}

function optInt(value, name, { min, max, fallback }) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new BadRequest(`invalid ${name}`);
  const n = Number(value);
  if (n < min) throw new BadRequest(`invalid ${name}`);
  return Math.min(n, max);
}

function parseTxnQuery(q) {
  const direction = optText(q.direction, 'direction');
  if (direction && !['in', 'out', 'all'].includes(direction)) throw new BadRequest('invalid direction');
  const source = optText(q.source, 'source');
  if (source && !SOURCE_RE.test(source)) throw new BadRequest('invalid source');
  return {
    from: optDate(q.from, 'from'),
    to: optDate(q.to, 'to'),
    source,
    category: optText(q.category, 'category'),
    q: optText(q.q, 'q'),
    direction: direction === 'all' ? undefined : direction,
    limit: optInt(q.limit, 'limit', { min: 1, max: MAX_LIMIT, fallback: 50 }),
    offset: optInt(q.offset, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
  };
}

const CSV_PAGE = 1000;
const CSV_COLUMNS = [
  ['date', 'תאריך', 'Date'],
  ['processedDate', 'תאריך חיוב', 'Charge date'],
  ['description', 'תיאור', 'Description'],
  ['amount', 'סכום', 'Amount'],
  ['currency', 'מטבע', 'Currency'],
  ['originalAmount', 'סכום מקורי', 'Original amount'],
  ['originalCurrency', 'מטבע מקורי', 'Original currency'],
  ['category', 'קטגוריה', 'Category'],
  ['source', 'מקור', 'Source'],
  ['accountNumber', 'חשבון', 'Account'],
  ['status', 'סטטוס', 'Status'],
  ['installment', 'תשלום', 'Installment'],
  ['memo', 'הערה', 'Note'],
];
const NUMERIC = new Set(['amount', 'originalAmount']);
const CSV_STATUS = { he: { pending: 'ממתין', completed: 'נקלט' }, en: { pending: 'Pending', completed: 'Posted' } };

function csvCell(value, key) {
  if (value == null) return '';
  let s = String(value);
  // Neutralise spreadsheet formulas in free-text fields (CSV injection); numbers keep their sign.
  if (!NUMERIC.has(key) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text with a UTF-8 BOM so Excel opens Hebrew correctly. */
export function transactionsCsv(rows, lang = 'he') {
  const col = lang === 'en' ? 2 : 1;
  const lines = [CSV_COLUMNS.map((c) => csvCell(c[col], 'header')).join(',')];
  for (const t of rows) {
    const rec = {
      ...t,
      date: String(t.date || '').slice(0, 10),
      processedDate: t.processedDate ? String(t.processedDate).slice(0, 10) : '',
      source: lang === 'en' ? t.source : (SOURCE_LABELS[t.source] || t.source),
      installment: t.installmentTotal ? `${t.installmentNumber ?? '?'}/${t.installmentTotal}` : '',
      status: CSV_STATUS[lang][t.status] || t.status,
    };
    lines.push(CSV_COLUMNS.map(([key]) => csvCell(rec[key], key)).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Build the Express app. Does not listen — callers bind it (on 127.0.0.1).
 * syncer: { run(): Promise, isRunning(): boolean } | null
 */
export function createApp({ db, syncer = null, config = {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  // Phone access goes through `tailscale serve` (HTTPS reverse proxy on localhost).
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/overview', (req, res) => {
    const month = req.query.month == null || req.query.month === '' ? currentMonth() : req.query.month;
    const range = monthRange(month);
    if (!range) throw new BadRequest('invalid month (expected YYYY-MM)');
    const prevRange = monthRange(prevMonth(month));
    const [y, m] = month.split('-').map(Number);
    const spend = db.accountSpend(range);
    res.json({
      month,
      summary: db.summary(range),
      prevSummary: db.summary(prevRange),
      accounts: db.listAccounts().map((a) => ({ ...a, monthSpend: spend[a.id] ?? 0 })),
      monthly: db.monthly(12, new Date(Date.UTC(y, m - 1, 15))),
      categories: db.categories(range),
      daily: db.daily(range),
      prevDaily: db.daily(prevRange),
      recurring: db.listRecurring(),
      syncRuns: db.lastSyncRuns(10),
      demo: Boolean(config.demo),
      syncing: Boolean(syncer?.isRunning?.()),
      canSync: Boolean(syncer) && !config.demo,
      sourceLabels: SOURCE_LABELS,
    });
  });

  app.get('/api/transactions', (req, res) => {
    res.json(db.listTransactions(parseTxnQuery(req.query)));
  });

  // Same filters as /api/transactions, but every matching row (no paging), as an Excel-friendly CSV.
  app.get('/api/transactions.csv', (req, res) => {
    const filter = parseTxnQuery(req.query);
    const lang = req.query.lang === 'en' ? 'en' : 'he';
    const rows = [];
    for (let offset = 0; ; offset += CSV_PAGE) {
      const page = db.listTransactions({ ...filter, limit: CSV_PAGE, offset });
      rows.push(...page.rows);
      if (page.rows.length < CSV_PAGE || rows.length >= page.total) break;
    }
    const name = `dashbank-${filter.from ? filter.from.slice(0, 7) : 'all'}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    res.send(transactionsCsv(rows, lang));
  });

  // Non-sensitive settings the static pages (legal, login) need before any sign-in.
  app.get('/api/public-config', (req, res) => {
    res.json({ accessibilityContact: config.accessibilityContact || null });
  });

  app.post('/api/sync', (req, res) => {
    if (config.demo || !syncer) return res.status(400).json({ error: 'הסנכרון אינו זמין במצב הדגמה' });
    if (syncer.isRunning()) return res.status(409).json({ error: 'סנכרון כבר רץ' });
    Promise.resolve()
      .then(() => syncer.run())
      .catch((err) => log.error('manual sync failed', { error: err?.message }));
    res.status(202).json({ started: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  app.get('/vendor/chart.umd.js', (req, res, next) => {
    res.type('application/javascript');
    res.sendFile(CHART_JS, (err) => err && next(err));
  });

  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    maxAge: 0,
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === 'sw.js') res.set({ 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' });
      else if (base.endsWith('.webmanifest')) res.type('application/manifest+json');
    },
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.status === 400 || err?.status === 404) {
      return res.status(err.status).json({ error: err.status === 400 ? err.message : 'not found' });
    }
    log.error('request failed', { method: req.method, path: req.path, error: err?.message });
    res.status(500).json({ error: 'internal' });
  });

  return app;
}
