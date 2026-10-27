import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { totp } from '../src/auth/totp.js';
import { loadAuthStore, saveAuthStore, buildUser } from '../src/auth/store.js';
import { startApp, PASSWORD, TOTP_SECRET, RECOVERY, AUTH_SECRET } from './helpers/auth-harness.js';

const codeAt = (ms) => totp(TOTP_SECRET, { time: Math.floor(ms / 1000) });
const MIN = 60_000, HOUR = 60 * MIN;

async function login(h, { password = PASSWORD, code } = {}) {
  const r1 = await h.req('POST', '/auth/login', { body: { username: 'dana', password } });
  if (r1.status !== 200) return r1;
  return h.req('POST', '/auth/totp', { body: { code: code ?? codeAt(h.clock.t) } });
}

test('config.auth parses env', () => {
  const c = loadConfig({
    DASHBANK_DATA_DIR: '/x', AUTH_SECRET: 's', AUTH_ALLOWED_EMAILS: ' A@x.com, b@Y.com ,,',
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_URL: 'https://box.ts.net//',
  }, []);
  assert.deepEqual(c.auth, {
    secret: 's', allowedEmails: ['a@x.com', 'b@y.com'], google: { clientId: 'id', clientSecret: 'sec' },
    publicUrl: 'https://box.ts.net', filePath: '/x/auth.json',
  });
  assert.deepEqual(loadConfig({ DASHBANK_DATA_DIR: '/x' }, []).auth.allowedEmails, []);
});

test('/auth/me without session', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const r = await h.req('GET', '/auth/me');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { user: null, methods: { password: true, google: false }, configured: true });
  assert.equal(h.auth.isConfigured(), true);
});

test('unauthenticated: /api → 401 JSON, pages → 302 /login.html', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const api = await h.req('GET', '/api/ping');
  assert.equal(api.status, 401);
  assert.deepEqual(api.json, { error: 'unauthorized' });
  const page = await h.req('GET', '/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
});

test('full login: password → totp → session → protected API', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const r1 = await h.req('POST', '/auth/login', { body: { username: 'Dana ', password: PASSWORD } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json, { next: 'totp' });
  const pre = r1.setCookies.find((c) => c.startsWith('db_pre='));
  assert.match(pre, /Max-Age=300; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.ok(!r1.setCookies.some((c) => c.startsWith('db_sess=')));

  // The pre-auth cookie is not a session.
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
  h.jar.set('db_sess', h.jar.get('db_pre'));
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
  h.jar.delete('db_sess');

  const r2 = await h.req('POST', '/auth/totp', { body: { code: codeAt(h.clock.t) } });
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json, { ok: true, user: 'dana' });
  const sess = r2.setCookies.find((c) => c.startsWith('db_sess='));
  assert.match(sess, /Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.ok(!h.jar.has('db_pre'), 'pre cookie cleared');

  const ping = await h.req('GET', '/api/ping');
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json, { user: 'dana' });
  assert.equal((await h.req('GET', '/')).text, 'app');
  assert.equal((await h.req('GET', '/auth/me')).json.user, 'dana');
});

test('wrong password and unknown user get the same generic 401', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const a = await h.req('POST', '/auth/login', { body: { username: 'dana', password: 'wrong password!' } });
  const b = await h.req('POST', '/auth/login', { body: { username: 'nobody', password: PASSWORD } });
  assert.equal(a.status, 401);
  assert.deepEqual(a.json, b.json);
  assert.equal(b.status, 401);
  assert.ok(!a.text.includes('dana'));
});

test('/auth/totp without (or with expired) pre-auth cookie → 401', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const r = await h.req('POST', '/auth/totp', { body: { code: codeAt(h.clock.t) } });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: 'login_required' });
  await h.req('POST', '/auth/login', { body: { username: 'dana', password: PASSWORD } });
  h.clock.t += 5 * MIN + 1000;
  const late = await h.req('POST', '/auth/totp', { body: { code: codeAt(h.clock.t) } });
  assert.equal(late.status, 401);
  assert.deepEqual(late.json, { error: 'login_required' });
});

test('TOTP code accepted within ±1 step, replay of a used step rejected', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const code = codeAt(h.clock.t);
  h.clock.t += 30_000; // previous step code still within window
  assert.equal((await login(h, { code })).status, 200);
  h.jar.clear();
  const replay = await login(h, { code });
  assert.equal(replay.status, 401);
  assert.deepEqual(replay.json, { error: 'invalid_code' });
  h.jar.clear();
  h.clock.t += 30_000;
  assert.equal((await login(h)).status, 200, 'fresh step works');
});

test('5 wrong TOTP codes → 429 even for a correct code; expires after 15 min', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  await h.req('POST', '/auth/login', { body: { username: 'dana', password: PASSWORD } });
  for (let i = 0; i < 5; i++) {
    const r = await h.req('POST', '/auth/totp', { body: { code: '000000' } });
    assert.equal(r.status, 401);
  }
  const blocked = await h.req('POST', '/auth/totp', { body: { code: codeAt(h.clock.t) } });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.json, { error: 'too_many_attempts' });
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Re-logging in does not reset the counter.
  assert.equal((await h.req('POST', '/auth/login', { body: { username: 'dana', password: PASSWORD } })).status, 429);
  h.clock.t += 15 * MIN + 1000;
  h.jar.clear();
  assert.equal((await login(h)).status, 200);
});

test('5 wrong passwords → 429 even for the right password', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  for (let i = 0; i < 5; i++) {
    assert.equal((await h.req('POST', '/auth/login', { body: { username: 'dana', password: 'nope nope nope' } })).status, 401);
  }
  assert.equal((await h.req('POST', '/auth/login', { body: { username: 'dana', password: PASSWORD } })).status, 429);
});

