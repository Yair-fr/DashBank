// Auth HTTP layer: password + TOTP login, optional Google OIDC, session middleware with CSRF check.
//
//   const auth = createAuth({ config });
//   app.set('trust proxy', 'loopback');   // so req.secure / req.ip work behind `tailscale serve`
//   app.use(auth.router);                 // /auth/*
//   app.use(auth.requireAuth);            // everything after this needs a session
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { log } from '../log.js';
import { verifyPassword, dummyHash } from './password.js';
import { findTotpStep } from './totp.js';
import { deriveKey, signToken, verifyToken, parseCookies, serializeCookie } from './session.js';
import { loadAuthStore, saveAuthStore, decryptSecret, matchRecoveryCode, normalizeUsername } from './store.js';
import { createRateLimiter } from './ratelimit.js';
import { createGoogle, pkcePair, randomToken } from './google.js';

const MIN = 60 * 1000, HOUR = 60 * MIN;
export const SESSION_TTL = 12 * HOUR;
export const SESSION_MAX_AGE = 7 * 24 * HOUR; // absolute cap on sliding refresh
const REFRESH_AFTER = 10 * MIN;
const PRE_TTL = 5 * MIN;
const OAUTH_TTL = 10 * MIN;
const MIN_SECRET_LENGTH = 32;
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'dashbank';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const SESS = 'db_sess', PRE = 'db_pre', OAUTH = 'db_oauth';

