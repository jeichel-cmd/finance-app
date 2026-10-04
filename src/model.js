// Balances, analysis and mismatch detection, all computed from the stored transactions.
//
// An account's balance is the sum of its transactions. A screenshot's balance is stored as a "check";
// when it differs from the app's balance the check stays open until the person fixes it.
//
// PayPal: a payment PayPal takes from a bank account carries `paidFrom` (that bank account's id).
// It counts as spending once, but does not change the PayPal balance. The matching bank debit is
// categorised as a transfer between own accounts, so it is not counted a second time.

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
    settings: {},
  };
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
  return state.accounts.reduce((s, a) => s + accountBalance(state, a.id, upto), 0);
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
  for (const t of state.transactions) {
    if (t.date < from || t.date > to) continue;
    const kind = txKind(state, t);
    if (kind === 'expense') {
      spent -= t.amount;
      const key = t.category || null;
      const e = byCat.get(key) || { id: key, amount: 0, count: 0 };
      e.amount -= t.amount;
      e.count++;
      byCat.set(key, e);
    } else if (kind === 'income') {
      income += t.amount;
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
    samePayee(t.payee, tx.payee)) || null;
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
