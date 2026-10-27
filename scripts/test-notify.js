import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createNotifier } from '../src/notify/index.js';

const config = loadConfig();
const notifier = createNotifier(config);

if (!notifier.channels.length) {
  console.log('לא הוגדר אף ערוץ התראות (טלגרם / ntfy). ראה .env');
  process.exit(1);
}

const sample = {
  source: 'isracard', accountNumber: '1234567', amount: -123.45, currency: 'ILS',
  description: 'בדיקת התראה', category: 'מזון', date: new Date().toISOString(),
  status: 'completed', installmentNumber: null, installmentTotal: null,
};
const { sent, failed } = await notifier.notifyTxn({ ...sample, amount: -Math.max(123.45, config.notifyMinAmount) });
console.log(`ערוצים: ${notifier.channels.join(', ')} | נשלחו: ${sent} | נכשלו: ${failed}`);
process.exit(failed ? 1 : 0);
