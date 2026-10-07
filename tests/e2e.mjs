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
const base = `http://localhost:${server.address().port}/`;

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

// The same account later: Lieferando isn't there, a cinema payment is new.
const findShot = await drawScreenshot('find', `
  <div class="h">Sparkasse</div><div class="b">Girokonto</div><div class="b">Kontostand</div><div class="big">2.356,64 €</div>
  <div class="d">Heute</div>
  <div class="r"><span>REWE Markt GmbH</span><span>-42,17 €</span></div>
  <div class="d">Gestern</div>
  <div class="r"><span>PayPal Europe</span><span>-10,99 €</span></div>
  <div class="r"><span>Kino Ulm</span><span>-15,00 €</span></div>
  <div class="d">01.10.2026</div>
  <div class="r"><span>Miete Oktober</span><span>-820,00 €</span></div>
  <div class="r"><span>Gehalt</span><span>+3.120,00 €</span></div>`);

const paypalShot = await drawScreenshot('paypal', `
  <div class="h">PayPal</div><div class="b">PayPal balance</div><div class="big">€63.50</div>
  <div class="d">Recent activity</div>
  <div class="r"><span>Spotify</span><span>-€10.99</span></div>
  <div class="r"><span>Zalando refund</span><span>+€13.50</span></div>`);

const krakenShot = await drawScreenshot('kraken', `
  <div class="h">Kraken</div><div class="b">Total balance</div><div class="big">$1,950.00</div>
  <div class="r"><span>Bitcoin</span><span>0.0123 BTC</span></div>
  <div class="r"><span>Ethereum</span><span>0.41 ETH</span></div>`, true);

const overviewShot = await drawScreenshot('overview', `
  <div class="h">Home</div><div class="big">€1,597.63</div><div class="b">Current accounts (2/3) ></div>
  <div class="r"><span>Girokonto</span><span>€1,597.63</span></div>
  <div class="r"><span>Gemeinschaftskonto</span><span>€2,400.00</span></div>
  <div class="r"><span>Personalize</span><span></span></div>`);

const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const errors = [];
const external = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/^Estimating resolution/.test(m.text())) errors.push(m.text()); });
page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:') && !r.url().startsWith('https://api.frankfurter.')) external.push(r.url()); });
// The only allowed outside request: the ECB dollar rate, answered here with a fixed rate.
let rateRequests = 0;
await page.route('https://api.frankfurter.**/**', (route) => { rateRequests++; route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ amount: 1, base: 'USD', date: '2026-10-02', rates: { EUR: 0.9 } }) }); });

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

