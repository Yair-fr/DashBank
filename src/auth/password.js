// Password hashing with scrypt (node:crypto only). Format: scrypt$N$r$p$saltB64$hashB64
import crypto from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 10;
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32, SALT = 16;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(pw, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`);
  }
  const salt = crypto.randomBytes(SALT);
  const key = await scrypt(pw.normalize('NFKC'), salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

// Only accept sane cost parameters so a corrupted/hostile file cannot exhaust memory/CPU.
function parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isInteger(n) || n < 2 ** 14 || n > 2 ** 17 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || hash.length !== KEYLEN) return null;
  return { n, r, p, salt, hash };
}

export async function verifyPassword(pw, stored) {
  const parsed = parse(stored);
  if (!parsed || typeof pw !== 'string') return false;
  try {
    const key = await scrypt(pw.normalize('NFKC'), parsed.salt, parsed.n, parsed.r, parsed.p);
    return crypto.timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

// A real hash to verify against when the username is unknown, so response timing
// does not reveal whether a user exists.
let dummy;
export function dummyHash() {
  dummy ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummy;
}
