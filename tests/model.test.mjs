import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, netWorth, recurringPayments, planTimeline, monthlyReserve, occurrences, accountBalance, periodSummary, checkDiff, fixSuggestions, findExisting, payPalMatch, correctionTx, refreshChecks } from '../src/model.js';
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

test('a shared account counts at your share, and USD accounts count in EUR', () => {
  const s = emptyState();
  s.settings.usdRate = 0.9;
  s.accounts.push({ id: 'joint', name: 'Joint', kind: 'bank', share: 50 });
  s.accounts.push({ id: 'kr', name: 'Kraken', kind: 'crypto', currency: 'USD' });
  s.transactions.push({ id: '1', accountId: 'joint', amount: 200000, date: T, payee: 'Starting balance', category: 'correction', source: 'opening' });
  s.transactions.push({ id: '2', accountId: 'joint', amount: -10000, date: T, payee: 'REWE', category: 'groceries' });
  s.transactions.push({ id: '3', accountId: 'kr', amount: 100000, date: T, payee: 'Starting balance', category: 'correction', source: 'opening' });
  assert.equal(netWorth(s), 95000 + 90000);
  assert.equal(periodSummary(s, monthStart(T), T).spent, 5000);
});

test('finds monthly payments and plans yearly ones', () => {
  const s = emptyState();
  s.accounts.push({ id: 'b', name: 'Bank', kind: 'bank' });
  for (const [i, d] of ['2026-06-03', '2026-07-03', '2026-08-04', '2026-09-03'].entries())
    s.transactions.push({ id: 'n' + i, accountId: 'b', amount: -1299, date: d, payee: 'Netflix.com', category: 'subscriptions' });
  s.transactions.push({ id: 'x', accountId: 'b', amount: -4217, date: '2026-09-10', payee: 'REWE', category: 'groceries' });
  const r = recurringPayments(s);
  assert.equal(r.length, 1);
  assert.equal(r[0].frequency, 'monthly');
  assert.equal(r[0].next, '2026-10-03');

  s.plans.push({ id: 'p', name: 'Car insurance', amount: -48000, frequency: 'yearly', due: '2027-01-01' });
  s.plans.push({ id: 'q', name: 'Gym', amount: -3000, frequency: 'monthly', due: '2026-01-15' });
  assert.deepEqual(occurrences(s.plans[0], '2026-01-01', '2028-12-31'), ['2027-01-01', '2028-01-01']);
  assert.equal(monthlyReserve(s), 4000);
  const tl = planTimeline(s, 12);
  assert.equal(tl.length, 12);
  assert.ok(tl.some((m) => m.items.some((x) => x.plan.id === 'p')));
});

test('an own transfer is one linked pair that counts as neither spending nor income', async () => {
  const { linkTransfer, unlinkTransfer, transferPartner } = await import('../src/model.js');
  const s = setup();
  s.accounts.push({ id: 'save', name: 'Tagesgeld', kind: 'bank' });
  const before = periodSummary(s, monthStart(T), T);
  const t = { id: 'm', accountId: 'bank', amount: -50000, payee: 'Umbuchung', date: T, category: 'transfer', source: 'manual' };
  s.transactions.push(t);
  const other = linkTransfer(s, t, 'save');
  assert.equal(other.amount, 50000);
  assert.equal(other.payee, 'From Sparkasse');
  assert.equal(accountBalance(s, 'save'), 50000);
  assert.deepEqual(periodSummary(s, monthStart(T), T), before);
  assert.equal(netWorth(s), netWorth({ ...s, transactions: s.transactions.filter((x) => x !== t && x !== other) }));
  // A later screenshot of the savings account finds the saved side instead of adding it again.
  assert.equal(findExisting(s, 'save', { payee: 'Jeremy Girokonto', amount: 50000, date: T }).id, other.id);
  unlinkTransfer(s, t);
  assert.equal(transferPartner(s, t), null);
  assert.equal(accountBalance(s, 'save'), 0);
});

