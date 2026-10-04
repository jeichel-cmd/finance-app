// End-to-end check in a phone-sized browser: set up, read real screenshots with the on-device reader,
// save, detect a mismatch and fix it. Writes screenshots of each screen to tests/output/.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve('.');
const out = 'tests/output';
await mkdir(out, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });

// Sample banking screenshots, drawn as simple HTML.
async function drawScreenshot(name, html, dark = false) {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await p.setContent(`<style>body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:${dark ? '#0b0e11' : '#fff'};color:${dark ? '#eaecef' : '#111'}}
    .h{padding:24px 20px 8px;font-size:20px;font-weight:700}.b{padding:0 20px;font-size:13px;color:#888}.big{padding:4px 20px 20px;font-size:34px;font-weight:700}
    .d{padding:14px 20px 4px;font-size:13px;color:#888}.r{display:flex;justify-content:space-between;padding:12px 20px;font-size:16px;border-bottom:1px solid ${dark ? '#222' : '#eee'}}</style>${html}`);
  const path = `${out}/sample-${name}.png`;
  await p.screenshot({ path });
  await p.close();
  return path;
}

const bankShot = await drawScreenshot('bank', `
  <div class="h">Sparkasse</div><div class="b">Girokonto</div><div class="b">Kontostand</div><div class="big">2.346,84 €</div>
  <div class="d">Heute</div>
  <div class="r"><span>REWE Markt GmbH</span><span>-42,17 €</span></div>
  <div class="d">Gestern</div>
  <div class="r"><span>PayPal Europe</span><span>-10,99 €</span></div>
  <div class="r"><span>Lieferando</span><span>-24,80 €</span></div>
  <div class="d">01.10.2026</div>
  <div class="r"><span>Miete Oktober</span><span>-820,00 €</span></div>
  <div class="r"><span>Gehalt</span><span>+3.120,00 €</span></div>`);

const paypalShot = await drawScreenshot('paypal', `
  <div class="h">PayPal</div><div class="b">PayPal balance</div><div class="big">€63.50</div>
  <div class="d">Recent activity</div>
  <div class="r"><span>Spotify</span><span>-€10.99</span></div>
  <div class="r"><span>Zalando refund</span><span>+€13.50</span></div>`);

const krakenShot = await drawScreenshot('kraken', `
  <div class="h">Kraken</div><div class="b">Total balance</div><div class="big">€1,807.00</div>
  <div class="r"><span>Bitcoin</span><span>0.0123 BTC</span></div>
  <div class="r"><span>Ethereum</span><span>0.41 ETH</span></div>`, true);

const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
const external = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/^Estimating resolution/.test(m.text())) errors.push(m.text()); });
page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });

const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
const step = (s) => console.log('·', s);

await page.goto(base);
await page.getByLabel('Choose a passcode').fill('246810');
await page.getByLabel('Repeat it').fill('246810');
await shot('01-setup');
await page.getByRole('button', { name: 'Get started' }).click();
await page.getByText('Add your first account').waitFor();
await shot('02-empty');
step('set up');

async function scan(file, { account } = {}) {
  await page.goto(base + '#/scan' + (account ? `?account=${account}` : ''));
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByText('Check what was read').waitFor({ timeout: 180000 });
}

// 1. Bank screenshot creates the account with its starting balance.
await scan(bankShot);
await shot('03-review-bank');
const bankText = await page.locator('pre').textContent();
const payees = await page.locator('[data-row-field=payee]').evaluateAll((els) => els.map((e) => e.value));
const amounts = await page.locator('[data-row-field=amount]').evaluateAll((els) => els.map((e) => e.value));
console.log('  read:', payees.map((p, i) => `${p} ${amounts[i]}`).join(' | '));
if (payees.length < 5) throw new Error('expected 5 bank transactions, got ' + payees.length + '\n' + bankText);
const balance = await page.locator('[data-draft=balance]').inputValue();
if (!/2\.?346[.,]84/.test(balance)) throw new Error('bank balance read as ' + balance);
await page.locator('[data-draft=newName]').fill('Sparkasse Giro');
await page.getByRole('button', { name: 'Save' }).click();
await page.getByText('Sparkasse Giro', { exact: true }).first().waitFor();
await shot('04-account-bank');
step('bank saved');

// 2. Add PayPal by hand, paid from the bank, then a screenshot with one payment the app doesn't know.
await page.goto(base + '#/account-edit/new');
await page.getByLabel('Name').fill('PayPal');
await page.getByLabel('Type').selectOption('wallet');
await page.getByLabel('Payments are usually taken from').selectOption({ label: 'Sparkasse Giro' });
await page.getByLabel('Current balance (optional)').fill('50');
await page.getByRole('button', { name: 'Add account' }).click();
await page.waitForURL(/#\/account\//);
const paypalId = page.url().split('/').pop();

await scan(paypalShot, { account: paypalId });
await shot('05-review-paypal');
// Leave the refund unticked so the balance doesn't match.
const rows = page.locator('.tx-edit');
const n = await rows.count();
for (let i = 0; i < n; i++) {
  const payee = await rows.nth(i).locator('[data-row-field=payee]').inputValue();
  if (/zalando/i.test(payee)) await rows.nth(i).locator('[data-row-field=include]').uncheck();
}
await page.getByRole('button', { name: 'Save' }).click();
await page.getByText("doesn't match").first().waitFor();
await shot('06-mismatch');
step('mismatch found');
await page.getByRole('button', { name: 'Add it' }).click();
await page.getByText('PayPal matches').waitFor();
await shot('07-fixed');
step('mismatch fixed');

// 3. Dark-mode exchange screenshot.
await scan(krakenShot);
await page.locator('[data-draft=newName]').fill('Kraken');
await page.getByLabel('Type').selectOption('crypto');
await shot('08-review-kraken');
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForURL(/#\/account\//);

await page.goto(base + '#/');
await page.getByText('Total', { exact: true }).waitFor();
await shot('09-overview');
const total = await page.locator('.big-number').textContent();
console.log('  total:', total);

await page.goto(base + '#/spending');
await shot('10-spending');
const spent = await page.locator('.card .mid-number').first().textContent();
console.log('  spent this month:', spent);

await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(base + '#/');
await shot('11-overview-dark');

// Lock and unlock: data survives, wrong passcode refused.
await page.getByRole('button', { name: 'Lock' }).click();
await page.getByLabel('Passcode').fill('000000');
await page.getByRole('button', { name: 'Unlock' }).click();
await page.getByText('That passcode is not right').waitFor();
await page.getByLabel('Passcode').fill('246810');
await page.getByRole('button', { name: 'Unlock' }).click();
await page.getByText('Sparkasse Giro').waitFor();
step('lock and unlock');

const stored = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('finance-app');
  r.onsuccess = () => r.result.transaction('vault').objectStore('vault').get('data').onsuccess = (e) => res(JSON.stringify(e.target.result));
}));
if (/Sparkasse|REWE|Spotify/.test(stored)) throw new Error('data stored unencrypted');
step('storage is encrypted');

await browser.close();
server.close();
if (external.length) throw new Error('requests left the device: ' + external.join(', '));
if (errors.length) throw new Error('browser errors: ' + errors.join('\n'));
console.log('e2e passed; no requests to other servers');
