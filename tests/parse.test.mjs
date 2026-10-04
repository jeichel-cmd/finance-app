import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAmounts, findDate, numberToCents, parseScreenshot } from '../src/parse.js';

const REF = '2026-10-04';
const L = (...texts) => texts.map((t) => (typeof t === 'string' ? { text: t, height: 20 } : t));

test('reads German and English number formats', () => {
  assert.equal(numberToCents('1.234,56').cents, 123456);
  assert.equal(numberToCents('1,234.56').cents, 123456);
  assert.equal(numberToCents('12,5').cents, 1250);
  assert.equal(numberToCents('1 234,56').cents, 123456);
  assert.equal(numberToCents('0.00342'), null);
});

test('finds signed euro amounts and skips other currencies and percentages', () => {
  assert.deepEqual(findAmounts('Spotify -10,99 €').map((a) => a.cents), [-1099]);
  assert.deepEqual(findAmounts('Refund +€13.50').map((a) => a.cents), [1350]);
  assert.deepEqual(findAmounts('−€24.80').map((a) => a.cents), [-2480]);
  assert.deepEqual(findAmounts('BTC 0.0342 BTC'), []);
  assert.deepEqual(findAmounts('Performance +4,21 %'), []);
  assert.deepEqual(findAmounts('100 USD').map((a) => [a.cents, a.currency]), [[10000, 'USD']]);
  assert.deepEqual(findAmounts('Total $1,950.25').map((a) => [a.cents, a.currency]), [[195025, 'USD']]);
  assert.deepEqual(findAmounts('IBAN DE12 3456 7890'), []);
  assert.deepEqual(findAmounts('14:32').length, 0);
});

test('finds dates in common formats', () => {
  assert.equal(findDate('Heute', REF).date, '2026-10-04');
  assert.equal(findDate('Gestern', REF).date, '2026-10-03');
  assert.equal(findDate('02.10.2026 Lastschrift', REF).date, '2026-10-02');
  assert.equal(findDate('28.09.', REF).date, '2026-09-28');
  assert.equal(findDate('4. Oktober 2026', REF).date, '2026-10-04');
  assert.equal(findDate('Oct 1, 2026', REF).date, '2026-10-01');
  assert.equal(findDate('30 Dec', REF).date, '2025-12-30');
  assert.equal(findDate('Total 12.05 €', REF), null);
});

test('parses a German bank screenshot', () => {
  const r = parseScreenshot([
    { text: 'Sparkasse', height: 18 },
    { text: 'Girokonto', height: 18 },
    { text: 'Kontostand', height: 16 },
    { text: '3.482,15 €', height: 40 },
    { text: 'Heute', height: 14 },
    { text: 'REWE Markt GmbH -42,17 €', height: 18 },
    { text: 'Gestern', height: 14 },
    { text: 'PayPal Europe S.a.r.l. -10,99 €', height: 18 },
    { text: 'Gehalt Oktober 2.850,00 €', height: 18 },
  ], REF);
  assert.equal(r.provider.name, 'Sparkasse');
  assert.equal(r.balance, 348215);
  assert.deepEqual(r.transactions.map((t) => [t.payee, t.amount, t.date]), [
    ['REWE Markt GmbH', -4217, '2026-10-04'],
    ['PayPal Europe S.a.r.l', -1099, '2026-10-03'],
    ['Gehalt Oktober', 285000, '2026-10-03'],
  ]);
});

test('parses a PayPal-style list with payee above the amount', () => {
  const r = parseScreenshot(L('PayPal', 'PayPal balance', '€412.30', 'Spotify', '-€10.99', 'Oct 2', 'Zalando', '+€13.50', 'Sep 28'), REF);
  assert.equal(r.provider.name, 'PayPal');
  assert.equal(r.balance, 41230);
  assert.deepEqual(r.transactions.map((t) => [t.payee, t.amount, t.date]), [
    ['Spotify', -1099, '2026-10-02'],
    ['Zalando', 1350, '2026-09-28'],
  ]);
});

test('falls back to the tallest amount for the balance', () => {
  const r = parseScreenshot([
    { text: 'Kraken', height: 18 },
    { text: '€1,807.00', height: 44 },
    { text: 'Bitcoin 0.0123 BTC €740.10', height: 18 },
  ], REF);
  assert.equal(r.balance, 180700);
});

test('joins a payee and its amount that sit on the same row', async () => {
  const { mergeRows } = await import('../src/parse.js');
  const rows = mergeRows([
    { text: '-€10.99', top: 300, bottom: 335, left: 280 },
    { text: 'Spotify', top: 296, bottom: 341, left: 40 },
    { text: 'Oct 2', top: 345, bottom: 370, left: 40 },
  ]);
  assert.deepEqual(rows.map((r) => r.text), ['Spotify  -€10.99', 'Oct 2']);
});

test('reads a DKB-style list: wrapped payees, icon noise and date captions below', () => {
  const r = parseScreenshot(L(
    'Girokonto', 'Account balance incl. pending transactions', { text: '€1,597.63', height: 70 }, 'Detail', 'Future Bookings',
    'SumUp *Cafe am Markt', 'Ulm DE  -€12.00', '©', '© Pending - 05.10.26',
    'Google Play  -€17.99', '© Pending - 05.10.26',
    'PayPal Europe S.a.r.l. et Cie', '-€40.00', 'S.CA', '05.10.26 - Direct debit', 'Today',
  ), '2026-10-05');
  assert.equal(r.balance, 159763);
  assert.equal(r.provider, null);
  assert.deepEqual(r.transactions.map((t) => [t.payee, t.amount, t.date]), [
    ['SumUp Cafe am Markt Ulm DE', -1200, '2026-10-05'],
    ['Google Play', -1799, '2026-10-05'],
    ['PayPal Europe S.a.r.l. et Cie', -4000, '2026-10-05'],
  ]);
});

test('reads an overview screen as account balances, not transactions', async () => {
  const { parseBalances } = await import('../src/parse.js');
  const r = parseBalances(L('7:41 85%', 'Home', '€1,597.63 ©', 'Current accounts (2/3) >', 'Girokonto  €1,597.63', '[111]', 'More',
    'Tagesgeld  €0.00', 'Girokonto  €1,639.57', 'Personalize', 'Home  Cards  Orders  Products  Profile'));
  assert.deepEqual(r.accounts.map((a) => [a.label, a.amount]), [['Girokonto', 159763], ['Tagesgeld', 0], ['Girokonto', 163957]]);
  const k = parseBalances(L('Kraken', 'Total balance', '$1,950.00'));
  assert.deepEqual(k.accounts.map((a) => [a.label, a.amount, a.currency]), [['Total balance', 195000, 'USD']]);
});
