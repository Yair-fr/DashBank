import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password.js';
import { base32Encode, base32Decode, generateSecret, totp, verifyTotp, findTotpStep, otpauthUrl } from '../src/auth/totp.js';
import { signToken, verifyToken, parseCookies, serializeCookie, deriveKey } from '../src/auth/session.js';
import {
  encryptSecret, decryptSecret, loadAuthStore, saveAuthStore, generateRecoveryCodes,
  hashRecoveryCode, matchRecoveryCode, buildUser,
} from '../src/auth/store.js';
import { createRateLimiter } from '../src/auth/ratelimit.js';

const SECRET = 'a'.repeat(64);

// ---------- password ----------
test('hashPassword produces scrypt$N$r$p$salt$hash and verifies', async () => {
  const stored = await hashPassword('correct horse battery');
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', String(2 ** 15), '8', '1']);
  assert.equal(Buffer.from(parts[5], 'base64').length, 32);
  assert.equal(await verifyPassword('correct horse battery', stored), true);
  assert.equal(await verifyPassword('correct horse batterY', stored), false);
});

test('hashPassword salts (two hashes differ)', async () => {
  assert.notEqual(await hashPassword('0123456789'), await hashPassword('0123456789'));
});

test('hashPassword enforces minimum length', async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 10);
  await assert.rejects(hashPassword('short'), /10/);
  await assert.rejects(hashPassword(123456789012), /10/);
});

test('verifyPassword returns false on malformed or hostile stored values', async () => {
  for (const bad of ['', 'nope', 'scrypt$1$8$1$aa$bb', 'bcrypt$x', `scrypt$${2 ** 30}$8$1$AAAA$AAAA`, null]) {
    assert.equal(await verifyPassword('0123456789', bad), false);
  }
});

// ---------- totp ----------
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('base32 round trip and RFC 4648 vector', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('mzxw 6ytb oi').toString(), 'foobar');
  assert.equal(base32Decode('MZXW6YTBOI======').toString(), 'foobar');
  assert.throws(() => base32Decode('MZ1!'));
});

test('generateSecret is 20 random bytes in base32', () => {
  const s = generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(s).length, 20);
  assert.notEqual(s, generateSecret());
});

test('totp matches RFC 6238 SHA-1 vectors (8 digits)', () => {
  assert.equal(totp(RFC_SECRET, { time: 59, digits: 8 }), '94287082');
  assert.equal(totp(RFC_SECRET, { time: 1111111109, digits: 8 }), '07081804');
  assert.equal(totp(RFC_SECRET, { time: 1234567890, digits: 8 }), '89005924');
  assert.equal(totp(RFC_SECRET, { time: 59 }), '287082');
});

test('verifyTotp accepts window ±1 and rejects outside / malformed', () => {
  const t = 1234567890;
  const code = totp(RFC_SECRET, { time: t });
  assert.equal(verifyTotp(RFC_SECRET, code, { time: t }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { time: t + 30 }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { time: t - 30 }), true);
  assert.equal(verifyTotp(RFC_SECRET, code, { time: t + 90 }), false);
  assert.equal(verifyTotp(RFC_SECRET, code, { time: t + 30, window: 0 }), false);
  assert.equal(verifyTotp(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, { time: t }), true);
  for (const bad of ['', '12345', '1234567', 'abcdef', null, 123456]) {
    assert.equal(verifyTotp(RFC_SECRET, bad, { time: t }), false);
  }
});

test('findTotpStep returns matched time step for replay tracking', () => {
  const t = 1234567890;
  const code = totp(RFC_SECRET, { time: t });
  assert.equal(findTotpStep(RFC_SECRET, code, { time: t }), Math.floor(t / 30));
  assert.equal(findTotpStep(RFC_SECRET, code, { time: t + 30 }), Math.floor(t / 30));
  assert.equal(findTotpStep(RFC_SECRET, '000000', { time: t + 900 }), null);
});

test('otpauthUrl format', () => {
  const url = otpauthUrl({ secret: 'JBSWY3DPEHPK3PXP', account: 'dana@home' });
  assert.equal(url, 'otpauth://totp/DashBank:dana%40home?secret=JBSWY3DPEHPK3PXP&issuer=DashBank&algorithm=SHA1&digits=6&period=30');
});

