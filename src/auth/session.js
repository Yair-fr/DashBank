// Stateless signed tokens (base64url(JSON).base64url(HMAC-SHA256)) and a tiny cookie parser.
import crypto from 'node:crypto';

/** Purpose-separated 32-byte key derived from AUTH_SECRET (HKDF-SHA256). */
export function deriveKey(secret, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.alloc(0), `dashbank:${purpose}:v1`, 32));
}

const mac = (data, key) => crypto.createHmac('sha256', key).update(data).digest();

export function signToken(payload, key) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, key).toString('base64url')}`;
}

/** Returns the payload when signature, type (`t`) and expiry (`exp`, epoch ms) are valid; otherwise null. */
export function verifyToken(token, key, { now = Date.now(), type } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = mac(parts[0], key);
  const given = Buffer.from(parts[1], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (type !== undefined && payload.t !== type) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch { /* keep the raw value */ }
    out[name] = value;
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, path = '/', httpOnly = true, sameSite = 'Strict', secure = false } = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (maxAge !== undefined) s += `; Max-Age=${Math.floor(maxAge)}`;
  s += `; Path=${path}`;
  if (httpOnly) s += '; HttpOnly';
  if (sameSite) s += `; SameSite=${sameSite}`;
  if (secure) s += '; Secure';
  return s;
}
