import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { readVault, writeVault } from '../src/vault.js';
import { SOURCE_LABELS } from '../src/normalize.js';
import { createPrompt } from '../src/prompt.js';

const COMPANIES = ['hapoalim', 'isracard', 'visaCal', 'max', 'amex', 'leumi', 'discount', 'mizrahi'];
const HIDDEN = /password|pass|card6Digits|otp/i;

const config = loadConfig();
const { ask, askHidden, close } = createPrompt();

async function main() {
  console.log('DashBank - credentials vault setup\n');
  const { SCRAPERS } = await import('israeli-bank-scrapers');
  const pass = config.passphrase || await askHidden('Vault passphrase: ');
  if (!pass) throw new Error('A vault passphrase is required');

  let vault = { accounts: [] };
  if (fs.existsSync(config.vaultPath)) {
    vault = readVault(config.vaultPath, pass);
    console.log(`Existing vault loaded (${vault.accounts.length} accounts)`);
  } else {
    const again = config.passphrase ? pass : await askHidden('Re-enter passphrase to confirm: ');
    if (again !== pass) throw new Error('Passphrases do not match');
  }

  for (;;) {
    console.log('\n1) Add account\n2) List accounts\n3) Remove account\n4) Save and exit');
    const choice = await ask('Choose: ');
    if (choice === '1') {
      COMPANIES.forEach((c, i) => console.log(`  ${i + 1}) ${SOURCE_LABELS[c] || c} (${c})`));
      const companyId = COMPANIES[Number(await ask('Institution: ')) - 1];
      if (!companyId || !SCRAPERS[companyId]) { console.log('Invalid choice'); continue; }
      const label = (await ask(`Display name [${SOURCE_LABELS[companyId]}]: `)) || SOURCE_LABELS[companyId];
      const credentials = {};
      for (const field of SCRAPERS[companyId].loginFields) {
        credentials[field] = HIDDEN.test(field) ? await askHidden(`${field}: `) : await ask(`${field}: `);
      }
      vault.accounts.push({ id: crypto.randomBytes(4).toString('hex'), companyId, label, credentials });
      console.log('Account added');
    } else if (choice === '2') {
      if (!vault.accounts.length) console.log('No accounts yet');
      vault.accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.label} [${a.companyId}] id=${a.id}`));
    } else if (choice === '3') {
      vault.accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.label} [${a.companyId}]`));
      const idx = Number(await ask('Account number to remove: ')) - 1;
      if (vault.accounts[idx]) { vault.accounts.splice(idx, 1); console.log('Removed'); } else console.log('Invalid choice');
    } else if (choice === '4') {
      writeVault(config.vaultPath, vault, pass);
      console.log(`Saved: ${config.vaultPath}`);
      return;
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  close();
}
