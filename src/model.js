// Balances, analysis and mismatch detection, all computed from the stored transactions.
//
// An account's balance is the sum of its transactions. A screenshot's balance is stored as a "check";
// when it differs from the app's balance the check stays open until the person fixes it.
//
// PayPal: a payment PayPal takes from a bank account carries `paidFrom` (that bank account's id).
// It counts as spending once, but does not change the PayPal balance. The matching bank debit is
// categorised as a transfer between own accounts, so it is not counted a second time.
//
// Shared accounts (e.g. a joint account) have a `share` in percent: totals and spending count only
// that part. Accounts can be in EUR or USD; totals are in EUR at the stored USD rate.

import { DEFAULT_CATEGORIES, normalizePayee, suggestCategory, isPayPalPayee } from './categorize.js';
import { today, addDays, addMonths, monthStart, monthEnd, daysBetween, uid } from './format.js';

export const STALE_DAYS = 14;

export function emptyState() {
  return {
    version: 1,
    accounts: [],
    transactions: [],
    checks: [],
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    rules: {},
    plans: [],
    settings: {},
  };
}

export const DEFAULT_USD_RATE = 0.86; // EUR per USD, only until the first update

export function currencyOf(acc) {
  return acc?.currency || 'EUR';
}

export function usdRate(state) {
  return state.settings.usdRate || DEFAULT_USD_RATE;
}

export function toEur(state, cents, currency) {
  return currency === 'USD' ? Math.round(cents * usdRate(state)) : cents;
}

export function shareOf(acc) {
  return (acc?.share ?? 100) / 100;
}

export function hasUsd(state) {
  return state.accounts.some((a) => currencyOf(a) === 'USD');
}

// What part of an account's balance is yours, in EUR.
export function yourValue(state, acc, upto = null) {
  return Math.round(toEur(state, accountBalance(state, acc.id, upto), currencyOf(acc)) * shareOf(acc));
}

export const ACCOUNT_KINDS = {
  bank: 'Bank account',
  wallet: 'Payment wallet (e.g. PayPal)',
  broker: 'Broker / investments',
  crypto: 'Crypto exchange',
  cash: 'Cash or other',
};

export function isInvestment(acc) {
  return acc && (acc.kind === 'broker' || acc.kind === 'crypto');
}

export function category(state, id) {
  return state.categories.find((c) => c.id === id) || null;
}

export function countsOnBalance(tx) {
  return !tx.paidFrom;
}

export function accountBalance(state, accountId, upto = null) {
  let sum = 0;
  for (const t of state.transactions) {
    if (t.accountId !== accountId || !countsOnBalance(t)) continue;
    // A starting balance stands for money that was already there, so it counts at every date.
    if (upto && t.date > upto && t.source !== 'opening') continue;
    sum += t.amount;
  }
  return sum;
}

export function netWorth(state, upto = null) {
  return state.accounts.reduce((s, a) => s + yourValue(state, a, upto), 0);
}

export function netWorthSeries(state, months = 6) {
  const t = today();
  const points = [];
  for (let i = months - 1; i >= 1; i--) {
    const end = monthEnd(addMonths(t, -i));
    points.push({ date: end, value: netWorth(state, end) });
  }
  points.push({ date: t, value: netWorth(state, t) });
  return points;
}

export function accountSeries(state, accountId, months = 6) {
  const t = today();
  const points = [];
  for (let i = months - 1; i >= 1; i--) {
    const end = monthEnd(addMonths(t, -i));
    points.push({ date: end, value: accountBalance(state, accountId, end) });
  }
  points.push({ date: t, value: accountBalance(state, accountId, t) });
  return points;
}

export function changeSince(state, from, accountId = null) {
  const before = addDays(from, -1);
  const t = today();
  if (accountId) return accountBalance(state, accountId, t) - accountBalance(state, accountId, before);
  return netWorth(state, t) - netWorth(state, before);
}

function txKind(state, tx) {
  if (!tx.category) return tx.amount < 0 ? 'expense' : 'income';
  return category(state, tx.category)?.kind || 'expense';
}

