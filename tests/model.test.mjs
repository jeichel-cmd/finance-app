import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, accountBalance, periodSummary, checkDiff, fixSuggestions, findExisting, payPalMatch, correctionTx, refreshChecks } from '../src/model.js';
import { suggestCategory, normalizePayee, learn } from '../src/categorize.js';
import { today, monthStart } from '../src/format.js';
import { deriveKey, encryptJson, decryptJson, newSalt } from '../src/crypto.js';

const T = today();

function setup() {
  const s = emptyState();
  s.accounts.push({ id: 'bank', name: 'Sparkasse', kind: 'bank' });
  s.accounts.push({ id: 'pp', name: 'PayPal', kind: 'wallet', fundedFrom: 'bank' });
  s.accounts.push({ id: 'tr', name: 'Trade Republic', kind: 'broker' });
  const tx = (id, accountId, amount, payee, category, extra = {}) => s.transactions.push({ id, accountId, amount, payee, category, date: T, createdAt: '', ...extra });
  tx('b0', 'bank', 100000, 'Starting balance', 'correction');
  tx('b1', 'bank', -1099, 'PayPal Europe', 'transfer');
  tx('b2', 'bank', -4217, 'REWE', 'groceries');
  tx('p0', 'pp', 5000, 'Starting balance', 'correction');
  tx('p1', 'pp', -1099, 'Spotify', 'subscriptions', { paidFrom: 'bank' });
  return s;
}

test('a PayPal payment taken from the bank counts as spending once and leaves the PayPal balance alone', () => {
  const s = setup();
  assert.equal(accountBalance(s, 'pp'), 5000);
  assert.equal(accountBalance(s, 'bank'), 100000 - 1099 - 4217);
  const sum = periodSummary(s, monthStart(T), T);
  assert.equal(sum.spent, 1099 + 4217);
  assert.deepEqual(sum.categories.map((c) => c.id).sort(), ['groceries', 'subscriptions']);
  assert.equal(payPalMatch(s, s.transactions.find((t) => t.id === 'b1')).id, 'p1');
});

test('a mismatch suggests the unsaved transaction from the screenshot', () => {
  const s = setup();
  const check = { id: 'c', accountId: 'pp', date: T, balance: 6350, status: 'open', candidates: [{ id: 'x', payee: 'Zalando', amount: 1350, date: T }] };
  s.checks.push(check);
  assert.equal(checkDiff(s, check).diff, 1350);
  const ideas = fixSuggestions(s, check);
  assert.equal(ideas[0].type, 'add');
  s.transactions.push({ id: 'z', accountId: 'pp', amount: 1350, payee: 'Zalando', date: T, category: 'shopping' });
  refreshChecks(s);
  assert.equal(check.status, 'fixed');
});

test('a mismatch suggests a PayPal payment was really paid from the PayPal balance', () => {
  const s = setup();
  const check = { id: 'c', accountId: 'pp', date: T, balance: 5000 - 1099, status: 'open', candidates: [] };
  const ideas = fixSuggestions(s, check);
  assert.ok(ideas.some((i) => i.type === 'paid-from-balance' && i.tx.id === 'p1'));
});

test('an investment difference is recorded as a value change, not spending', () => {
  const s = setup();
  const check = { id: 'c', accountId: 'tr', date: T, balance: 48630, status: 'open', candidates: [] };
  const tx = correctionTx(s, check);
  assert.equal(tx.category, 'value-change');
  s.transactions.push(tx);
  assert.equal(checkDiff(s, check).diff, 0);
  assert.equal(periodSummary(s, monthStart(T), T).spent, 1099 + 4217);
});

test('recognises a transaction that is already saved', () => {
  const s = setup();
  assert.equal(findExisting(s, 'bank', { payee: 'REWE Markt GmbH', amount: -4217, date: T }).id, 'b2');
  assert.equal(findExisting(s, 'bank', { payee: 'REWE', amount: -4218, date: T }), null);
});

test('suggests categories from keywords and learns from corrections', () => {
  assert.equal(suggestCategory('REWE.Sagt.Danke 12345', -1000), 'groceries');
  assert.equal(suggestCategory('Lieferando.de', -2480), 'eating-out');
  assert.equal(suggestCategory('Rhabarber Hof', -500), null);
  assert.equal(suggestCategory('PayPal Europe S.a.r.l. et Cie', -1099, {}, { kind: 'bank' }), 'transfer');
  const rules = learn({}, 'Bäcker Müller 0815', 'eating-out');
  assert.equal(suggestCategory('BÄCKER MÜLLER 4711', -350, rules), 'eating-out');
  assert.equal(normalizePayee('REWE Markt GmbH'), 'rewe markt');
});

test('encrypts and refuses the wrong passcode', async () => {
  const salt = newSalt();
  const key = await deriveKey('123456', salt, 1000);
  const box = await encryptJson(key, { a: 1 });
  assert.deepEqual(await decryptJson(key, box), { a: 1 });
  const wrong = await deriveKey('654321', salt, 1000);
  await assert.rejects(decryptJson(wrong, box));
});
