import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/demo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'backup.js');
const run = (dataDir) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
  env: { ...process.env, DASHBANK_DATA_DIR: dataDir }, encoding: 'utf8', stdio: 'pipe',
});

test('backup copies the database snapshot and encrypted files, and fails cleanly when empty', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbk-'));
  // Empty data dir: nothing to back up → non-zero exit, no leftover folder.
  assert.throws(() => run(dataDir), (e) => e.status === 1);
  assert.equal(fs.existsSync(path.join(root, 'backups')) && fs.readdirSync(path.join(root, 'backups')).length > 0, false);

  const db = openDb(path.join(dataDir, 'dashbank.db'));
  seedDemo(db);
  db.close();
  fs.writeFileSync(path.join(dataDir, 'vault.enc'), Buffer.from('DBV1-encrypted-placeholder'));

  const out = run(dataDir);
  const folder = out.match(/Backup saved to: (.+)/)[1].trim();
  try {
    assert.ok(fs.existsSync(path.join(folder, 'dashbank.db')));
    assert.ok(fs.existsSync(path.join(folder, 'vault.enc')));
    const copy = openDb(path.join(folder, 'dashbank.db'));
    assert.ok(copy.listTransactions({ limit: 1 }).total > 0);
    copy.close();
  } finally {
    fs.rmSync(path.join(root, 'backups'), { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