// Spending and income in [from, to]. Refunds in an expense category reduce that category's spending.
export function periodSummary(state, from, to) {
  let spent = 0, income = 0;
  const byCat = new Map();
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  for (const t of state.transactions) {
    if (t.date < from || t.date > to) continue;
    const acc = accounts.get(t.accountId);
    const amount = Math.round(toEur(state, t.amount, currencyOf(acc)) * shareOf(acc));
    const kind = txKind(state, t);
    if (kind === 'expense') {
      spent -= amount;
      const key = t.category || null;
      const e = byCat.get(key) || { id: key, amount: 0, count: 0 };
      e.amount -= amount;
      e.count++;
      byCat.set(key, e);
    } else if (kind === 'income') {
      income += amount;
    }
  }
  const categories = [...byCat.values()].filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
  return { spent, income, saved: income - spent, categories };
}

export function monthlySpending(state, months = 6) {
  const t = today();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = addMonths(t, -i);
    const s = periodSummary(state, start, monthEnd(start));
    out.push({ month: start, spent: s.spent, income: s.income });
  }
  return out;
}

// The category whose spending this month is furthest above its average of the three months before.
export function spendingInsight(state) {
  const t = today();
  const now = periodSummary(state, monthStart(t), t);
  const prev = [1, 2, 3].map((i) => periodSummary(state, addMonths(t, -i), monthEnd(addMonths(t, -i))));
  const monthsWithData = prev.filter((p) => p.spent > 0).length;
  if (!monthsWithData) return null;
  let best = null;
  for (const c of now.categories) {
    if (!c.id) continue;
    const avg = prev.reduce((s, p) => s + (p.categories.find((x) => x.id === c.id)?.amount || 0), 0) / monthsWithData;
    const diff = c.amount - avg;
    if (diff > 2000 && (!avg || diff / avg > 0.2) && (!best || diff > best.diff)) best = { id: c.id, amount: c.amount, avg: Math.round(avg), diff: Math.round(diff) };
  }
  return best;
}

// Groups uncategorised transactions that have a confident suggestion, for one-tap sorting.
export function categorySuggestions(state) {
  const groups = new Map();
  for (const t of state.transactions) {
    if (t.category) continue;
    const acc = state.accounts.find((a) => a.id === t.accountId);
    const suggestion = suggestCategory(t.payee, t.amount, state.rules, acc);
    if (!suggestion) continue;
    const key = normalizePayee(t.payee) + '|' + suggestion;
    const g = groups.get(key) || { payee: t.payee, category: suggestion, ids: [] };
    g.ids.push(t.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
}

export function uncategorisedCount(state) {
  return state.transactions.filter((t) => !t.category).length;
}

function samePayee(a, b) {
  const x = normalizePayee(a), y = normalizePayee(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x) || x.split(' ')[0] === y.split(' ')[0];
}

// An already saved transaction that looks like `tx` (same account and amount, close date, similar payee).
export function findExisting(state, accountId, tx, exclude = new Set()) {
  return state.transactions.find((t) =>
    t.accountId === accountId &&
    !exclude.has(t.id) &&
    t.amount === tx.amount &&
    Math.abs(daysBetween(t.date, tx.date)) <= (tx.dateGuessed ? 10 : 3) &&
    // The app names the other side of a transfer itself, so the bank's wording won't match it.
    (samePayee(t.payee, tx.payee) || t.source === 'transfer')) || null;
}

// ---------- own transfers: one move between two accounts, saved as a linked pair ----------

export function transferPartner(state, tx) {
  if (!tx.transferId) return null;
  return state.transactions.find((t) => t.transferId === tx.transferId && t.id !== tx.id) || null;
}

function convert(state, cents, from, to) {
  if (from === to) return cents;
  const eur = toEur(state, cents, from);
  return to === 'USD' ? Math.round(eur / usdRate(state)) : eur;
}

// Links tx to its other side in otherAccountId: an unlinked matching transaction already there
// (e.g. from a screenshot), or a new one. Returns the other side.
export function linkTransfer(state, tx, otherAccountId) {
  const accs = new Map(state.accounts.map((a) => [a.id, a]));
  const from = currencyOf(accs.get(tx.accountId)), to = currencyOf(accs.get(otherAccountId));
  const amount = -convert(state, tx.amount, from, to);
  const slack = from === to ? 0 : Math.abs(amount) * 0.03; // exchange rates differ a little
  let other = transferPartner(state, tx);
  if (other && other.accountId !== otherAccountId) { unlinkTransfer(state, tx); other = null; }
  if (!other) {
    other = state.transactions.find((t) => t.accountId === otherAccountId && !t.transferId && t.id !== tx.id &&
      Math.abs(t.amount - amount) <= slack &&
      Math.abs(daysBetween(t.date, tx.date)) <= 4) || null;
    if (!other) {
      other = { id: uid(), accountId: otherAccountId, source: 'transfer', createdAt: new Date().toISOString() };
      state.transactions.push(other);
    }
  }
  tx.transferId = tx.transferId || uid();
  tx.category = 'transfer';
  other.transferId = tx.transferId;
  other.category = 'transfer';
  if (other.source === 'transfer') {
    const name = accs.get(tx.accountId)?.name || 'another account';
    Object.assign(other, { amount, date: tx.date, payee: `${amount < 0 ? 'To' : 'From'} ${name}`, note: tx.note || '' });
  } else if (tx.source === 'transfer') {
    Object.assign(other, { amount, date: tx.date });
  }
  return other;
}

// Splits a pair. The other side goes away if the app made it; a scanned one stays.
export function unlinkTransfer(state, tx) {
  const other = transferPartner(state, tx);
  delete tx.transferId;
  if (!other) return;
  if (other.source === 'transfer') state.transactions = state.transactions.filter((t) => t !== other);
  else delete other.transferId;
}

// For a bank debit to PayPal, the PayPal payment it paid for.
export function payPalMatch(state, tx) {
  if (!isPayPalPayee(tx.payee) || tx.amount >= 0) return null;
  return state.transactions.find((t) => t.paidFrom === tx.accountId && t.amount === tx.amount && Math.abs(daysBetween(t.date, tx.date)) <= 6) || null;
}

export function checkDiff(state, check) {
  const app = check.accountId ? accountBalance(state, check.accountId, check.date) : netWorth(state, check.date);
  return { app, diff: check.balance - app };
}

export function lastCheck(state, accountId) {
  return state.checks
    .filter((c) => c.accountId === accountId)
    .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt))[0] || null;
}

