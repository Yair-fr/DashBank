import { BANK_SOURCES } from './normalize.js';
import { CARD_SETTLEMENT_CATEGORY } from './db.js';

const CARD_COMPANIES = ['ישראכרט', 'כאל', 'ויזה כאל', 'מקס', 'לאומי קארד', 'אמריקן אקספרס', 'דיינרס', 'ישראכרט בע"מ', 'max it'];
const SALARY_TERMS = ['משכורת', 'שכר', 'salary'];

// Income rules apply only to positive amounts, in order.
const INCOME_RULES = [
  { category: 'משכורת', patterns: SALARY_TERMS },
  { category: 'קצבאות', patterns: ['ביטוח לאומי'] },
  { category: 'העברות', patterns: ['העברה'] },
];

// Order matters: first matching rule wins.
export const RULES = [
  { category: 'מזון וסופר', patterns: ['שופרסל', 'רמי לוי', 'יוחננוף', 'ויקטורי', 'טיב טעם', 'מגה', 'אושר עד', 'AM:PM', 'יינות ביתן'] },
  { category: 'מסעדות וקפה', patterns: ['ארומה', 'קפה', 'מסעדה', 'וולט', 'wolt', 'תן ביס', '10bis', 'מקדונלד', 'דומינו'] },
  { category: 'תחבורה ודלק', patterns: ['פז', 'דלק', 'סונול', 'דור אלון', 'ten', 'רב קו', 'רכבת', 'gett', 'yango', 'מוניות', 'חניה', 'פנגו', 'סלופארק', 'כביש 6'] },
  { category: 'תקשורת', patterns: ['סלקום', 'פרטנר', 'פלאפון', 'הוט', 'בזק', 'גולן', '012', '019', 'yes'] },
  { category: 'מנויים ודיגיטל', patterns: ['netflix', 'spotify', 'apple', 'google', 'youtube', 'disney', 'chatgpt', 'openai', 'anthropic', 'claude', 'amazon prime', 'microsoft', 'adobe', 'דיסני'] },
  { category: 'חשבונות בית', patterns: ['חברת החשמל', 'חשמל', 'מי ', 'תאגיד', 'ארנונה', 'עירייה', 'גז', 'סופרגז', 'אמישראגז', 'ועד בית'] },
  { category: 'ביטוח ובריאות', patterns: ['ביטוח', 'הראל', 'מגדל', 'כלל', 'הפניקס', 'מנורה', 'מכבי', 'כללית', 'מאוחדת', 'לאומית', 'סופר-פארם', 'בית מרקחת'] },
  { category: 'קניות', patterns: ['amazon', 'aliexpress', 'ali express', 'shein', 'איקאה', 'ikea', 'זארה', 'h&m', 'ksp', 'באג', 'ivory'] },
  { category: 'חינוך', patterns: ['אוניברסיטה', 'בר-אילן', 'בר אילן', 'שכר לימוד', 'קורס', 'udemy', 'coursera'] },
  { category: 'פנאי', patterns: ['סינמה', 'יס פלאנט', 'cinema', 'הופעה', 'כושר', 'holmes', 'גו אקטיב'] },
  { category: 'משיכת מזומן', patterns: ['משיכה', 'כספומט', 'atm'] },
  { category: 'עמלות', patterns: ['עמלה', 'דמי ניהול', 'ריבית'] },
  { category: 'הוראות קבע', patterns: ['הוראת קבע', 'הו"ק'] },
];

export const CATEGORIES = [
  CARD_SETTLEMENT_CATEGORY,
  ...INCOME_RULES.map((r) => r.category),
  'הכנסה',
  ...RULES.map((r) => r.category),
  'אחר',
];

// Matching is a case-insensitive substring test on the lowercased description.
// Exception: short Latin tokens (<= 4 chars, e.g. "ten", "yes", "atm") must match
// as whole words, otherwise "tennis" or "yesterday" would false-match. Hebrew
// patterns stay plain substring matches (Hebrew prefixes attach to words).
const SHORT_LATIN = /^[a-z0-9&]{1,4}$/;
const matcherCache = new Map();

function matches(haystack, pattern) {
  const p = pattern.toLowerCase();
  if (!SHORT_LATIN.test(p)) return haystack.includes(p);
  let re = matcherCache.get(p);
  if (!re) {
    re = new RegExp(`(?<![a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
    matcherCache.set(p, re);
  }
  return re.test(haystack);
}

const matchesAny = (haystack, patterns) => patterns.some((p) => matches(haystack, p));

/** Pattern list for 'מנויים ודיגיטל' (reused by recurring detection). */
export function isSubscriptionDescription(description) {
  const rule = RULES.find((r) => r.category === 'מנויים ודיגיטל');
  return matchesAny(String(description || '').toLowerCase(), rule.patterns);
}

export function categorize(description, { source, amount } = {}) {
  const d = String(description || '').toLowerCase();

  if (BANK_SOURCES.has(source) && matchesAny(d, CARD_COMPANIES)) return CARD_SETTLEMENT_CATEGORY;

  if (amount > 0) {
    for (const rule of INCOME_RULES) if (matchesAny(d, rule.patterns)) return rule.category;
  }

  for (const rule of RULES) if (matchesAny(d, rule.patterns)) return rule.category;

  return amount > 0 ? 'הכנסה' : 'אחר';
}
