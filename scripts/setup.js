import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { readVault, writeVault } from '../src/vault.js';
import { SOURCE_LABELS } from '../src/normalize.js';

const COMPANIES = ['hapoalim', 'isracard', 'visaCal', 'max', 'amex', 'leumi', 'discount', 'mizrahi'];
const HIDDEN = /password|pass|card6Digits|otp/i;

const config = loadConfig();
let muted = false;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const origWrite = rl._writeToOutput?.bind(rl);
if (origWrite) {
  rl._writeToOutput = (s) => { if (!muted) origWrite(s); };
}

async function ask(q) {
  return (await rl.question(q)).trim();
}

async function askHidden(q) {
  process.stdout.write(q);
  muted = true;
  try {
    return (await rl.question('')).trim();
  } finally {
    muted = false;
    process.stdout.write('\n');
  }
}

async function main() {
  console.log('DashBank - הגדרת כספת פרטי גישה\n');
  const { SCRAPERS } = await import('israeli-bank-scrapers');
  const pass = config.passphrase || await askHidden('סיסמת כספת: ');
  if (!pass) throw new Error('נדרשת סיסמת כספת');

  let vault = { accounts: [] };
  if (fs.existsSync(config.vaultPath)) {
    vault = readVault(config.vaultPath, pass);
    console.log(`נטענה כספת קיימת (${vault.accounts.length} חשבונות)`);
  } else {
    const again = config.passphrase ? pass : await askHidden('הקלד שוב לאימות: ');
    if (again !== pass) throw new Error('הסיסמאות אינן תואמות');
  }

  for (;;) {
    console.log('\n1) הוספת חשבון\n2) רשימת חשבונות\n3) הסרת חשבון\n4) שמירה ויציאה');
    const choice = await ask('בחר: ');
    if (choice === '1') {
      COMPANIES.forEach((c, i) => console.log(`  ${i + 1}) ${SOURCE_LABELS[c] || c} (${c})`));
      const companyId = COMPANIES[Number(await ask('חברה: ')) - 1];
      if (!companyId || !SCRAPERS[companyId]) { console.log('בחירה לא תקינה'); continue; }
      const label = (await ask(`שם לתצוגה [${SOURCE_LABELS[companyId]}]: `)) || SOURCE_LABELS[companyId];
      const credentials = {};
      for (const field of SCRAPERS[companyId].loginFields) {
        credentials[field] = HIDDEN.test(field) ? await askHidden(`${field}: `) : await ask(`${field}: `);
      }
      vault.accounts.push({ id: crypto.randomBytes(4).toString('hex'), companyId, label, credentials });
      console.log('החשבון נוסף');
    } else if (choice === '2') {
      if (!vault.accounts.length) console.log('אין חשבונות');
      vault.accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.label} [${a.companyId}] id=${a.id}`));
    } else if (choice === '3') {
      vault.accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.label} [${a.companyId}]`));
      const idx = Number(await ask('מספר חשבון להסרה: ')) - 1;
      if (vault.accounts[idx]) { vault.accounts.splice(idx, 1); console.log('הוסר'); } else console.log('בחירה לא תקינה');
    } else if (choice === '4') {
      writeVault(config.vaultPath, vault, pass);
      console.log(`נשמר: ${config.vaultPath}`);
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
  rl.close();
}
