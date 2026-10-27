// Usage: npm run backup  → writes a timestamped copy of your data to ./backups/
// The vault and auth file stay encrypted. The transactions database is NOT encrypted, so keep backups private.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const config = loadConfig();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(config.root, 'backups', stamp);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

if (fs.existsSync(config.dbPath)) {
  const db = openDb(config.dbPath);
  try {
    // VACUUM INTO writes a consistent snapshot even while the app is running (WAL-safe).
    db.raw.prepare('VACUUM INTO ?').run(path.join(dir, 'dashbank.db'));
  } finally {
    db.close();
  }
}
for (const file of [config.vaultPath, path.join(config.dataDir, 'auth.json')]) {
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, path.basename(file)));
}
const copied = fs.readdirSync(dir);
if (!copied.length) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error('Nothing to back up yet. Run npm run setup and npm start first.');
  process.exit(1);
}
console.log(`✅ Backup saved to: ${dir}`);
console.log(`   Files: ${copied.join(', ')}`);