// ---------- session tokens / cookies ----------
test('signToken / verifyToken round trip, tamper and expiry', () => {
  const key = deriveKey(SECRET, 'session');
  const now = 1_000_000;
  const tok = signToken({ t: 'sess', u: 'dana', mfa: true, exp: now + 1000 }, key);
  assert.match(tok, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyToken(tok, key, { now, type: 'sess' }), { t: 'sess', u: 'dana', mfa: true, exp: now + 1000 });
  assert.equal(verifyToken(tok, key, { now: now + 1000, type: 'sess' }), null, 'expired');
  assert.equal(verifyToken(tok, key, { now, type: 'pre' }), null, 'wrong type');
  assert.equal(verifyToken(tok, deriveKey('b'.repeat(64), 'session'), { now, type: 'sess' }), null, 'wrong key');
  const [p, s] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ t: 'sess', u: 'eve', mfa: true, exp: now + 1000 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${s}`, key, { now, type: 'sess' }), null, 'tampered payload');
  assert.equal(verifyToken(`${p}.${s.slice(0, -2)}AA`, key, { now, type: 'sess' }), null, 'tampered sig');
  for (const bad of ['', 'x', 'a.b.c', null, undefined]) assert.equal(verifyToken(bad, key, { now, type: 'sess' }), null);
});

test('deriveKey separates purposes', () => {
  assert.notDeepEqual(deriveKey(SECRET, 'session'), deriveKey(SECRET, 'totp'));
  assert.equal(deriveKey(SECRET, 'session').length, 32);
});

test('parseCookies handles spacing, quotes, encoding and garbage', () => {
  assert.deepEqual({ ...parseCookies('a=1; b = two ;c="q"; d=%3D%3D; bad; =x; e=%E0%A4%A; a=2') },
    { a: '1', b: 'two', c: 'q', d: '==', e: '%E0%A4%A' });
  assert.deepEqual({ ...parseCookies(undefined) }, {});
  assert.equal(Object.getPrototypeOf(parseCookies('__proto__=1')), null);
});

test('serializeCookie flags', () => {
  assert.equal(serializeCookie('db_sess', 'v', { maxAge: 60, secure: true }),
    'db_sess=v; Max-Age=60; Path=/; HttpOnly; SameSite=Strict; Secure');
  assert.equal(serializeCookie('x', '', { maxAge: 0, sameSite: 'Lax', path: '/auth/google' }),
    'x=; Max-Age=0; Path=/auth/google; HttpOnly; SameSite=Lax');
});

// ---------- store ----------
test('encryptSecret / decryptSecret with AES-256-GCM', () => {
  const enc = encryptSecret('JBSWY3DPEHPK3PXP', SECRET);
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(decryptSecret(enc, SECRET), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => decryptSecret(enc, 'c'.repeat(64)));
  const parts = enc.split(':');
  parts[3] = Buffer.from('tampered!!').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':'), SECRET));
});

test('recovery codes: format, keyed hash, normalized match', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 8);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  assert.equal(new Set(codes).size, 8);
  const hashes = codes.map((c) => hashRecoveryCode(c, SECRET));
  assert.ok(hashes.every((h) => !h.includes(codes[0])));
  assert.equal(matchRecoveryCode(hashes, codes[3].toLowerCase().replace('-', ' '), SECRET), 3);
  assert.equal(matchRecoveryCode(hashes, 'AAAAA-AAAAA', SECRET), -1);
  assert.equal(matchRecoveryCode(hashes, codes[3], 'd'.repeat(64)), -1);
  assert.equal(matchRecoveryCode(hashes, '', SECRET), -1);
});

test('auth store save/load with mode 0600, missing file → null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbauth-'));
  const file = path.join(dir, 'sub', 'auth.json');
  assert.equal(loadAuthStore(file), null);
  const user = await buildUser({ username: 'Dana', password: '0123456789', totpSecret: 'JBSWY3DPEHPK3PXP', recoveryCodes: ['AAAAA-BBBBB'] }, SECRET);
  assert.equal(user.username, 'dana');
  assert.ok(user.passwordHash.startsWith('scrypt$'));
  assert.notEqual(user.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(user.recoveryCodes.length, 1);
  saveAuthStore(file, { users: [user] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadAuthStore(file), { users: [user] });
  fs.writeFileSync(file, '{"users": "nope"}');
  assert.throws(() => loadAuthStore(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- rate limiter ----------
test('rate limiter blocks after max failures within window, then expires', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 5, windowMs: 1000, now: () => t });
  for (let i = 0; i < 4; i++) rl.fail('k');
  assert.equal(rl.blocked('k'), 0);
  rl.fail('k');
  assert.ok(rl.blocked('k') > 0);
  assert.equal(rl.blocked('other'), 0);
  t = 1001;
  assert.equal(rl.blocked('k'), 0);
  rl.fail('k');
  rl.reset('k');
  assert.equal(rl.blocked('k'), 0);
});

test('rate limiter bounds memory', () => {
  const rl = createRateLimiter({ max: 5, windowMs: 1000, now: () => 0, maxKeys: 100 });
  for (let i = 0; i < 1000; i++) rl.fail(`k${i}`);
  assert.ok(rl.size() <= 100);
});
