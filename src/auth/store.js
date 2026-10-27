// data/auth.json (mode 0600):
// { users: [{ username, passwordHash, totpSecret: 'v1:iv:tag:ct' (AES-256-GCM), recoveryCodes: ['hmac$…'] }] }
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './password.js';
import { base32Encode } from './totp.js';
import { deriveKey } from './session.js';

export function encryptSecret(plain, authSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(authSecret, 'totp'), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(enc, authSecret) {
  const parts = String(enc).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad secret format');
  const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, 'base64'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('bad secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(authSecret, 'totp'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** n single-use codes, 50 random bits each, formatted XXXXX-XXXXX. */
export function generateRecoveryCodes(n = 8) {
  const codes = new Set();
  while (codes.size < n) {
    const s = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    codes.add(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return [...codes];
}

/** Keyed hash, so a leaked auth.json alone does not allow offline guessing. */
export function hashRecoveryCode(code, authSecret) {
  const digest = crypto.createHmac('sha256', deriveKey(authSecret, 'recovery')).update(normalizeCode(code)).digest('base64url');
  return `hmac$${digest}`;
}

/** Index of the matching hash, or -1. Checks every entry with timingSafeEqual. */
export function matchRecoveryCode(hashes, code, authSecret) {
  const clean = normalizeCode(code);
  if (clean.length !== 10 || !Array.isArray(hashes)) return -1;
  const given = Buffer.from(hashRecoveryCode(clean, authSecret));
  let found = -1;
  hashes.forEach((h, i) => {
    const b = Buffer.from(String(h));
    if (b.length === given.length && crypto.timingSafeEqual(b, given) && found < 0) found = i;
  });
  return found;
}

export const normalizeUsername = (u) => String(u ?? '').trim().toLowerCase();

export async function buildUser({ username, password, totpSecret, recoveryCodes }, authSecret) {
  return {
    username: normalizeUsername(username),
    passwordHash: await hashPassword(password),
    totpSecret: encryptSecret(totpSecret, authSecret),
    recoveryCodes: recoveryCodes.map((c) => hashRecoveryCode(c, authSecret)),
  };
}

/** null when the file does not exist; throws on a corrupt file. */
export function loadAuthStore(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.users)) throw new Error('auth.json פגום');
  return data;
}

export function saveAuthStore(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
