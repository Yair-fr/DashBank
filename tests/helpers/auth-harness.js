// Shared harness for auth route tests: temp data dir, real express app on port 0, cookie jar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { loadConfig } from '../../src/config.js';
import { createAuth } from '../../src/auth/routes.js';
import { buildUser, saveAuthStore } from '../../src/auth/store.js';

export const AUTH_SECRET = 'f'.repeat(64);
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const PASSWORD = 'correct horse battery';
export const RECOVERY = ['AAAAA-BBBBB', 'CCCCC-DDDDD'];
export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

export async function startApp({ env = {}, withUser = true, fetch, argv = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbauth-'));
  const config = loadConfig({ DASHBANK_DATA_DIR: dir, AUTH_SECRET, ...env }, argv);
  if (withUser) {
    const user = await buildUser({ username: 'dana', password: PASSWORD, totpSecret: TOTP_SECRET, recoveryCodes: RECOVERY }, AUTH_SECRET);
    saveAuthStore(config.auth.filePath, { users: [user] });
  }
  const clock = { t: T0 };
  const auth = createAuth({ config, fetch, now: () => clock.t });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(auth.router);
  app.use(auth.requireAuth);
  app.get('/', (req, res) => res.send('app'));
  app.get('/api/ping', (req, res) => res.json({ user: req.user }));
  app.post('/api/ping', (req, res) => res.json({ user: req.user, posted: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();

  async function req(method, url, { body, headers = {}, csrf = true, cookies = true } = {}) {
    const h = { ...headers };
    if (cookies && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) { h['content-type'] = 'application/json'; }
    if (csrf && method !== 'GET') h['x-requested-with'] = 'dashbank';
    const res = await fetch_(base + url, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq), value = pair.slice(eq + 1);
      if (/Max-Age=0/.test(c) || value === '') jar.delete(name); else jar.set(name, value);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, setCookies, text, json };
  }

  return {
    config, auth, clock, jar, base, req,
    async close() {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The test's global fetch, kept separate from any fake injected into createAuth.
const fetch_ = globalThis.fetch;
