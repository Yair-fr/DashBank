import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env = process.env, argv = process.argv) {
  const dataDir = env.DASHBANK_DATA_DIR || path.join(ROOT, 'data');
  const demo = argv.includes('--demo') || env.DASHBANK_DEMO === '1';
  return {
    root: ROOT,
    port: int(env.PORT, 3456),
    // Loopback only by default. Docker sets HOST=0.0.0.0 inside the container and publishes on 127.0.0.1.
    host: env.HOST || '127.0.0.1',
    syncIntervalMinutes: Math.max(10, int(env.SYNC_INTERVAL_MINUTES, 30)),
    monthsBack: Math.min(12, Math.max(1, int(env.MONTHS_BACK, 6))),
    notifyMinAmount: int(env.NOTIFY_MIN_AMOUNT, 0),
    notifyLang: env.NOTIFY_LANG === 'en' ? 'en' : 'he',
    notifyPrivacy: env.NOTIFY_PRIVACY === '1',
    accessibilityContact: (env.ACCESSIBILITY_CONTACT || '').trim(),
    passphrase: env.DASHBANK_PASSPHRASE || '',
    telegram: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.TELEGRAM_CHAT_ID || '' },
    ntfy: { server: env.NTFY_SERVER || 'https://ntfy.sh', topic: env.NTFY_TOPIC || '', token: env.NTFY_TOKEN || '' },
    dataDir,
    dbPath: path.join(dataDir, demo ? 'demo.db' : 'dashbank.db'),
    vaultPath: path.join(dataDir, 'vault.enc'),
    demo,
    once: argv.includes('--once'),
  };
}