export function createAuth({ config, fetch = globalThis.fetch, now = () => Date.now() }) {
  const auth = () => config.auth;
  const secretOk = () => typeof auth().secret === 'string' && auth().secret.length >= MIN_SECRET_LENGTH;
  if (!config.demo && auth().secret && !secretOk()) {
    log.warn('AUTH_SECRET too short; authentication disabled until fixed', { minLength: MIN_SECRET_LENGTH });
  }
  let keys = null;
  const key = (purpose) => {
    if (!keys || keys.secret !== auth().secret) {
      const s = auth().secret;
      keys = { secret: s, sess: deriveKey(s, 'session'), pre: deriveKey(s, 'pre'), oauth: deriveKey(s, 'oauth'), fp: deriveKey(s, 'fingerprint') };
    }
    return keys[purpose];
  };

  // ---- store (re-read when the file changes, e.g. after `npm run auth-setup`) ----
  let cache = { sig: null, data: null };
  function getStore() {
    let st;
    try {
      st = fs.statSync(auth().filePath);
    } catch {
      cache = { sig: null, data: null };
      return null;
    }
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (sig !== cache.sig) {
      try {
        cache = { sig, data: loadAuthStore(auth().filePath) };
      } catch (e) {
        log.error('auth.json unreadable', { error: e.message });
        cache = { sig, data: null };
      }
    }
    return cache.data;
  }
  const findUser = (username) => getStore()?.users.find((u) => u.username === username) || null;
  const hasPasswordUsers = () => secretOk() && Boolean(getStore()?.users.some((u) => u.passwordHash && u.totpSecret));

  const googleEnabled = () => {
    const a = auth();
    return secretOk() && Boolean(a.google.clientId && a.google.clientSecret && a.allowedEmails.length && a.publicUrl);
  };
  const google = createGoogle({
    fetch,
    now,
    settings: () => ({ ...auth().google, redirectUri: `${auth().publicUrl}/auth/google/callback` }),
  });

  const isConfigured = () => Boolean(config.demo) || hasPasswordUsers() || googleEnabled();

  // Binds a session to the current credentials: re-running auth-setup logs every session out.
  const fingerprint = (user) => crypto.createHmac('sha256', key('fp')).update(`${user.passwordHash}|${user.totpSecret}`).digest('base64url').slice(0, 22);

  // ---- rate limiting ----
  const userLimiter = createRateLimiter({ max: 5, windowMs: 15 * MIN, now });
  const ipLimiter = createRateLimiter({ max: 20, windowMs: 15 * MIN, now });
  const lastTotpStep = new Map(); // username -> last accepted time-step (replay protection)

  const limitKeys = (req, username) => [`${req.ip}|${username}`, `${req.ip}`];
  const blockedFor = (req, username) => Math.max(userLimiter.blocked(limitKeys(req, username)[0]), ipLimiter.blocked(limitKeys(req, username)[1]));
  const recordFailure = (req, username) => {
    const [u, ip] = limitKeys(req, username);
    userLimiter.fail(u);
    ipLimiter.fail(ip);
  };
  const clearFailures = (req, username) => {
    const [u, ip] = limitKeys(req, username);
    userLimiter.reset(u);
    ipLimiter.reset(ip);
  };
  const tooMany = (res, ms) => {
    res.set('Retry-After', String(Math.ceil(ms / 1000)));
    return res.status(429).json({ error: 'too_many_attempts' });
  };

  // ---- cookies / sessions ----
  const cookie = (req, res, name, value, maxAgeMs, opts = {}) => {
    res.append('Set-Cookie', serializeCookie(name, value, { maxAge: maxAgeMs / 1000, secure: req.secure, ...opts }));
  };
  const clearCookie = (req, res, name, opts = {}) => cookie(req, res, name, '', 0, opts);

  function issueSession(req, res, { u, m, h, at = now() }) {
    const exp = Math.min(now() + SESSION_TTL, at + SESSION_MAX_AGE);
    const payload = { t: 'sess', u, m, mfa: true, at, exp };
    if (h) payload.h = h;
    cookie(req, res, SESS, signToken(payload, key('sess')), exp - now());
  }

  function currentSession(req) {
    if (!secretOk()) return null;
    const s = verifyToken(parseCookies(req.headers.cookie)[SESS], key('sess'), { now: now(), type: 'sess' });
    if (!s || s.mfa !== true || typeof s.u !== 'string' || typeof s.at !== 'number') return null;
    if (now() - s.at >= SESSION_MAX_AGE) return null;
    if (s.m === 'pw') {
      const user = findUser(s.u);
      if (!user || s.h !== fingerprint(user)) return null;
    } else if (s.m === 'google') {
      if (!googleEnabled() || !auth().allowedEmails.includes(s.u)) return null;
    } else {
      return null;
    }
    return s;
  }

  const apiPath = (req) => {
    const p = (req.baseUrl || '') + req.path;
    return p === '/api' || p.startsWith('/api/');
  };
  const csrfOk = (req) => SAFE_METHODS.has(req.method) || req.get(CSRF_HEADER) === CSRF_VALUE;

  function requireAuth(req, res, next) {
    const isApi = apiPath(req);
    if (config.demo) {
      if (isApi && !csrfOk(req)) return res.status(403).json({ error: 'csrf' });
      req.user = 'demo';
      return next();
    }
    const s = currentSession(req);
    if (!s) {
      res.set('Cache-Control', 'no-store');
      return isApi ? res.status(401).json({ error: 'unauthorized' }) : res.redirect(302, '/login.html');
    }
    if (isApi && !csrfOk(req)) return res.status(403).json({ error: 'csrf' });
    if (s.exp - now() < SESSION_TTL - REFRESH_AFTER) issueSession(req, res, s);
    req.user = s.u;
    return next();
  }

  // ---- router ----
  const router = express.Router();
  router.use('/auth', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!csrfOk(req)) return res.status(403).json({ error: 'csrf' });
    return next();
  });
  router.use('/auth', express.json({ limit: '10kb' }));

  const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

  router.get('/auth/me', (req, res) => {
    const s = config.demo ? { u: 'demo' } : currentSession(req);
    res.json({
      user: s ? s.u : null,
      methods: { password: hasPasswordUsers(), google: googleEnabled() },
      configured: isConfigured(),
    });
  });

  router.post('/auth/login', async (req, res, next) => {
    try {
      if (!hasPasswordUsers()) return res.status(503).json({ error: 'not_configured' });
      const rawUser = str(req.body?.username, 128);
      const password = str(req.body?.password, 1024);
      if (!rawUser || !password) return res.status(400).json({ error: 'bad_request' });
      const username = normalizeUsername(rawUser);
      const wait = blockedFor(req, username);
      if (wait) return tooMany(res, wait);

      const user = findUser(username);
      const ok = await verifyPassword(password, user ? user.passwordHash : await dummyHash());
      if (!ok || !user) {
        recordFailure(req, username);
        log.warn('login failed', { ip: req.ip });
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      cookie(req, res, PRE, signToken({ t: 'pre', u: user.username, h: fingerprint(user), exp: now() + PRE_TTL }, key('pre')), PRE_TTL);
      return res.json({ next: 'totp' });
    } catch (e) {
      return next(e);
    }
  });

  router.post('/auth/totp', (req, res) => {
    const pre = secretOk() ? verifyToken(parseCookies(req.headers.cookie)[PRE], key('pre'), { now: now(), type: 'pre' }) : null;
    const user = pre && findUser(pre.u);
    if (!user || pre.h !== fingerprint(user)) return res.status(401).json({ error: 'login_required' });
    const code = str(req.body?.code, 32);
    if (!code) return res.status(400).json({ error: 'bad_request' });
    const wait = blockedFor(req, user.username);
    if (wait) return tooMany(res, wait);

    let secret;
    try {
      secret = decryptSecret(user.totpSecret, auth().secret);
    } catch {
      log.error('cannot decrypt TOTP secret (AUTH_SECRET changed?) - rerun npm run auth-setup');
      return res.status(500).json({ error: 'server_error' });
    }

    let ok = false;
    const step = findTotpStep(secret, code, { time: Math.floor(now() / 1000), window: 1 });
    if (step !== null) {
      // Reject any step at or before the last accepted one (replay inside the ±1 window).
      if (step > (lastTotpStep.get(user.username) ?? -1)) {
        lastTotpStep.set(user.username, step);
        ok = true;
      }
    } else {
      const idx = matchRecoveryCode(user.recoveryCodes, code, auth().secret);
      if (idx >= 0) {
        // Single use: persist removal before accepting (sync, so no concurrent reuse).
        const store = getStore();
        const stored = store.users.find((u) => u.username === user.username);
        stored.recoveryCodes = stored.recoveryCodes.filter((_, i) => i !== idx);
        saveAuthStore(auth().filePath, store);
        log.warn('recovery code used', { user: user.username, remaining: stored.recoveryCodes.length });
        ok = true;
      }
    }

    if (!ok) {
      recordFailure(req, user.username);
      log.warn('second factor failed', { ip: req.ip });
      return res.status(401).json({ error: 'invalid_code' });
    }
    clearFailures(req, user.username);
    clearCookie(req, res, PRE);
    const fresh = findUser(user.username);
    issueSession(req, res, { u: user.username, m: 'pw', h: fingerprint(fresh) });
    log.info('login', { user: user.username, method: 'password+totp' });
    return res.json({ ok: true, user: user.username });
  });

  router.post('/auth/logout', (req, res) => {
    clearCookie(req, res, SESS);
    clearCookie(req, res, PRE);
    res.json({ ok: true });
  });

  router.get('/auth/google', (req, res) => {
    if (!googleEnabled()) return res.status(404).json({ error: 'not_found' });
    const state = randomToken(), nonce = randomToken();
    const { verifier, challenge } = pkcePair();
    const token = signToken({ t: 'oauth', s: state, n: nonce, v: verifier, exp: now() + OAUTH_TTL }, key('oauth'));
    // Lax (not Strict): the callback is a cross-site top-level navigation from accounts.google.com.
    cookie(req, res, OAUTH, token, OAUTH_TTL, { sameSite: 'Lax', path: '/auth/google' });
    return res.redirect(302, google.authUrl({ state, nonce, codeChallenge: challenge }));
  });

  router.get('/auth/google/callback', async (req, res) => {
    if (!googleEnabled()) return res.status(404).json({ error: 'not_found' });
    res.set('Referrer-Policy', 'no-referrer');
    const fail = (reason) => {
      log.warn('google login rejected', { reason, ip: req.ip });
      clearCookie(req, res, OAUTH, { sameSite: 'Lax', path: '/auth/google' });
      return res.redirect(302, '/login.html?error=google');
    };
    const ipKey = `${req.ip}|google`;
    if (userLimiter.blocked(ipKey)) return fail('rate_limited');
    if (req.query.error) return fail('provider_error');
    const oauth = verifyToken(parseCookies(req.headers.cookie)[OAUTH], key('oauth'), { now: now(), type: 'oauth' });
    if (!oauth) return fail('state_missing');
    const state = str(req.query.state, 256);
    const code = str(req.query.code, 2048);
    const sa = crypto.createHash('sha256').update(String(state)).digest();
    const sb = crypto.createHash('sha256').update(String(oauth.s)).digest();
    if (!state || !code || !crypto.timingSafeEqual(sa, sb)) return fail('state_mismatch');

    let claims;
    try {
      const idToken = await google.exchangeCode(code, oauth.v);
      claims = await google.verifyIdToken(idToken, { nonce: oauth.n, allowedEmails: auth().allowedEmails });
    } catch (e) {
      userLimiter.fail(ipKey);
      return fail(e.code || 'error');
    }
    userLimiter.reset(ipKey);
    clearCookie(req, res, OAUTH, { sameSite: 'Lax', path: '/auth/google' });
    issueSession(req, res, { u: claims.email, m: 'google' });
    log.info('login', { user: claims.email, method: 'google' });
    // A same-origin hop: a 302 here would still count as cross-site, and the browser would
    // then withhold the SameSite=Strict session cookie on the request for "/".
    res.type('html').send('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>DashBank</title><a href="/">המשך ל-DashBank</a>');
  });

  // JSON errors only: never leak stack traces from body parsing or handlers (4-arg signature is required).
  router.use('/auth', (err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? 400 : 500;
    if (status === 500) log.error('auth error', { error: err.message });
    res.status(status).json({ error: status === 400 ? 'bad_request' : 'server_error' });
  });

  return { router, requireAuth, isConfigured };
}
