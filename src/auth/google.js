// Google OpenID Connect (authorization code + PKCE). id_token verified locally against Google's JWKS.
// A successful Google login counts as MFA-satisfied: we rely on the Google account's own 2-Step Verification.
import crypto from 'node:crypto';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const JWKS_TTL = 60 * 60 * 1000;
const JWKS_MIN_REFRESH = 60 * 1000;
const SKEW = 60 * 1000;
const TIMEOUT = 10_000;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function pkcePair() {
  const verifier = randomToken(32);
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function reject(code) {
  const e = new Error(`google id_token rejected: ${code}`);
  e.code = code;
  return e;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y) && a === b;
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw reject('malformed');
  }
}

/**
 * createGoogle({ settings: () => ({ clientId, clientSecret, redirectUri }), fetch, now })
 *   → { authUrl({state, nonce, codeChallenge}), exchangeCode(code, verifier), verifyIdToken(token, {nonce, allowedEmails}) }
 * `settings` is a getter so the current config is read on every call. JWKS is cached for 1h.
 */
export function createGoogle({ settings, fetch = globalThis.fetch, now = () => Date.now() }) {
  let jwks = { keys: new Map(), fetchedAt: -Infinity };
  let inflight = null;

  async function loadJwks() {
    inflight ??= (async () => {
      try {
        const res = await fetch(CERTS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) throw reject('jwks_http');
        const body = await res.json();
        const keys = new Map();
        for (const k of Array.isArray(body?.keys) ? body.keys : []) {
          if (k?.kty !== 'RSA' || typeof k.kid !== 'string') continue;
          if (k.alg !== undefined && k.alg !== 'RS256') continue;
          if (k.use !== undefined && k.use !== 'sig') continue;
          try {
            keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
          } catch { /* skip unusable key */ }
        }
        jwks = { keys, fetchedAt: now() };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid) {
    if (now() - jwks.fetchedAt > JWKS_TTL) await loadJwks();
    if (!jwks.keys.has(kid) && now() - jwks.fetchedAt > JWKS_MIN_REFRESH) await loadJwks();
    const key = jwks.keys.get(kid);
    if (!key) throw reject('unknown_kid');
    return key;
  }

  return {
    authUrl({ state, nonce, codeChallenge }) {
      const { clientId, redirectUri } = settings();
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${AUTH_URL}?${q}`;
    },

    async exchangeCode(code, verifier) {
      const { clientId, clientSecret, redirectUri } = settings();
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, code_verifier: verifier,
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw reject('token_http');
      const body = await res.json().catch(() => null);
      if (typeof body?.id_token !== 'string') throw reject('token_missing');
      return body.id_token;
    },

    async verifyIdToken(token, { nonce, allowedEmails }) {
      const { clientId } = settings();
      const parts = String(token).split('.');
      if (parts.length !== 3) throw reject('malformed');
      const header = decodePart(parts[0]);
      if (header?.alg !== 'RS256') throw reject('alg');
      if (typeof header.kid !== 'string') throw reject('kid');
      const key = await keyFor(header.kid);
      const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
      if (!ok) throw reject('signature');

      const c = decodePart(parts[1]);
      if (!c || typeof c !== 'object') throw reject('malformed');
      if (!ISSUERS.has(c.iss)) throw reject('iss');
      const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
      if (!auds.includes(clientId)) throw reject('aud');
      if (c.azp !== undefined && c.azp !== clientId) throw reject('azp');
      const t = now();
      if (typeof c.exp !== 'number' || c.exp * 1000 + SKEW <= t) throw reject('exp');
      if (c.iat !== undefined && (typeof c.iat !== 'number' || c.iat * 1000 - SKEW > t)) throw reject('iat');
      if (!safeEqual(c.nonce, nonce)) throw reject('nonce');
      if (c.email_verified !== true) throw reject('email_unverified');
      const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
      if (!email || !allowedEmails.includes(email)) throw reject('email_not_allowed');
      return { email, sub: c.sub, name: typeof c.name === 'string' ? c.name : undefined };
    },
  };
}