async function scan(file, { account, mode = 'payments' } = {}) {
  await page.goto(base + '#/scan' + (account ? `?account=${account}` : ''));
  await page.locator(account ? 'input[type=file]' : `input[data-mode=${mode}]`).setInputFiles(file);
  await page.getByText(mode === 'balances' ? 'Check the balances' : 'Check what was read').waitFor({ timeout: 180000 });
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

// 3. Dark-mode exchange screenshot in dollars, as a balance.
await scan(krakenShot, { mode: 'balances' });
await page.locator('[data-bal-field=newName]').fill('Kraken');
await page.locator('[data-bal-field=newKind]').selectOption('crypto');
if (await page.locator('[data-bal-field=currency]').inputValue() !== 'USD') throw new Error('Kraken balance not read as dollars');
await shot('08-review-kraken');
await page.getByRole('button', { name: 'Update balances' }).click();
await page.getByText('Kraken', { exact: true }).waitFor();
step('dollar account added');

// 4. An overview screen with several balances: skip one, add a joint account at 50%.
await scan(overviewShot, { mode: 'balances' });
const labels = await page.locator('[data-bal] .row-title').allTextContents();
console.log('  balances:', labels.join(' | '));
if (labels.length !== 2) throw new Error('expected 2 balances, got ' + labels.join(', '));
await page.locator('[data-bal="0"] [data-bal-field=target]').selectOption('skip');
await page.locator('[data-bal="1"] [data-bal-field=newName]').fill('Joint account');
await page.locator('[data-bal="1"] [data-bal-field=share]').selectOption('50');
await shot('09-review-balances');
await page.getByRole('button', { name: 'Update balances' }).click();
await page.getByText('Joint account', { exact: true }).waitFor();
step('balances updated');

// 5. Plan: a yearly car insurance and a monthly gym.
const inMonths = (n, day) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(day); return d.toISOString().slice(0, 10); };
for (const [name, amount, freq, due] of [['Car insurance', '480', 'yearly', inMonths(3, 1)], ['Gym', '30', 'monthly', new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10)]]) {
  await page.goto(base + '#/plan-edit/new');
  await page.getByLabel('What is it').fill(name);
  await page.getByLabel('Amount').fill(amount);
  await page.getByLabel('How often').selectOption(freq);
  await page.getByLabel("Next time it's due").fill(due);
  await page.getByRole('button', { name: 'Add to plan' }).click();
  await page.waitForURL(/#\/plan$/);
}
await shot('10-plan');
const reserve = await page.locator('.card .mid-number').nth(1).textContent();
console.log('  put aside monthly:', reserve);
if (!/40/.test(reserve)) throw new Error('expected €40 a month for a €480 yearly cost');
step('plan');

await page.goto(base + '#/');
await page.getByText('Total', { exact: true }).waitFor();
await page.getByText('Coming up').waitFor();
await shot('11-overview');
const total = await page.locator('.big-number').textContent();
console.log('  total:', total);
// 2,346.84 bank + 63.50 PayPal + 1,950 $ × 0.9 + 50% of 2,400
if (!/5,?365\.34/.test(total)) throw new Error('unexpected total ' + total);
if (!rateRequests) throw new Error('dollar rate was never requested');

await page.goto(base + '#/spending');
await shot('12-spending');
const spent = await page.locator('.card .mid-number').first().textContent();
console.log('  spent this month:', spent);

// An own transfer entered once: both accounts change, the summary doesn't.
const cameIn = await page.locator('.card .mid-number').nth(1).textContent();
await page.goto(base + '#/');
await page.getByRole('link', { name: /Sparkasse Giro/ }).click();
await page.getByRole('link', { name: 'Add by hand' }).click();
await page.getByLabel('Amount').fill('100');
await page.getByLabel('Description').fill('Umbuchung');
await page.getByLabel('Category').selectOption('transfer');
await page.getByLabel('Other account').selectOption({ label: 'PayPal' });
await shot('12b-transfer');
await page.getByRole('button', { name: 'Add', exact: true }).click();
await page.getByText('PayPal has the other side').waitFor();
await page.goto(base + '#/');
const totalAfter = await page.locator('.big-number').textContent();
if (!/5,?365\.34/.test(totalAfter)) throw new Error('transfer changed the total: ' + totalAfter);
await page.getByRole('link', { name: /PayPal/ }).click();
await page.getByText('From Sparkasse Giro', { exact: true }).waitFor();
await page.goto(base + '#/spending');
if (await page.locator('.card .mid-number').first().textContent() !== spent) throw new Error('transfer counted as spending');
if (await page.locator('.card .mid-number').nth(1).textContent() !== cameIn) throw new Error('transfer counted as money in');
step('own transfer');

// Hide amounts for showing the app to someone.
await page.goto(base + '#/');
await page.getByRole('button', { name: 'Hide amounts' }).click();
if (!/€\*\*\*/.test(await page.locator('.big-number').textContent())) throw new Error('total not hidden');
if (/\d,\d\d\d\.\d\d/.test(await page.locator('main').innerText())) throw new Error('an amount is still visible');
await shot('12c-hidden');
await page.getByRole('button', { name: 'Show amounts' }).click();
if (!/5,?365\.34/.test(await page.locator('.big-number').textContent())) throw new Error('total not shown again');
step('hide amounts');

await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(base + '#/');
await shot('13-overview-dark');

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

// Fingerprint unlock, with a virtual fingerprint sensor that supports the PRF extension.
const cdp = await page.context().newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
await page.goto(base + '#/settings');
await page.reload();
await page.getByLabel('Passcode').fill('246810');
await page.getByRole('button', { name: 'Unlock' }).click();
await page.getByLabel('Your passcode, to confirm').fill('246810');
await page.getByRole('button', { name: 'Turn on' }).click();
await page.getByText('Fingerprint unlock is on').waitFor();
await page.getByRole('button', { name: 'Lock now' }).click();
await shot('14-lock-fingerprint');
await page.getByRole('button', { name: 'Unlock with fingerprint' }).click();
await page.getByText('Fingerprint or Face ID').waitFor();
const bioRow = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('finance-app');
  r.onsuccess = () => r.result.transaction('vault').objectStore('vault').get('bio').onsuccess = (e) => res(JSON.stringify(e.target.result));
}));
if (bioRow.includes('246810')) throw new Error('passcode stored in the clear');
step('fingerprint unlock');

// Paste a copied screenshot instead of picking it from the photos.
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const png = (await readFile(bankShot)).toString('base64');
await page.goto(base + '#/');
await page.getByRole('link', { name: /Sparkasse Giro/ }).click();
await page.getByRole('link', { name: 'Add screenshot' }).click();
await page.evaluate(async (b64) => {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}, png);
await page.getByRole('button', { name: 'Paste a copied screenshot' }).click();
await page.getByText('Check what was read').waitFor({ timeout: 180000 });
step('paste a screenshot');

