import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, T0 } from './helpers/auth-harness.js';

const CLIENT_ID = 'cid.apps.googleusercontent.com';
const ENV = {
  GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'gsecret',
  AUTH_ALLOWED_EMAILS: 'Dana@Example.com', PUBLIC_URL: 'https://box.tail1234.ts.net/',
};
const REDIRECT = 'https://box.tail1234.ts.net/auth/google/callback';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (pub, kid) => ({ ...pub.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(claims, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = alg === 'RS256' ? crypto.sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url') : '';
  return `${head}.${body}.${sig}`;
}

function fakeGoogle() {
  const state = { calls: { token: 0, certs: 0 }, keys: [jwk(publicKey, 'k1')], mint: null, lastTokenBody: null, tokenStatus: 200 };
  state.fetch = async (url, opts = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      state.calls.token++;
      assert.equal(opts.method, 'POST');
      state.lastTokenBody = new URLSearchParams(String(opts.body));
      if (state.tokenStatus !== 200) return new Response('{"error":"invalid_grant"}', { status: state.tokenStatus });
      return Response.json({ id_token: state.mint(state.lastTokenBody), access_token: 'at', token_type: 'Bearer' });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      state.calls.certs++;
      return Response.json({ keys: state.keys });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return state;
}

const goodClaims = (nonce, over = {}) => ({
  iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: '1234',
  email: 'dana@example.com', email_verified: true, nonce,
  iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600, ...over,
});

async function setup(t) {
  const g = fakeGoogle();
  const h = await startApp({ env: ENV, fetch: g.fetch });
  t.after(() => h.close());
  return { g, h };
}

// Start the flow, have the fake Google mint a token via `claimsFor(nonce)`, then hit the callback.
async function flow(h, g, claimsFor, { jwtOpts, stateOverride, code = 'authcode' } = {}) {
  const start = await h.req('GET', '/auth/google');
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  const nonce = loc.searchParams.get('nonce');
  g.mint = () => signJwt(claimsFor(nonce), jwtOpts);
  const st = stateOverride ?? loc.searchParams.get('state');
  return { start, loc, cb: await h.req('GET', `/auth/google/callback?code=${code}&state=${encodeURIComponent(st)}`) };
}

test('/auth/me advertises google when configured', async (t) => {
  const { h } = await setup(t);
  assert.deepEqual((await h.req('GET', '/auth/me')).json.methods, { password: true, google: true });
});

test('google disabled unless client id, secret, allow-list and PUBLIC_URL are all set', async (t) => {
  const h = await startApp({ env: { ...ENV, AUTH_ALLOWED_EMAILS: '' } });
  t.after(() => h.close());
  assert.equal((await h.req('GET', '/auth/me')).json.methods.google, false);
  assert.equal((await h.req('GET', '/auth/google')).status, 404);
  assert.equal((await h.req('GET', '/auth/google/callback?code=x&state=y')).status, 404);
});

test('GET /auth/google redirects with PKCE, state, nonce and sets a Lax state cookie', async (t) => {
  const { h } = await setup(t);
  const r = await h.req('GET', '/auth/google');
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = Object.fromEntries(loc.searchParams);
  assert.equal(p.client_id, CLIENT_ID);
  assert.equal(p.response_type, 'code');
  assert.equal(p.scope, 'openid email profile');
  assert.equal(p.redirect_uri, REDIRECT);
  assert.equal(p.code_challenge_method, 'S256');
  assert.match(p.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(p.state, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(p.nonce, /^[A-Za-z0-9_-]{32,}$/);
  assert.ok(!r.headers.get('location').includes('gsecret'));
  const c = r.setCookies.find((s) => s.startsWith('db_oauth='));
  assert.match(c, /Max-Age=600; Path=\/auth\/google; HttpOnly; SameSite=Lax/);
});

test('valid callback → session (MFA satisfied by Google), JWKS cached', async (t) => {
  const { g, h } = await setup(t);
  const { loc, cb } = await flow(h, g, (n) => goodClaims(n));
  assert.equal(cb.status, 200);
  assert.match(cb.headers.get('content-type'), /text\/html/);
  assert.match(cb.text, /http-equiv="refresh" content="0;url=\/"/);
  assert.equal(cb.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(cb.setCookies.some((c) => c.startsWith('db_sess=') && /SameSite=Strict/.test(c)));
  assert.ok(!h.jar.has('db_oauth'), 'state cookie cleared');

  const body = g.lastTokenBody;
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'authcode');
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('client_secret'), 'gsecret');
  assert.equal(body.get('redirect_uri'), REDIRECT);
  const challenge = crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url');
  assert.equal(challenge, loc.searchParams.get('code_challenge'));

  const ping = await h.req('GET', '/api/ping');
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json, { user: 'dana@example.com' });

  h.jar.clear();
  assert.equal((await flow(h, g, (n) => goodClaims(n, { iss: 'accounts.google.com', aud: [CLIENT_ID] }))).cb.status, 200);
  assert.equal(g.calls.certs, 1, 'JWKS fetched once (cached 1h)');
});

const rejections = {
  'wrong aud': (n) => goodClaims(n, { aud: 'someone-else', azp: 'someone-else' }),
  'wrong aud, no azp': (n) => goodClaims(n, { aud: 'someone-else', azp: undefined }),
  'wrong azp': (n) => goodClaims(n, { aud: [CLIENT_ID, 'other'], azp: 'other' }),
  'wrong nonce': (n) => goodClaims(`${n}x`),
  'missing nonce': (n) => goodClaims(n, { nonce: undefined }),
  'unlisted email': (n) => goodClaims(n, { email: 'eve@example.com' }),
  'email not verified': (n) => goodClaims(n, { email_verified: false }),
  'email_verified as string': (n) => goodClaims(n, { email_verified: 'true' }),
  'wrong issuer': (n) => goodClaims(n, { iss: 'https://evil.example' }),
  expired: (n) => goodClaims(n, { exp: Math.floor(T0 / 1000) - 120 }),
  'issued in the future': (n) => goodClaims(n, { iat: Math.floor(T0 / 1000) + 3600 }),
};

for (const [name, claims] of Object.entries(rejections)) {
  test(`google callback rejects: ${name}`, async (t) => {
    const { g, h } = await setup(t);
    const { cb } = await flow(h, g, claims);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/login.html?error=google');
    assert.ok(!cb.setCookies.some((c) => c.startsWith('db_sess=') && !c.includes('Max-Age=0')));
    assert.equal((await h.req('GET', '/api/ping')).status, 401);
  });
}

test('google callback rejects bad signatures and algorithms', async (t) => {
  const { g, h } = await setup(t);
  for (const jwtOpts of [{ key: other.privateKey }, { alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }]) {
    h.jar.clear();
    const { cb } = await flow(h, g, (n) => goodClaims(n), { jwtOpts });
    assert.equal(cb.headers.get('location'), '/login.html?error=google', JSON.stringify(jwtOpts));
  }
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
});

test('google callback rejects state mismatch / missing state cookie without calling Google', async (t) => {
  const { g, h } = await setup(t);
  const { cb } = await flow(h, g, (n) => goodClaims(n), { stateOverride: 'forged' });
  assert.equal(cb.headers.get('location'), '/login.html?error=google');
  h.jar.clear();
  const none = await h.req('GET', '/auth/google/callback?code=x&state=y');
  assert.equal(none.headers.get('location'), '/login.html?error=google');
  const err = await h.req('GET', '/auth/google/callback?error=access_denied');
  assert.equal(err.headers.get('location'), '/login.html?error=google');
  assert.equal(g.calls.token, 0);
});

test('google callback handles token endpoint failure', async (t) => {
  const { g, h } = await setup(t);
  g.tokenStatus = 400;
  const { cb } = await flow(h, g, (n) => goodClaims(n));
  assert.equal(cb.headers.get('location'), '/login.html?error=google');
});

test('unknown kid triggers one JWKS refresh (key rotation)', async (t) => {
  const { g, h } = await setup(t);
  assert.equal((await flow(h, g, (n) => goodClaims(n))).cb.status, 200);
  g.keys = [jwk(publicKey, 'k1'), jwk(other.publicKey, 'k2')];
  h.clock.t += 5 * 60_000;
  h.jar.clear();
  const { cb } = await flow(h, g, (n) => goodClaims(n, { iat: Math.floor(h.clock.t / 1000) }), { jwtOpts: { key: other.privateKey, kid: 'k2' } });
  assert.equal(cb.status, 200);
  assert.equal(g.calls.certs, 2);
});

test('google session ends when the email is removed from the allow-list', async (t) => {
  const g = fakeGoogle();
  const h = await startApp({ env: ENV, fetch: g.fetch });
  t.after(() => h.close());
  assert.equal((await flow(h, g, (n) => goodClaims(n))).cb.status, 200);
  h.config.auth.allowedEmails = ['someone@else.com'];
  assert.equal((await h.req('GET', '/api/ping')).status, 401);
});
