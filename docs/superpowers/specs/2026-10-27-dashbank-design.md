# DashBank — Personal Finance Tracker (Design)

## Goal
Track every shekel in/out of a Bank Hapoalim account and Isracard / Cal / Max credit cards,
detect standing orders & subscriptions, show a dynamic dashboard, and push a phone
notification (Telegram + ntfy) for every new charge.

## Constraints
- No public bank API for consumers in Israel → data comes from `israeli-bank-scrapers`
  (headless Chromium logging into the institution website with the user's credentials).
- Polling, not real-time: sync every `SYNC_INTERVAL_MINUTES` (default 30).
- Runs on the user's own computer. Server binds to `127.0.0.1` only.
- Credentials never stored in plaintext: AES-256-GCM vault, key derived with scrypt from a
  master passphrase (`DASHBANK_PASSPHRASE` env or interactive prompt).
- Node.js >= 22.13 (`node:sqlite` built-in, no native deps).

## Architecture
```
node-cron → sync.js → scraper.js (per account, isolated failures)
          → normalize + hash dedupe → db.js (SQLite)
          → categorize.js → recurring.js
          → notify/ (telegram.js, ntfy.js)  [suppressed on first backfill → single summary]
server.js (Express, 127.0.0.1) → /api/* → public/ (dashboard, Chart.js vendored from node_modules)
```

## Modules (interfaces)
| Module | Exports |
|---|---|
| `src/config.js` | `loadConfig()` → `{ port, syncIntervalMinutes, monthsBack, telegram:{token,chatId}, ntfy:{server,topic,token}, dataDir, demo }` |
| `src/db.js` | `openDb(path)` → `{ upsertAccount, insertTransactions(txns) → newTxns[], listTransactions(filter), summary(range), monthly(n), categories(range), saveRecurring(list), listRecurring(), logSyncRun(run), lastSyncRuns(), close }` |
| `src/vault.js` | `encryptVault(obj, pass)`, `decryptVault(buf, pass)`, `readVault(file, pass)`, `writeVault(file, obj, pass)` |
| `src/scraper.js` | `scrapeAccount(account, {startDate, scraperFactory})` → `{ ok, accounts:[{accountNumber,balance,txns}], error }` |
| `src/normalize.js` | `normalizeTxn(raw, {source, accountNumber})` → Txn; `txnHash(txn)` |
| `src/categorize.js` | `categorize(description, rules?)` → category string |
| `src/recurring.js` | `detectRecurring(txns, {now})` → `[{key, description, avgAmount, cadence, count, lastDate, nextDate, source, kind}]` |
| `src/notify/index.js` | `createNotifier(cfg, {fetch})` → `{ notifyTxn(txn), notifySummary(text), notifyError(text) }` |
| `src/sync.js` | `runSync({db, config, credentials, scrape, notifier, now})` → run report |
| `src/demo.js` | `seedDemo(db, {now})` — 6 months of realistic fake data |
| `src/server.js` | `createApp({db, onSyncNow})` |

### Txn shape
`{ hash, source, accountNumber, date, processedDate, amount (negative=out), currency,
originalAmount, originalCurrency, description, memo, category, status, installmentNumber,
installmentTotal, identifier }`

Hash = sha256(source|accountNumber|identifier||date-day|amount|description). Pending txns
that later complete with the same hash are updated, not duplicated.

## Notifications
- New outgoing txn: `💳 ₪123.45 · שופרסל · Max •1234 · מזון` (+ installments, foreign currency).
- Incoming: `💰 +₪12,000 · משכורת · הפועלים`.
- First sync of an account (no prior txns) → one summary message, no per-txn flood.
- Sync failure for an account → one error notification (deduped per error per day).
- Each channel is optional; failures are logged and never break sync.

## Dashboard
KPI tiles (balance, income/expense/net this month, card debt pending), monthly income vs
expense bar chart, category doughnut, daily cumulative spend line, recurring/standing orders
table with next expected date, filterable transactions table, sync status + "Sync now".
RTL Hebrew, light/dark via `prefers-color-scheme`, responsive.

## Error handling
Per-account try/catch; scraper errorType surfaced in `sync_runs`; structured logs
(`src/log.js`, JSON lines); server binds localhost; `/api/sync` guarded against concurrent runs.

## Testing
`node --test`: normalize/hash, db insert dedupe, categorize, recurring detection,
vault round-trip & wrong passphrase, notifier formatting with fake fetch, sync orchestration
with fake scraper, API endpoints with demo DB.

## Out of scope
Budgets/goals, multi-user, native mobile app, cloud hosting.