export function openChecks(state) {
  return state.checks.filter((c) => c.status === 'open');
}

export function accountStatus(state, acc) {
  const last = lastCheck(state, acc.id);
  if (last && last.status === 'open') return { state: 'mismatch', last };
  if (!last) return { state: 'never', last };
  if (daysBetween(last.date, today()) > STALE_DAYS) return { state: 'stale', last };
  return { state: 'ok', last };
}

// Ways to explain the gap between a screenshot balance and the app, most likely first.
export function fixSuggestions(state, check) {
  const { diff } = checkDiff(state, check);
  if (!diff) return [];
  const out = [];
  const candidates = (check.candidates || []).filter((c) => !c.used);
  for (const c of candidates) if (c.amount === diff) out.push({ type: 'add', candidate: c });
  if (!out.length) {
    for (let i = 0; i < candidates.length; i++)
      for (let j = i + 1; j < candidates.length; j++)
        if (candidates[i].amount + candidates[j].amount === diff) out.push({ type: 'add-two', candidates: [candidates[i], candidates[j]] });
  }
  if (check.accountId) {
    const txs = state.transactions.filter((t) => t.accountId === check.accountId && countsOnBalance(t) && t.date <= check.date);
    // Saved twice?
    const seen = new Map();
    for (const t of txs) {
      const k = `${t.amount}|${t.date}|${normalizePayee(t.payee)}`;
      if (seen.has(k) && -t.amount === diff) out.push({ type: 'duplicate', tx: t });
      seen.set(k, t);
    }
    // Saved with the wrong sign?
    for (const t of txs) if (-2 * t.amount === diff && t.source !== 'correction') out.push({ type: 'flip', tx: t });
    // A PayPal payment marked as paid from the bank that was really paid from the PayPal balance, or the other way round.
    for (const t of state.transactions) {
      if (t.accountId !== check.accountId || t.date > check.date) continue;
      if (t.paidFrom && t.amount === diff) out.push({ type: 'paid-from-balance', tx: t });
      else if (!t.paidFrom && t.amount < 0 && -t.amount === diff && state.accounts.find((a) => a.id === check.accountId)?.fundedFrom) out.push({ type: 'paid-from-bank', tx: t });
    }
  }
  return out.slice(0, 4);
}

export function correctionTx(state, check) {
  const { diff } = checkDiff(state, check);
  const acc = state.accounts.find((a) => a.id === check.accountId);
  const investment = isInvestment(acc);
  return {
    id: uid(),
    accountId: check.accountId,
    date: check.date,
    payee: investment ? 'Value change' : 'Balance correction',
    amount: diff,
    category: investment ? 'value-change' : 'correction',
    source: 'correction',
    createdAt: new Date().toISOString(),
  };
}