// Android: a screenshot picked with the file picker can be deleted from the phone after saving.
await page.evaluate(() => {
  Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile' });
  window.__deleted = 0;
  window.showOpenFilePicker = async () => {
    return [{ getFile: async () => new File([window.__shot], 'Screenshot.png', { type: 'image/png' }), remove: async () => { window.__deleted++; }, requestPermission: async () => 'granted' }];
  };
});
await page.evaluate(async (b64) => { window.__shot = await (await fetch('data:image/png;base64,' + b64)).blob(); }, png);
await page.goto(base + '#/');
await page.getByRole('link', { name: /Sparkasse Giro/ }).click();
await page.getByRole('link', { name: 'Add screenshot' }).click();
await page.locator('input[data-change=scan-files]').click();
await page.getByText('Check what was read').waitFor({ timeout: 180000 });
await page.getByRole('button', { name: /^Save/ }).click();
await page.getByText('Delete the screenshot from your phone?').waitFor();
await shot('15-delete-prompt');
await page.getByRole('button', { name: 'Delete', exact: true }).click();
await page.getByText('Deleted from your phone').waitFor();
if (await page.evaluate(() => window.__deleted) !== 1) throw new Error('screenshot not deleted');
step('delete the screenshot after saving');

// Find a difference: the app shows what's missing, extra or different and fixes it.
await page.goto(base + '#/');
await page.getByRole('link', { name: /Sparkasse Giro doesn't match/ }).click();
await page.getByRole('link', { name: 'Find the cause with a screenshot' }).click();
await page.evaluate(() => { delete window.showOpenFilePicker; });
await page.locator('input[data-change=scan-files]').setInputFiles(findShot);
await page.getByRole('heading', { name: 'Missing in the app' }).waitFor({ timeout: 180000 });
const findText = await page.locator('main').innerText();
await shot('16-find');
if (!/Kino/.test(findText)) throw new Error('missing payment not found');
if (!/Not on the screenshot[\s\S]*Lieferando/i.test(findText)) throw new Error('extra payment not found');
if (!/These explain the whole difference/.test(findText)) throw new Error('difference not explained:\n' + findText);
await page.getByRole('button', { name: /^Fix all/ }).click();
await page.getByText('The app matches the screenshot').waitFor();
await page.getByRole('button', { name: 'Done' }).click();
await page.getByText('Sparkasse Giro matches the screenshot').waitFor();
step('find a difference');

// A bank debit that only says "PayPal": the app asks what it was for.
await page.goto(base + '#/');
await page.locator('a.row', { hasText: 'Sparkasse Giro' }).first().click();
await page.getByRole('link', { name: 'Add by hand' }).click();
await page.getByLabel('Amount').fill('40');
await page.getByLabel('Description').fill('PayPal Europe S.a.r.l.');
await page.getByRole('button', { name: 'Add', exact: true }).click();
await page.goto(base + '#/spending');
const spentBefore = await page.locator('.card .mid-number').first().textContent();
await page.goto(base + '#/');
await page.getByRole('link', { name: /What was this PayPal payment for/ }).click();
await page.getByLabel('What was it for?').fill('Zalando');
if (await page.getByLabel('Category').inputValue() !== 'shopping') throw new Error('no category suggested for Zalando');
await shot('17-paypal-question');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.getByText('All clear').waitFor();
await page.goto(base + '#/spending');
const spentAfter = await page.locator('.card .mid-number').first().textContent();
const eur = (x) => Number(x.replace(/[^\d.]/g, ''));
if (Math.round((eur(spentAfter) - eur(spentBefore)) * 100) !== 4000) throw new Error(`PayPal answer not counted: ${spentBefore} → ${spentAfter}`);
step('ask about a PayPal debit');

// Mark a transaction as repeating: it shows up in Plan.
await page.goto(base + '#/');
await page.locator('a.row', { hasText: 'Sparkasse Giro' }).first().click();
await page.getByRole('link', { name: /Miete Oktober/ }).click();
await page.getByLabel('Repeats').selectOption('monthly');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.goto(base + '#/plan');
await page.getByText('Miete Oktober').first().waitFor();
step('repeating transaction in the plan');

await browser.close();
server.close();
if (external.length) throw new Error('requests left the device: ' + external.join(', '));
if (errors.length) throw new Error('browser errors: ' + errors.join('\n'));
console.log('e2e passed; the only outside request was the dollar rate');
