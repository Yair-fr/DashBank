// TOTP (RFC 6238) on top of HOTP (RFC 4226), HMAC-SHA1, node:crypto only.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(key, counter, digits) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** `time` is unix seconds. */
export function totp(secret, { time = nowSeconds(), step = 30, digits = 6 } = {}) {
  return hotp(base32Decode(secret), Math.floor(time / step), digits);
}

/**
 * Returns the matched time-step counter, or null. Every candidate in the window is
 * computed and compared with timingSafeEqual (no early exit).
 */
export function findTotpStep(secret, code, { window = 1, time = nowSeconds(), step = 30, digits = 6 } = {}) {
  if (typeof code !== 'string') return null;
  const clean = code.replace(/\s/g, '');
  if (clean.length !== digits || !/^\d+$/.test(clean)) return null;
  const key = base32Decode(secret);
  const given = Buffer.from(clean);
  const current = Math.floor(time / step);
  let matched = null;
  for (let i = -window; i <= window; i++) {
    const counter = current + i;
    if (counter < 0) continue;
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, counter, digits)), given);
    if (ok && matched === null) matched = counter;
  }
  return matched;
}

export function verifyTotp(secret, code, opts = {}) {
  return findTotpStep(secret, code, opts) !== null;
}

export function otpauthUrl({ secret, account, issuer = 'DashBank' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q}`;
}
