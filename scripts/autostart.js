// Usage: npm run autostart            → start DashBank automatically when you log in
//        npm run autostart -- --remove → undo
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { windowsTask, launchdPlist, launchdPath, systemdUnit, systemdPath } from '../src/autostart.js';

const config = loadConfig();
const remove = process.argv.includes('--remove');
const opts = { root: config.root, nodePath: process.execPath };
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

if (!remove && !config.passphrase) {
  console.error('⚠️  DASHBANK_PASSPHRASE is empty in .env. Auto-start cannot type the vault passphrase for you.');
  console.error('   Add it to .env (only on a computer that is yours alone, with disk encryption on), then run again.');
  process.exit(1);
}

try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (process.platform === 'win32') {
    const t = windowsTask(opts);
    run(...(remove ? t.remove : t.create));
  } else if (process.platform === 'darwin') {
    const file = launchdPath(os.homedir());
    if (remove) {
      try { run('launchctl', ['unload', file]); } catch { /* not loaded */ }
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, launchdPlist(opts));
      try { run('launchctl', ['unload', file]); } catch { /* not loaded yet */ }
      run('launchctl', ['load', file]);
    }
  } else {
    const file = systemdPath(os.homedir());
    if (remove) {
      try { run('systemctl', ['--user', 'disable', '--now', 'dashbank.service']); } catch { /* not installed */ }
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, systemdUnit(opts));
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', 'dashbank.service']);
    }
  }
  console.log(remove ? '✅ Auto-start removed.' : `✅ DashBank will start automatically when you log in. Dashboard: http://127.0.0.1:${config.port}`);
} catch (err) {
  console.error('❌ Failed to configure auto-start:', err.message);
  process.exit(1);
}
