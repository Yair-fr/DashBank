import 'dotenv/config';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { log } from './log.js';

const config = loadConfig();

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function getPassphrase() {
  if (config.passphrase) return config.passphrase;
  const { createPrompt } = await import('./prompt.js');
  const prompt = createPrompt();
  try {
    return await prompt.askHidden('Vault passphrase: ');
  } finally {
    prompt.close();
  }
}

async function startServer(db, syncer) {
  const { createApp } = await import('./server.js');
  const app = createApp({ db, syncer, config });
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      console.log(`DashBank is running: http://127.0.0.1:${config.port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

function onShutdown(cleanup) {
  let done = false;
  const handler = () => {
    if (done) return;
    done = true;
    log.info('shutting down');
    try { cleanup(); } finally { process.exit(0); }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

async function runDemo() {
  // The demo DB is disposable: rebuild it so dates stay relative to today.
  for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) fs.rmSync(f, { force: true });
  const db = openDb(config.dbPath);
  const { seedDemo } = await import('./demo.js');
  const seeded = seedDemo(db);
  log.info('demo data seeded', seeded);
  const syncer = {
    async run() {
      const at = new Date().toISOString();
      return { demo: true, startedAt: at, finishedAt: at, results: [] };
    },
    isRunning: () => false,
  };
  const server = await startServer(db, syncer);
  console.log('Demo mode: sample data only, no syncing and no notifications');
  onShutdown(() => { server.close(); db.close(); });
}

async function runReal() {
  if (!fs.existsSync(config.vaultPath)) {
    fail('No credentials vault found. Run first: npm run setup');
  }
  const passphrase = await getPassphrase();
  if (!passphrase) fail('A vault passphrase is required (or set DASHBANK_PASSPHRASE in the .env file)');

  const { readVault } = await import('./vault.js');
  let vault;
  try {
    vault = readVault(config.vaultPath, passphrase);
  } catch (e) {
    fail(e.message);
  }
  if (!vault.accounts?.length) fail('The vault is empty. Add accounts with: npm run setup');

  const db = openDb(config.dbPath);
  const { createNotifier } = await import('./notify/index.js');
  const { createSyncer, cronExpression } = await import('./sync.js');
  const notifier = createNotifier(config);
  if (!notifier.channels.length) log.warn('no notification channels configured');
  const syncer = createSyncer({ db, config, notifier, getAccounts: async () => vault.accounts });

  if (config.once) {
    const report = await syncer.run();
    for (const r of report.results) {
      console.log(`${r.ok ? '✓' : '✗'} ${r.label}: ${r.ok ? `${r.newCount} new transactions` : r.error}`);
    }
    db.close();
    process.exit(report.results.every((r) => r.ok) ? 0 : 1);
  }

  const server = await startServer(db, syncer);
  const runSync = () => syncer.run().catch((e) => log.error('sync failed', { error: e.message }));
  runSync();

  const { default: cron } = await import('node-cron');
  const expr = cronExpression(config.syncIntervalMinutes);
  const task = cron.schedule(expr, runSync);
  log.info('sync scheduled', { cron: expr });

  onShutdown(() => { task.stop(); server.close(); db.close(); });
}

try {
  await (config.demo ? runDemo() : runReal());
} catch (e) {
  log.error('fatal', { error: e.message });
  process.exit(1);
}
