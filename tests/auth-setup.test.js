import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthSetup } from '../scripts/auth-setup.js';
import { loadConfig } from '../src/config.js';
import { totp } from '../src/auth/totp.js';
import { loadAuthStore, decryptSecret, matchRecoveryCode } from '../src/auth/store.js';
import { verifyPassword } from '../src/auth/password.js';

const SECRET = 'e'.repeat(64);
const NOW = Date.UTC(2026, 3, 1);

function harness(answers, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbsetup-'));
  const config = loadConfig({ DASHBANK_DATA_DIR: dir, AUTH_SECRET: SECRET, ...env }, []);
  let out = '';
  const queue = [...answers];
  const hidden = [];
  const next = (q, isHidden) => {
    out += q;
    const a = queue.shift();
    if (isHidden) hidden.push(q);
    return Promise.resolve(typeof a === 'function' ? a(out) : a);
  };
  const prompt = { ask: (q) => next(q, false), askHidden: (q) => next(q, true), close() {} };
  return {
    config, prompt, hidden,
    print: (s = '') => { out += `${s}\n`; },
    output: () => out,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const secretFrom = (out) => out.match(/secret=([A-Z2-7]+)/)[1];
const currentCode = (out) => totp(secretFrom(out), { time: Math.floor(NOW / 1000) });

test('auth-setup creates a user after confirming a TOTP code; prints recovery codes once', async (t) => {
  const h = harness(['Dana', 'long password 123', 'long password 123', '000000', currentCode]);
  t.after(h.cleanup);
  await runAuthSetup({ config: h.config, prompt: h.prompt, print: h.print, now: () => NOW });
  const out = h.output();
  assert.equal(h.hidden.length, 2, 'password + confirm read hidden');
  assert.ok(!out.includes('long password 123'), 'password never echoed');
  assert.match(out, /otpauth:\/\/totp\/DashBank:dana\?secret=[A-Z2-7]{32}&issuer=DashBank/);
  assert.match(out, /Google Authenticator/);
  const codes = out.match(/[A-Z2-7]{5}-[A-Z2-7]{5}/g);
  assert.equal(codes.length, 8);

  const store = loadAuthStore(h.config.auth.filePath);
  assert.equal(store.users.length, 1);
  const u = store.users[0];
  assert.equal(u.username, 'dana');
  assert.equal(await verifyPassword('long password 123', u.passwordHash), true);
  assert.equal(decryptSecret(u.totpSecret, SECRET), secretFrom(out));
  assert.equal(u.recoveryCodes.length, 8);
  assert.equal(matchRecoveryCode(u.recoveryCodes, codes[7], SECRET), 7);
  assert.equal(fs.statSync(h.config.auth.filePath).mode & 0o777, 0o600);
});

test('auth-setup replaces an existing user of the same name, keeps others', async (t) => {
  const h = harness(['dana', 'long password 123', 'long password 123', currentCode]);
  t.after(h.cleanup);
  await runAuthSetup({ config: h.config, prompt: h.prompt, print: h.print, now: () => NOW });
  const before = loadAuthStore(h.config.auth.filePath).users[0];
  fs.writeFileSync(h.config.auth.filePath, JSON.stringify({ users: [before, { ...before, username: 'other' }] }));
  const h2 = harness(['', 'another password!', 'another password!', currentCode]);
  await runAuthSetup({ config: h.config, prompt: h2.prompt, print: h2.print, now: () => NOW });
  const users = loadAuthStore(h.config.auth.filePath).users;
  assert.deepEqual(users.map((u) => u.username).sort(), ['dana', 'other']);
  assert.equal(await verifyPassword('another password!', users.find((u) => u.username === 'dana').passwordHash), true);
  h2.cleanup();
});

test('auth-setup refuses without a strong AUTH_SECRET', async (t) => {
  const h = harness([], { AUTH_SECRET: 'short' });
  t.after(h.cleanup);
  await assert.rejects(runAuthSetup({ config: h.config, prompt: h.prompt, print: h.print }), /AUTH_SECRET/);
  assert.equal(fs.existsSync(h.config.auth.filePath), false);
});

test('auth-setup rejects mismatched / short passwords and wrong codes without saving', async (t) => {
  for (const answers of [
    ['dana', 'long password 123', 'long password 124'],
    ['dana', 'short', 'short'],
    ['dana', 'long password 123', 'long password 123', '000000', '111111', '222222'],
    ['bad user name!', 'long password 123', 'long password 123'],
  ]) {
    const h = harness(answers);
    t.after(h.cleanup);
    await assert.rejects(runAuthSetup({ config: h.config, prompt: h.prompt, print: h.print, now: () => NOW }));
    assert.equal(fs.existsSync(h.config.auth.filePath), false, JSON.stringify(answers));
  }
});