// Re-evaluates open checks after data changed; closes the ones that now match.
export function refreshChecks(state) {
  for (const c of state.checks) {
    if (c.status !== 'open' && c.status !== 'fixed') continue;
    const { diff } = checkDiff(state, c);
    if (c.status === 'open' && diff === 0) { c.status = 'fixed'; c.resolvedAt = new Date().toISOString(); }
  }
}

// ---------- recurring payments and the plan ----------

export const FREQUENCIES = {
  monthly: { label: 'Every month', months: 1 },
  quarterly: { label: 'Every 3 months', months: 3 },
  'half-yearly': { label: 'Every 6 months', months: 6 },
  yearly: { label: 'Every year', months: 12 },
  once: { label: 'Once', months: 0 },
};

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Payments that come back at a steady rhythm: same payee, similar amount, about a month (or 3, 6, 12) apart.
export function recurringPayments(state) {
  const groups = new Map();
  for (const t of state.transactions) {
    if (t.amount >= 0 || t.source === 'opening' || t.source === 'correction') continue;
    if (category(state, t.category)?.kind === 'neutral') continue;
    const key = t.accountId + '|' + normalizePayee(t.payee);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const planned = new Set((state.plans || []).map((p) => normalizePayee(p.name)));
  const out = [];
  for (const txs of groups.values()) {
    if (txs.length < 2) continue;
    txs.sort((a, b) => a.date.localeCompare(b.date));
    const amounts = txs.map((t) => -t.amount);
    const typical = median(amounts);
    if (amounts.some((a) => Math.abs(a - typical) > typical * 0.15)) continue;
    const gaps = txs.slice(1).map((t, i) => daysBetween(txs[i].date, t.date));
    const gap = median(gaps);
    const frequency = gap >= 25 && gap <= 35 ? 'monthly' : gap >= 85 && gap <= 95 ? 'quarterly' : gap >= 175 && gap <= 190 ? 'half-yearly' : gap >= 355 && gap <= 375 ? 'yearly' : null;
    if (!frequency || gaps.some((g) => Math.abs(g - gap) > 7 + gap * 0.1)) continue;
    const last = txs[txs.length - 1];
    if (planned.has(normalizePayee(last.payee))) continue;
    out.push({ payee: last.payee, amount: -typical, frequency, last: last.date, next: addMonthsKeepDay(last.date, FREQUENCIES[frequency].months), accountId: last.accountId, category: last.category, count: txs.length });
  }
  return out.sort((a, b) => a.next.localeCompare(b.next));
}

// Due dates of a planned payment between from and to (inclusive).
export function occurrences(plan, from, to) {
  const step = FREQUENCIES[plan.frequency]?.months || 0;
  const dates = [];
  let d = plan.due;
  if (!step) return d >= from && d <= to ? [d] : [];
  for (let i = 0; d <= to && i < 600; i++) {
    if (d >= from) dates.push(d);
    d = addMonthsKeepDay(plan.due, step * (i + 1));
  }
  return dates;
}

function addMonthsKeepDay(date, n) {
  const start = addMonths(date, n);
  const day = Math.min(Number(date.slice(8)), Number(monthEnd(start).slice(8)));
  return start.slice(0, 8) + String(day).padStart(2, '0');
}

// The next `months` months with what's planned in each.
export function planTimeline(state, months = 12) {
  const t = today();
  const out = [];
  for (let i = 0; i < months; i++) {
    const start = i === 0 ? t : addMonths(t, i);
    const end = monthEnd(start);
    const items = [];
    for (const p of state.plans || []) for (const date of occurrences(p, start, end)) items.push({ plan: p, date });
    items.sort((a, b) => a.date.localeCompare(b.date));
    out.push({ month: monthStart(start), items, total: items.reduce((s, x) => s + x.plan.amount, 0) });
  }
  return out;
}

// What to put aside each month so the yearly, half-yearly and quarterly costs are covered when they come.
export function monthlyReserve(state) {
  let perYear = 0;
  for (const p of state.plans || []) {
    const step = FREQUENCIES[p.frequency]?.months;
    if (step > 1 && p.amount < 0) perYear += -p.amount * (12 / step);
  }
  return Math.round(perYear / 12);
}
