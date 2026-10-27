// Regenerates docs/screenshots/*.png from the demo dataset.
// Requires Playwright with Chromium (not a project dependency):
//   npx playwright install chromium   (once)
//   node --disable-warning=ExperimentalWarning scripts/screenshots.mjs [--lang en|he]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/demo.js';
import { createApp } from '../src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'screenshots');
const lang = process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : null;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    // Fall back to a globally installed Playwright (ESM imports ignore NODE_PATH).
    const { execSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const globalRoot = execSync('npm root -g').toString().trim();
    ({ chromium } = createRequire(path.join(globalRoot, 'noop.js'))('playwright'));
  } catch {
    console.error('Playwright is not installed. Run: npm i -g playwright && npx playwright install chromium');
    process.exit(1);
  }
}

const db = openDb(':memory:');
seedDemo(db);
const server = createApp({ db, config: { demo: true } }).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/`;
fs.mkdirSync(outDir, { recursive: true });

const desktop = { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const browser = await chromium.launch();
async function shot(name, ctxOpts, prepare = async () => {}) {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', ...ctxOpts });
  if (lang) await ctx.addInitScript((l) => { try { localStorage.setItem('dashbank.lang', l); } catch {} }, lang);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForTimeout(1500);
  await prepare(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  await ctx.close();
  console.log('✓', name);
}
const tab = (t) => async (page) => page.click(`#tabbar .tab[data-tab="${t}"]`);

try {
  await shot('desktop-light', desktop);
  await shot('desktop-dark', { ...desktop, colorScheme: 'dark' });
  await shot('mobile-overview', mobile);
  await shot('mobile-overview-dark', { ...mobile, colorScheme: 'dark' });
  await shot('mobile-transactions', mobile, tab('txns'));
  await shot('mobile-recurring', mobile, tab('recurring'));
  await shot('mobile-detail', mobile, async (page) => { await tab('txns')(page); await page.waitForTimeout(400); await page.click('.txn-row'); });
} finally {
  await browser.close();
  server.close();
  db.close();
}
