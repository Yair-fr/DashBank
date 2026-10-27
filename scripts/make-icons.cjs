#!/usr/bin/env node
// Renders public/icons/icon.svg into the PNG icons referenced by the web manifest.
// Usage: node scripts/make-icons.cjs  (needs Playwright + Chromium; e.g. NODE_PATH="$(npm root -g)")
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const dir = path.join(__dirname, '..', 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
// Maskable / apple: full-bleed square, artwork shrunk into the 80% safe zone.
const maskable = svg
  .replace('rx="116"', 'rx="0"')
  .replace(/(<rect x="132"[\s\S]*?)(<\/svg>)/, '<g transform="translate(51.2 51.2) scale(0.8)">$1</g>\n$2');

const targets = [
  { file: 'icon-192.png', size: 192, src: svg },
  { file: 'icon-512.png', size: 512, src: svg },
  { file: 'maskable-512.png', size: 512, src: maskable },
  { file: 'apple-touch-icon.png', size: 180, src: maskable },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const t of targets) {
    await page.setViewportSize({ width: t.size, height: t.size });
    const sized = t.src.replace('<svg ', `<svg width="${t.size}" height="${t.size}" `);
    await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
    await page.screenshot({ path: path.join(dir, t.file), omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
    console.log('wrote', t.file);
  }
  await browser.close();
})();
