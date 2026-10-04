// Renders the PNG app icons from icons/icon.svg with the browser Playwright already uses.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const svg = readFileSync('icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>body{margin:0}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: `icons/${file}` });
}
await browser.close();
