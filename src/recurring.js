import { BANK_SOURCES } from './normalize.js';
import { categorize, isSubscriptionDescription } from './categorize.js';

const DAY_MS = 86400000;
const PERIOD_DAYS = { monthly: 30, weekly: 7, yearly: 365 };
const TOLERANCE = 0.15;

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

function normalizeDescription(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\d\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Add whole months in UTC, clamping the day to the target month's end. */
function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = m - 1 + months;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, last))).toISOString().slice(0, 10);
}

function nextDate(lastDate, cadence) {
  if (cadence === 'weekly') return isoDay(new Date(lastDate).getTime() + 7 * DAY_MS);
  return addMonths(lastDate, cadence === 'yearly' ? 12 : 1);
}

function cadenceFor(gap) {
  if (gap >= 25 && gap <= 35) return 'monthly';
  if (gap >= 6 && gap <= 8) return 'weekly';
  if (gap >= 355 && gap <= 375) return 'yearly';
  return null;
}

export function detectRecurring(txns, { now = new Date() } = {}) {
  const groups = new Map();
  for (const t of txns) {
    if (t.installmentTotal > 1) continue; // installments are not recurring
    const outgoing = t.amount < 0;
    // Incoming groups only count when they are salaries.
    if (!outgoing && !(t.amount > 0 && categorize(t.description, { source: t.source, amount: t.amount }) === 'משכורת')) continue;
    const norm = normalizeDescription(t.description);
    if (!norm) continue;
    const key = `${t.source}|${norm}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const out = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => new Date(a.date) - new Date(b.date));
    if (list.length < 2) continue;

    const days = list.map((t) => isoDay(t.date));
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push((new Date(days[i]) - new Date(days[i - 1])) / DAY_MS);
    const cadence = cadenceFor(median(gaps));
    if (!cadence) continue;

    if (cadence === 'yearly' && list.length < 2) continue;
    if (cadence !== 'yearly' && list.length < 3) continue;
    if (cadence === 'monthly' && new Set(days.map((d) => d.slice(0, 7))).size < 3) continue;

    const med = median(list.map((t) => t.amount));
    if (!list.every((t) => Math.abs(t.amount - med) <= Math.abs(med) * TOLERANCE)) continue;

    const latest = list[list.length - 1];
    const lastDate = days[days.length - 1];
    const avgAmount = round2(list.reduce((s, t) => s + t.amount, 0) / list.length);
    const desc = latest.description || '';

    // Positive (salary) groups are 'income' even from bank sources.
    let kind = 'recurring';
    if (avgAmount > 0) kind = 'income';
    else if (/הוראת קבע|הו"ק/.test(desc) || BANK_SOURCES.has(latest.source)) kind = 'standing_order';
    else if (isSubscriptionDescription(desc)) kind = 'subscription';

    const active = (new Date(now).getTime() - new Date(lastDate).getTime()) <= 1.5 * PERIOD_DAYS[cadence] * DAY_MS;

    out.push({ key, description: desc, source: latest.source, avgAmount, cadence, count: list.length, lastDate, nextDate: nextDate(lastDate, cadence), kind, active });
  }

  return out.sort((a, b) => a.avgAmount - b.avgAmount);
}