test('linking picks up the other side when it is already there', async () => {
  const { linkTransfer } = await import('../src/model.js');
  const s = setup();
  s.accounts.push({ id: 'save', name: 'Tagesgeld', kind: 'bank' });
  s.transactions.push({ id: 'in', accountId: 'save', amount: 20000, payee: 'Gutschrift', date: T, category: null, source: 'scan' });
  const t = { id: 'out', accountId: 'bank', amount: -20000, payee: 'Übertrag', date: T, category: 'transfer' };
  s.transactions.push(t);
  assert.equal(linkTransfer(s, t, 'save').id, 'in');
  assert.equal(s.transactions.length, 7);
  assert.equal(periodSummary(s, monthStart(T), T).income, 0);
});

test('finds what is missing, extra or different between a screenshot and the app', async () => {
  const { reconcile } = await import('../src/model.js');
  const s = emptyState();
  s.accounts.push({ id: 'b', name: 'DKB', kind: 'bank' });
  const add = (id, amount, payee, date, extra = {}) => s.transactions.push({ id, accountId: 'b', amount, payee, date, category: null, ...extra });
  add('o', 100000, 'Starting balance', '2026-09-01', { source: 'opening' });
  add('r1', -4217, 'REWE', '2026-10-02');
  add('x1', -2000, 'Bäcker', '2026-10-03'); // not on the screenshot
  add('s1', -1299, 'Spotify', '2026-10-04'); // on the screenshot as 12.99 → 9.99? no: different amount below
  add('old', -500, 'Kiosk', '2026-09-20'); // before the screenshot window
  const shot = {
    balance: 100000 - 4217 - 999 - 3000 - 500,
    date: '2026-10-05',
    rows: [
      { id: 'a', payee: 'REWE Markt', amount: -4217, date: '2026-10-02' },
      { id: 'b', payee: 'Spotify AB', amount: -999, date: '2026-10-04' },
      { id: 'c', payee: 'Lieferando', amount: -3000, date: '2026-10-05' },
    ],
  };
  const r = reconcile(s, 'b', shot);
  assert.deepEqual(r.missing.map((x) => x.id), ['c']);
  assert.deepEqual(r.extra.map((x) => x.tx.id), ['x1']);
  assert.equal(r.different[0].tx.id, 's1');
  assert.equal(r.different[0].delta, 300);
  assert.equal(r.diff, -3000 + 2000 + 300);
  assert.equal(r.rest, 0);
});

test('a transaction marked as repeating becomes a plan due next after today', async () => {
  const { planFromTx } = await import('../src/model.js');
  const p = planFromTx({ id: 't', accountId: 'b', payee: 'HUK Autoversicherung', amount: -48000, date: '2026-01-10', category: 'insurance' }, 'yearly', '2026-10-07');
  assert.equal(p.due, '2027-01-10');
  assert.equal(p.fromTx, 't');
  assert.equal(planFromTx({ id: 'm', date: '2026-09-15', amount: -999 }, 'monthly', '2026-10-07').due, '2026-10-15');
});

test('asks about bank PayPal debits it cannot explain, and counts an answered one once', async () => {
  const { unclearPayPal } = await import('../src/model.js');
  const s = setup();
  s.transactions.push({ id: 'b9', accountId: 'bank', amount: -4000, payee: 'PayPal Europe', category: 'transfer', date: T });
  assert.deepEqual(unclearPayPal(s).map((t) => t.id), ['b9']); // b1 is explained by the Spotify payment in PayPal
  const before = periodSummary(s, monthStart(T), T).spent;
  Object.assign(s.transactions.at(-1), { paypalFor: 'Zalando', payee: 'PayPal · Zalando', category: 'shopping' });
  assert.equal(unclearPayPal(s).length, 0);
  assert.equal(periodSummary(s, monthStart(T), T).spent, before + 4000);
  // Later the PayPal side arrives: still counted once.
  s.transactions.push({ id: 'p9', accountId: 'pp', amount: -4000, payee: 'Zalando', category: 'shopping', paidFrom: 'bank', date: T });
  assert.equal(periodSummary(s, monthStart(T), T).spent, before + 4000);
});
