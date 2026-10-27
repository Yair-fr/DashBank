import { log } from '../log.js';
import { formatTxn, formatSummary } from './format.js';
import { createTelegram } from './telegram.js';
import { createNtfy } from './ntfy.js';

export function createNotifier(config, { fetch = globalThis.fetch } = {}) {
  const chans = [];
  if (config.telegram?.token && config.telegram?.chatId) chans.push(createTelegram(config.telegram, { fetch }));
  if (config.ntfy?.topic && config.ntfy?.server) chans.push(createNtfy(config.ntfy, { fetch }));
  const seenErrors = new Set();

  async function broadcast(msg) {
    let sent = 0, failed = 0;
    await Promise.all(chans.map(async (c) => {
      try {
        await c.send(msg);
        sent++;
      } catch (e) {
        failed++;
        log.warn('notification failed', { channel: c.name, error: e.message });
      }
    }));
    return { sent, failed };
  }

  return {
    channels: chans.map((c) => c.name),
    async notifyTxn(txn) {
      if (txn.amount < 0 && Math.abs(txn.amount) < (config.notifyMinAmount || 0)) return { sent: 0, failed: 0 };
      return broadcast(formatTxn(txn));
    },
    async notifySummary(newTxns, label) {
      if (!newTxns.length) return { sent: 0, failed: 0 };
      return broadcast({ title: `📊 ${label}`, body: formatSummary(newTxns), tags: ['bar_chart'], priority: 3 });
    },
    async notifyError(label, message) {
      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      const key = `${day}|${label}|${message}`;
      if (seenErrors.has(key)) return { sent: 0, failed: 0 };
      seenErrors.add(key);
      return broadcast({ title: `⚠️ ${label}`, body: message, tags: ['warning'], priority: 4 });
    },
    async sendRaw(title, body) {
      return broadcast({ title, body, tags: [], priority: 3 });
    },
  };
}