test('recovery code works exactly once and is removed from auth.json', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const r = await login(h, { code: RECOVERY[0].toLowerCase() });
  assert.equal(r.status, 200);
  assert.equal(loadAuthStore(h.config.auth.filePath).users[0].recoveryCodes.length, 1);
  h.jar.clear();
  assert.equal((await login(h, { code: RECOVERY[0] })).status, 401);
  h.jar.clear();
  assert.equal((await login(h, { code: RECOVERY[1] })).status, 200);
  assert.equal(loadAuthStore(h.config.auth.filePath).users[0].recoveryCodes.length, 0);
});

test('CSRF: non-GET /api/* and /auth/* POSTs need X-Requested-With: dashbank', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const noHdr = await h.req('POST', '/auth/login', { body: { username: 'dana', password: PASSWORD }, csrf: false });
  assert.equal(noHdr.status, 403);
  assert.deepEqual(noHdr.json, { error: 'csrf' });
  assert.equal((await login(h)).status, 200);
  const r = await h.req('POST', '/api/ping', { body: {}, csrf: false });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: 'csrf' });
  const wrong = await h.req('POST', '/api/ping', { body: {}, csrf: false, headers: { 'x-requested-with': 'XMLHttpRequest' } });
  assert.equal(wrong.status, 403);
  const ok = await h.req('POST', '/api/ping', { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.posted, true);
});

test('session expires after 12h; sliding refresh extends it; absolute cap 7 days', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  assert.equal((await login(h)).status, 200);
  h.clock.t += 11 * HOUR;
  const r = await h.req('GET', '/api/ping');
  assert.equal(r.status, 200);
  assert.ok(r.setCookies.some((c) => c.startsWith('db_sess=')), 'refreshed');
  h.clock.t += 11 * HOUR; // 22h after login, 11h after refresh
  assert.equal((await h.req('GET', '/api/ping')).status, 200);
  h.clock.t += 12 * HOUR + 1000; // idle > 12h
  assert.equal((await h.req('GET', '/api/ping')).status, 401);

  h.jar.clear();
  h.clock.t += MIN;
  assert.equal((await login(h)).status, 200);
  for (let i = 0; i < 16; i++) { // 176h > 7 days, refreshed every 11h
    h.clock.t += 11 * HOUR;
    await h.req('GET', '/api/ping');
  }
  assert.equal((await h.req('GET', '/api/ping')).status, 401, 'absolute lifetime exceeded');
});

test('logout clears the session cookie', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  assert.equal((await login(h)).status, 200);
  const r = await h.req('POST', '/auth/logout');
  assert.equal(r.status, 200);
  assert.ok(r.setCookies.some((c) => c.startsWith('db_sess=;') && c.includes('Max-Age=0')));
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
});

test('re-running setup (new password) invalidates existing sessions', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  assert.equal((await login(h)).status, 200);
  const user = await buildUser({ username: 'dana', password: 'another long password', totpSecret: TOTP_SECRET, recoveryCodes: [] }, AUTH_SECRET);
  saveAuthStore(h.config.auth.filePath, { users: [user] });
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
});

test('Secure cookie flag when proxied over HTTPS from loopback', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const r = await h.req('POST', '/auth/login', { body: { username: 'dana', password: PASSWORD }, headers: { 'x-forwarded-proto': 'https' } });
  assert.match(r.setCookies[0], /; Secure$/);
});

test('malformed JSON → 400 JSON, no stack trace', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const r = await h.req('POST', '/auth/login', { body: '{"username":' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: 'bad_request' });
  const big = await h.req('POST', '/auth/login', { body: { username: 'dana', password: 'x'.repeat(20_000) } });
  assert.equal(big.status, 400);
  const types = await h.req('POST', '/auth/login', { body: { username: ['dana'], password: PASSWORD } });
  assert.equal(types.status, 400);
});

test('not configured (no auth.json): everything locked, /auth/me says so', async (t) => {
  const h = await startApp({ withUser: false });
  t.after(() => h.close());
  assert.equal(h.auth.isConfigured(), false);
  assert.deepEqual((await h.req('GET', '/auth/me')).json, { user: null, methods: { password: false, google: false }, configured: false });
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
  assert.equal((await h.req('GET', '/')).status, 302);
  const r = await h.req('POST', '/auth/login', { body: { username: 'dana', password: PASSWORD } });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'not_configured' });
});

test('short AUTH_SECRET counts as not configured', async (t) => {
  const h = await startApp({ env: { AUTH_SECRET: 'too-short' } });
  t.after(() => h.close());
  assert.equal(h.auth.isConfigured(), false);
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
});

test('demo mode: auth disabled, requireAuth passes with user "demo"', async (t) => {
  const h = await startApp({ withUser: false, argv: ['--demo'] });
  t.after(() => h.close());
  assert.equal(h.auth.isConfigured(), true);
  assert.deepEqual((await h.req('GET', '/api/ping')).json, { user: 'demo' });
  assert.equal((await h.req('GET', '/auth/me')).json.user, 'demo');
});

test('auth.json is written 0600 and never contains the plain TOTP secret', async (t) => {
  const h = await startApp();
  t.after(() => h.close());
  const raw = fs.readFileSync(h.config.auth.filePath, 'utf8');
  assert.ok(!raw.includes(TOTP_SECRET));
  assert.ok(!raw.includes(RECOVERY[0]));
  assert.equal(fs.statSync(h.config.auth.filePath).mode & 0o777, 0o600);
});
