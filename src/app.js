import * as store from './store.js';
import { readScreenshot, warmUp } from './ocr.js';
import { parseScreenshot } from './parse.js';
import { suggestCategory, learn, normalizePayee } from './categorize.js';
import {
  emptyState, ACCOUNT_KINDS, isInvestment, category, accountBalance, netWorth, netWorthSeries, accountSeries,
  changeSince, periodSummary, monthlySpending, spendingInsight, categorySuggestions, uncategorisedCount,
  findExisting, payPalMatch, checkDiff, openChecks, accountStatus, fixSuggestions, correctionTx, refreshChecks,
  countsOnBalance,
} from './model.js';
import { money, percent, today, addDays, addMonths, monthStart, monthLabel, dateLabel, ago, parseTyped, typedValue, uid, esc } from './format.js';
import { lineChart, barChart } from './charts.js';
import { icons } from './icons.js';

const $app = document.getElementById('app');
const ACCOUNT_COLORS = ['#1D4ED8', '#9F2D20', '#0F766E', '#7C3AED', '#A16207', '#BE185D', '#0E7490', '#15171A'];
const LOCK_AFTER_MS = 3 * 60 * 1000;

let state = null;
let vaultExists = false;
let unlockError = '';
let restoreText = null;
let draft = null;
let scanning = null;
let lastPath = '';
let hiddenAt = 0;

// ---------- routing and rendering ----------

function route() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  return { path, parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function paint(html, { tabs = false, active = '' } = {}) {
  $app.innerHTML = html + (tabs ? tabBar(active) : '');
  $app.classList.toggle('with-tabs', tabs);
  const path = location.hash;
  if (path !== lastPath) {
    window.scrollTo(0, 0);
    lastPath = path;
    $app.querySelector('[autofocus]')?.focus();
  }
}

function render() {
  if (!vaultExists) return paint(viewSetup());
  if (!state) return paint(viewLock());
  const r = route();
  const [page, id] = r.parts;
  switch (page) {
    case undefined: return paint(viewOverview(), { tabs: true, active: 'home' });
    case 'account': return paint(viewAccount(id), { tabs: true, active: 'home' });
    case 'account-edit': return paint(viewAccountEdit(id));
    case 'spending': return paint(viewSpending(r.q.get('p') || 'month'), { tabs: true, active: 'spending' });
    case 'category': return paint(viewCategory(id, r.q.get('p') || 'month'), { tabs: true, active: 'spending' });
    case 'scan': return paint(viewScan(r.q.get('account')), { tabs: true, active: 'scan' });
    case 'review': return paint(viewReview());
    case 'fix': return paint(viewFix(id));
    case 'tx': return paint(viewTx(id, r.q));
    case 'settings': return paint(viewSettings());
    case 'categories': return paint(viewCategories());
    default: go('#/');
  }
}

function tabBar(active) {
  const tab = (href, key, icon, label) =>
    `<a class="tab ${active === key ? 'active' : ''}" href="${href}" ${active === key ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></a>`;
  return `<nav class="tabbar" aria-label="Main">
    ${tab('#/', 'home', icons.home, 'Overview')}
    <a class="scan-button ${active === 'scan' ? 'active' : ''}" href="#/scan" aria-label="Add a screenshot">${icons.scan}</a>
    ${tab('#/spending', 'spending', icons.pie, 'Spending')}
  </nav>`;
}

function backBar(href, title = '', extra = '') {
  return `<div class="topbar">
    <a class="icon-button" href="${href}" aria-label="Back">${icons.back}</a>
    <span class="topbar-title">${esc(title)}</span>
    <span class="topbar-extra">${extra}</span>
  </div>`;
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('gone'), 2600);
  setTimeout(() => el.remove(), 3000);
}

// ---------- saving ----------

let saveTimer = null;
function commit({ rerender = true } = {}) {
  refreshChecks(state);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
  if (rerender) render();
}

async function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state) return;
  try {
    await store.save(state);
  } catch (e) {
    toast('Could not save. ' + e.message);
  }
}

function lockNow() {
  if (saveTimer) flush();
  store.lock();
  state = null;
  draft = null;
  unlockError = '';
  render();
}

// ---------- helpers ----------

const accountById = (id) => state.accounts.find((a) => a.id === id) || null;
const catName = (id) => (id ? category(state, id)?.name || 'Uncategorised' : 'Uncategorised');
const catColor = (id) => (id ? category(state, id)?.color || '#94A3B8' : '#94A3B8');

function initials(name) {
  const words = name.trim().split(/\s+/);
  return ((words[0]?.[0] || '') + (words[1]?.[0] || words[0]?.[1] || '')).toUpperCase();
}

function avatar(acc) {
  return `<span class="avatar" style="background:${esc(acc.color)}">${esc(initials(acc.name))}</span>`;
}

function categoryOptions(selected, { includeNone = true } = {}) {
  const groups = { expense: 'Spending', income: 'Money in', neutral: 'Not spending' };
  let html = includeNone ? `<option value="" ${!selected ? 'selected' : ''}>Uncategorised</option>` : '';
  for (const [kind, label] of Object.entries(groups)) {
    html += `<optgroup label="${label}">` +
      state.categories.filter((c) => c.kind === kind).map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('') +
      '</optgroup>';
  }
  return html;
}

function signedClass(cents) {
  return cents > 0 ? 'pos' : cents < 0 ? 'neg' : '';
}

function fundingBank(acc) {
  return acc?.kind === 'wallet' && acc.fundedFrom ? accountById(acc.fundedFrom) : null;
}

function txRow(t, { showAccount = false } = {}) {
  const acc = accountById(t.accountId);
  const paidFrom = t.paidFrom ? accountById(t.paidFrom) : null;
  const match = payPalMatch(state, t);
  const sub = [
    `<span class="chip" style="--c:${esc(catColor(t.category))}">${esc(catName(t.category))}</span>`,
    showAccount && acc ? `<span>${esc(acc.name)}</span>` : '',
    paidFrom ? `<span>paid from ${esc(paidFrom.name)}</span>` : '',
    match ? `<span>for ${esc(match.payee)} in ${esc(accountById(match.accountId)?.name || 'PayPal')}</span>` : '',
  ].filter(Boolean).join('');
  return `<a class="row" href="#/tx/${esc(t.id)}">
    <span class="row-main"><span class="row-title">${esc(t.payee || 'No description')}</span><span class="row-sub">${sub}</span></span>
    <span class="row-end"><span class="amount ${signedClass(t.amount)} ${countsOnBalance(t) ? '' : 'muted'}">${money(t.amount, { sign: true })}</span></span>
  </a>`;
}

function groupByDate(txs) {
  const out = [];
  let current = null;
  for (const t of txs) {
    if (!current || current.date !== t.date) out.push((current = { date: t.date, txs: [] }));
    current.txs.push(t);
  }
  return out;
}

function sortTx(a, b) {
  return b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '');
}

function statusLine(acc) {
  const s = accountStatus(state, acc);
  if (s.state === 'mismatch') return `<span class="warn-text">Doesn't match the last screenshot</span>`;
  if (s.state === 'never') return 'No screenshot yet';
  if (s.state === 'stale') return `<span class="warn-text">Last screenshot ${ago(s.last.date)}</span>`;
  return `Checked ${ago(s.last.date)}`;
}

function diffSentence(diff, subject = 'the app') {
  return diff > 0 ? `${money(diff)} more than ${subject}` : `${money(-diff)} less than ${subject}`;
}

// ---------- setup and lock ----------

function viewSetup() {
  if (restoreText) {
    return `<main class="page narrow centered">
      <h1>Restore a backup</h1>
      <p class="muted">Enter the passcode you used when you saved this backup. It becomes the passcode for this phone.</p>
      <form data-form="restore-setup" class="stack">
        <label class="field">Passcode<input type="password" name="pass" autocomplete="current-password" required autofocus></label>
        ${unlockError ? `<p class="error" role="alert">${esc(unlockError)}</p>` : ''}
        <button class="button primary" type="submit">Restore</button>
        <button class="button plain" type="button" data-action="cancel-restore">Cancel</button>
      </form>
    </main>`;
  }
  return `<main class="page narrow centered">
    <div class="brand-mark" aria-hidden="true">€</div>
    <h1>Your money, on your phone</h1>
    <p class="muted">Everything you add stays on this phone, encrypted with your passcode. Nothing is uploaded, not even your screenshots.</p>
    <form data-form="setup" class="stack">
      <label class="field">Choose a passcode<input type="password" name="p1" inputmode="numeric" autocomplete="new-password" minlength="6" required autofocus></label>
      <label class="field">Repeat it<input type="password" name="p2" inputmode="numeric" autocomplete="new-password" minlength="6" required></label>
      <p class="hint">At least 6 characters. If you forget it, your data can't be recovered, so save a backup now and then (Settings, Backup).</p>
      ${unlockError ? `<p class="error" role="alert">${esc(unlockError)}</p>` : ''}
      <button class="button primary" type="submit">Get started</button>
    </form>
    <label class="button plain file-button">Restore from a backup file<input type="file" accept=".json,application/json" data-change="restore-file"></label>
  </main>`;
}

function viewLock() {
  return `<main class="page narrow centered">
    <div class="brand-mark" aria-hidden="true">${icons.lock}</div>
    <h1>Unlock</h1>
    <form data-form="unlock" class="stack">
      <label class="field">Passcode<input type="password" name="pass" inputmode="numeric" autocomplete="current-password" required autofocus></label>
      ${unlockError ? `<p class="error" role="alert">${esc(unlockError)}</p>` : ''}
      <button class="button primary" type="submit">Unlock</button>
    </form>
    <button class="button plain" data-action="forgot">Forgot your passcode?</button>
  </main>`;
}

// ---------- overview ----------

function viewOverview() {
  const t = today();
  const header = `<div class="topbar">
    <span class="eyebrow">${esc(monthLabel(t))}</span>
    <span class="topbar-extra">
      <button class="icon-button" data-action="lock" aria-label="Lock">${icons.lock}</button>
      <a class="icon-button" href="#/settings" aria-label="Settings">${icons.gear}</a>
    </span>
  </div>`;
  if (!state.accounts.length) {
    return `<main class="page">${header}
      <section class="empty">
        <div class="empty-icon">${icons.image}</div>
        <h1>Add your first account</h1>
        <p class="muted">Take a screenshot of an account in your banking app, PayPal, Trade Republic or an exchange, then add it here. The app reads the balance and transactions on your phone.</p>
        <a class="button primary" href="#/scan">Add a screenshot</a>
        <a class="button plain" href="#/account-edit/new">Add an account by hand</a>
      </section>
    </main>`;
  }
  const total = netWorth(state, t);
  const change = changeSince(state, monthStart(t));
  const before = total - change;
  const pct = before > 0 && change ? ` (${percent(Math.abs(change) / before)})` : '';
  const banners = openChecks(state).map((c) => {
    const acc = c.accountId ? accountById(c.accountId) : null;
    const { diff } = checkDiff(state, c);
    return `<a class="banner" href="#/fix/${esc(c.id)}">
      ${icons.warn}
      <span class="row-main"><span class="row-title">${esc(acc ? acc.name : 'Your total')} doesn't match</span>
      <span class="row-sub">Screenshot shows ${diffSentence(diff)}</span></span>
      <span class="banner-action">Fix</span>
    </a>`;
  }).join('');
  const accounts = [...state.accounts].sort((a, b) => accountBalance(state, b.id) - accountBalance(state, a.id));
  return `<main class="page">${header}
    <section class="hero">
      <div class="label">Total</div>
      <div class="big-number">${money(total)}</div>
      <div class="delta ${signedClass(change)}">${money(change, { sign: true })}${pct} this month</div>
      ${lineChart(netWorthSeries(state, 6))}
    </section>
    ${banners}
    <section>
      <div class="section-head"><h2>Accounts</h2><a class="link" href="#/account-edit/new">${icons.plus}<span>Add</span></a></div>
      <div class="list">
        ${accounts.map((a) => {
          const bal = accountBalance(state, a.id);
          const ch = changeSince(state, monthStart(t), a.id);
          return `<a class="row" href="#/account/${esc(a.id)}">
            ${avatar(a)}
            <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${statusLine(a)}</span></span>
            <span class="row-end"><span class="amount">${money(bal)}</span>${ch ? `<span class="small ${signedClass(ch)}">${money(ch, { sign: true })}</span>` : ''}</span>
          </a>`;
        }).join('')}
      </div>
    </section>
  </main>`;
}

// ---------- account ----------

function viewAccount(id) {
  const acc = accountById(id);
  if (!acc) return viewNotFound();
  const t = today();
  const bal = accountBalance(state, acc.id);
  const ch = changeSince(state, monthStart(t), acc.id);
  const txs = state.transactions.filter((x) => x.accountId === acc.id).sort(sortTx);
  const s = accountStatus(state, acc);
  const bank = fundingBank(acc);
  let status = '';
  if (s.state === 'mismatch') status = `<a class="banner" href="#/fix/${esc(s.last.id)}">${icons.warn}<span class="row-main"><span class="row-title">Doesn't match the screenshot from ${esc(dateLabel(s.last.date))}</span><span class="row-sub">Screenshot shows ${diffSentence(checkDiff(state, s.last).diff)}</span></span><span class="banner-action">Fix</span></a>`;
  else if (s.state === 'stale') status = `<p class="note">The last screenshot is from ${esc(dateLabel(s.last.date))}. Add a new one to keep this account up to date.</p>`;
  else if (s.state === 'ok') status = `<p class="note ok">${icons.check}<span>Matched the screenshot from ${esc(dateLabel(s.last.date))}.</span></p>`;
  return `<main class="page">
    ${backBar('#/', '', `<a class="link" href="#/account-edit/${esc(acc.id)}">Edit</a>`)}
    <section class="hero">
      <div class="title-row">${avatar(acc)}<div><h1 class="h-account">${esc(acc.name)}</h1><div class="small muted">${esc(ACCOUNT_KINDS[acc.kind] || '')}</div></div></div>
      <div class="big-number">${money(bal)}</div>
      <div class="delta ${signedClass(ch)}">${money(ch, { sign: true })} this month</div>
      ${lineChart(accountSeries(state, acc.id, 6))}
    </section>
    ${status}
    ${bank ? `<p class="note">Payments marked "paid from ${esc(bank.name)}" count as spending here but don't change the ${esc(acc.name)} balance. The matching debit in ${esc(bank.name)} counts as a transfer, so nothing is counted twice.</p>` : ''}
    <div class="button-row">
      <a class="button primary" href="#/scan?account=${esc(acc.id)}">Add screenshot</a>
      <a class="button secondary" href="#/tx/new?account=${esc(acc.id)}">Add by hand</a>
    </div>
    <section>
      <div class="section-head"><h2>Transactions</h2></div>
      ${txs.length ? groupByDate(txs).map((g) => `<div class="date-head">${esc(dateLabel(g.date))}</div><div class="list">${g.txs.map((x) => txRow(x)).join('')}</div>`).join('') : '<p class="muted">No transactions yet.</p>'}
    </section>
  </main>`;
}

function viewAccountEdit(id) {
  const isNew = id === 'new';
  const acc = isNew ? { name: '', kind: 'bank', fundedFrom: null } : accountById(id);
  if (!acc) return viewNotFound();
  const banks = state.accounts.filter((a) => a.kind === 'bank' && a.id !== acc.id);
  return `<main class="page">
    ${backBar(isNew ? '#/' : `#/account/${esc(id)}`, isNew ? 'New account' : 'Edit account')}
    <form data-form="account" data-id="${esc(id)}" class="stack">
      <label class="field">Name<input name="name" value="${esc(acc.name)}" placeholder="e.g. Sparkasse Giro" required ${isNew ? 'autofocus' : ''}></label>
      <label class="field">Type<select name="kind" data-change="account-kind">${Object.entries(ACCOUNT_KINDS).map(([k, v]) => `<option value="${k}" ${k === acc.kind ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label class="field ${acc.kind === 'wallet' ? '' : 'hidden'}" data-wallet-only>Payments are usually taken from
        <select name="fundedFrom"><option value="">The ${esc(acc.name || 'wallet')} balance</option>${banks.map((b) => `<option value="${esc(b.id)}" ${b.id === acc.fundedFrom ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
        <span class="hint">PayPal often takes payments straight from your bank. Choosing the bank here counts each payment once, in PayPal, and treats the bank debit as a transfer.</span>
      </label>
      ${isNew ? `<label class="field">Current balance (optional)<input name="balance" inputmode="decimal" placeholder="0,00"></label>` : ''}
      <button class="button primary" type="submit">${isNew ? 'Add account' : 'Save'}</button>
      ${isNew ? '' : `<button class="button danger" type="button" data-action="delete-account" data-id="${esc(id)}">Delete account</button>`}
    </form>
  </main>`;
}

// ---------- spending ----------

const PERIODS = { month: 'This month', last: 'Last month', '3m': '3 months', year: 'Year' };

function periodRange(p) {
  const t = today();
  if (p === 'last') { const s = addMonths(t, -1); return [s, addDays(monthStart(t), -1)]; }
  if (p === '3m') return [addMonths(t, -2), t];
  if (p === 'year') return [addMonths(t, -11), t];
  return [monthStart(t), t];
}

function viewSpending(p) {
  if (!PERIODS[p]) p = 'month';
  const [from, to] = periodRange(p);
  const s = periodSummary(state, from, to);
  const max = Math.max(1, ...s.categories.map((c) => c.amount));
  const insight = p === 'month' ? spendingInsight(state) : null;
  const suggestions = categorySuggestions(state).slice(0, 3);
  const unc = uncategorisedCount(state);
  return `<main class="page">
    <div class="topbar"><h1 class="page-title">Spending</h1></div>
    <div class="pills" role="tablist">${Object.entries(PERIODS).map(([k, v]) => `<a class="pill ${k === p ? 'active' : ''}" href="#/spending?p=${k}" role="tab" aria-selected="${k === p}">${v}</a>`).join('')}</div>
    <div class="cards">
      <div class="card"><div class="label">Spent</div><div class="mid-number">${money(s.spent)}</div></div>
      <div class="card"><div class="label">Came in</div><div class="mid-number">${money(s.income)}</div><div class="small ${signedClass(s.saved)}">${s.saved >= 0 ? 'Saved' : 'Overspent'} ${money(Math.abs(s.saved))}</div></div>
    </div>
    ${insight ? `<p class="note">${icons.spark}<span>${esc(catName(insight.id))} is ${money(insight.diff)} above your usual ${money(insight.avg)} a month.</span></p>` : ''}
    ${suggestions.map((g) => `<div class="suggestion">
      <div class="row-title">Suggestion</div>
      <p>Put ${g.ids.length > 1 ? `${g.ids.length} payments to` : ''} "${esc(g.payee)}" in ${esc(catName(g.category))}?</p>
      <div class="button-row tight">
        <button class="button primary small" data-action="apply-suggestion" data-ids="${esc(g.ids.join(','))}" data-cat="${esc(g.category)}">Apply</button>
        <a class="button plain small" href="#/category/none?p=year">Choose myself</a>
      </div>
    </div>`).join('')}
    <section>
      <div class="section-head"><h2>By category</h2></div>
      ${s.categories.length ? `<div class="list padded">${s.categories.map((c) => `<a class="cat-row" href="#/category/${esc(c.id || 'none')}?p=${p}">
        <span class="cat-line"><span class="row-title">${esc(catName(c.id))}</span><span class="amount">${money(c.amount)}</span></span>
        <span class="meter"><span style="width:${Math.round((c.amount / max) * 100)}%;background:${esc(catColor(c.id))}"></span></span>
      </a>`).join('')}</div>` : '<p class="muted">No spending in this period yet.</p>'}
      ${unc ? `<p class="small muted">${unc} transaction${unc > 1 ? 's are' : ' is'} uncategorised. <a class="link" href="#/category/none?p=year">Sort them</a></p>` : ''}
    </section>
    <section>
      <div class="section-head"><h2>Last 6 months</h2></div>
      <div class="card">${barChart(monthlySpending(state, 6))}</div>
    </section>
    <p class="small muted">Transfers between your own accounts, investments and balance corrections aren't counted as spending.</p>
  </main>`;
}

function viewCategory(id, p) {
  const catId = id === 'none' ? null : id;
  if (!PERIODS[p]) p = 'month';
  const [from, to] = periodRange(p);
  const txs = state.transactions.filter((t) => (t.category || null) === catId && t.date >= from && t.date <= to).sort(sortTx);
  return `<main class="page">
    ${backBar(`#/spending?p=${p}`, catName(catId))}
    <p class="muted small">${esc(PERIODS[p])}. Change a category here and similar payments will be suggested the same way next time.</p>
    ${txs.length ? `<div class="list">${txs.map((t) => `<div class="row">
      <a class="row-main" href="#/tx/${esc(t.id)}"><span class="row-title">${esc(t.payee || 'No description')}</span><span class="row-sub"><span>${esc(dateLabel(t.date))}</span><span>${esc(accountById(t.accountId)?.name || '')}</span></span></a>
      <span class="row-end"><span class="amount ${signedClass(t.amount)}">${money(t.amount, { sign: true })}</span>
      <select class="mini-select" data-change="set-category" data-id="${esc(t.id)}" aria-label="Category for ${esc(t.payee)}">${categoryOptions(t.category)}</select></span>
    </div>`).join('')}</div>` : '<p class="muted">Nothing here.</p>'}
  </main>`;
}

// ---------- scanning ----------

function viewScan(accountId) {
  warmUp();
  const acc = accountId ? accountById(accountId) : null;
  if (scanning) {
    return `<main class="page narrow">
      <div class="topbar"><h1 class="page-title">Reading…</h1></div>
      <p class="muted">${esc(scanning.label)}</p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(scanning.progress * 100)}"><span style="width:${Math.round(scanning.progress * 100)}%"></span></div>
      <p class="small muted">This happens on your phone. The first time can take a little longer while the reader loads.</p>
    </main>`;
  }
  return `<main class="page narrow">
    <div class="topbar"><h1 class="page-title">Add a screenshot</h1></div>
    <p class="muted">Take a screenshot of ${acc ? esc(acc.name) : 'an account'} showing the balance or a list of transactions, then choose it here. It's read on this phone and isn't stored or uploaded.</p>
    <label class="dropzone">
      ${icons.image}
      <span class="row-title">Choose screenshots</span>
      <span class="small muted">You can pick several at once for a long list</span>
      <input type="file" accept="image/*" multiple data-change="scan-files" data-account="${esc(accountId || '')}">
    </label>
    <ul class="tips">
      <li>Include the balance if you can. It's how the app checks it's not missing anything.</li>
      <li>Light or dark mode both work. Cropping isn't needed.</li>
      <li>You'll check everything before it's saved.</li>
    </ul>
  </main>`;
}

async function startScan(files, accountId) {
  scanning = { label: 'Loading the reader', progress: 0 };
  go('#/scan' + (accountId ? `?account=${accountId}` : ''));
  const all = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const name = files.length > 1 ? `screenshot ${i + 1} of ${files.length}` : 'your screenshot';
      const lines = await readScreenshot(files[i], (m) => {
        if (!scanning) return;
        if (m.status === 'recognizing text') { scanning.label = `Reading ${name}`; scanning.progress = (i + m.progress) / files.length; }
        else if (/load/.test(m.status)) scanning.label = 'Loading the reader';
        const bar = $app.querySelector('.progress span');
        const label = $app.querySelector('.page > p.muted');
        if (bar) bar.style.width = Math.round(scanning.progress * 100) + '%';
        if (label) label.textContent = scanning.label;
      });
      all.push(...lines, { text: '', height: 0 });
    }
  } catch (e) {
    scanning = null;
    toast('The screenshot could not be read. ' + (e.message || ''));
    render();
    return;
  }
  scanning = null;
  draft = buildDraft(parseScreenshot(all, today()), accountId);
  go('#/review');
}

function buildDraft(parsed, accountId) {
  let choice = accountId || '';
  if (!choice && parsed.provider) {
    const p = parsed.provider.name.toLowerCase();
    choice = state.accounts.find((a) => a.name.toLowerCase().includes(p))?.id || 'new';
  }
  if (!choice) choice = state.accounts.length === 1 ? state.accounts[0].id : 'new';
  // Screenshots of a scrolling list overlap; keep each transaction once.
  const seen = new Set();
  const rows = [];
  for (const t of parsed.transactions) {
    const k = `${normalizePayee(t.payee)}|${t.amount}|${t.date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ ...t, id: uid(), include: true, category: null, paidFromBank: false, existing: false });
  }
  const d = {
    account: choice,
    newName: parsed.provider?.name || '',
    newKind: parsed.provider?.kind || 'bank',
    balance: parsed.balance,
    balanceDate: today(),
    rows,
    text: parsed.text,
  };
  applyAccountToDraft(d);
  return d;
}

function draftAccount(d) {
  if (d.account === 'new') return { id: null, name: d.newName, kind: d.newKind, fundedFrom: d.newKind === 'wallet' ? state.accounts.find((a) => a.kind === 'bank')?.id || null : null };
  if (d.account === 'total') return null;
  return accountById(d.account);
}

// Marks rows that are already saved, and fills in suggested categories and PayPal funding.
function applyAccountToDraft(d) {
  const acc = draftAccount(d);
  const used = new Set();
  for (const r of d.rows) {
    const existing = acc?.id ? findExisting(state, acc.id, r, used) : null;
    if (existing) used.add(existing.id);
    r.existing = Boolean(existing);
    r.include = !existing;
    if (!r.categoryTouched) r.category = suggestCategory(r.payee, r.amount, state.rules, acc);
    r.paidFromBank = Boolean(acc && fundingBank(acc) && r.amount < 0);
  }
}

function viewReview() {
  if (!draft) return viewScan();
  const d = draft;
  const acc = draftAccount(d);
  const bank = acc?.kind === 'wallet' ? (acc.fundedFrom ? accountById(acc.fundedFrom) : null) : null;
  const newCount = d.rows.filter((r) => !r.existing).length;
  const nothing = d.balance == null && !d.rows.length;
  const rows = d.rows.map((r, i) => `<div class="tx-edit ${r.existing ? 'dim' : ''}" data-row="${i}">
    <div class="tx-edit-top">
      <label class="checkbox"><input type="checkbox" data-row-field="include" ${r.include ? 'checked' : ''} aria-label="Save this transaction"></label>
      <input class="input payee" data-row-field="payee" value="${esc(r.payee)}" aria-label="Description">
      <input class="input amount-input ${signedClass(r.amount)}" data-row-field="amount" inputmode="decimal" value="${esc(typedValue(r.amount))}" aria-label="Amount">
    </div>
    <div class="tx-edit-bottom">
      <input class="input date" type="date" data-row-field="date" value="${esc(r.date)}" aria-label="Date">
      <select class="input" data-row-field="category" aria-label="Category">${categoryOptions(r.category)}</select>
    </div>
    ${bank && r.amount < 0 ? `<label class="inline-check"><input type="checkbox" data-row-field="paidFromBank" ${r.paidFromBank ? 'checked' : ''}>Paid from ${esc(bank.name)}</label>` : ''}
    ${r.existing ? '<span class="badge">Already saved</span>' : ''}
    ${r.signGuessed && !r.existing ? '<span class="hint">No + or − on the screenshot, so this is a guess. Add a minus for money going out.</span>' : ''}
  </div>`).join('');
  return `<main class="page">
    ${backBar('#/scan', 'Check what was read')}
    <p class="muted">Read on this phone. Correct anything that's wrong, then save.</p>
    ${nothing ? '<p class="note">No amounts were found. You can type the balance below, or try a sharper screenshot.</p>' : ''}
    <div class="card stack">
      <label class="field">Account<select data-change="draft-account">
        ${state.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === d.account ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
        <option value="new" ${d.account === 'new' ? 'selected' : ''}>New account…</option>
        ${state.accounts.length > 1 ? `<option value="total" ${d.account === 'total' ? 'selected' : ''}>Total of all my accounts</option>` : ''}
      </select></label>
      ${d.account === 'new' ? `<label class="field">Name<input data-draft="newName" value="${esc(d.newName)}" placeholder="e.g. Sparkasse Giro"></label>
        <label class="field">Type<select data-change="draft-kind">${Object.entries(ACCOUNT_KINDS).map(([k, v]) => `<option value="${k}" ${k === d.newKind ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>` : ''}
      <div class="two">
        <label class="field">Balance on screenshot<input data-draft="balance" inputmode="decimal" value="${d.balance == null ? '' : esc(typedValue(d.balance))}" placeholder="Not shown"></label>
        <label class="field">On<input type="date" data-draft="balanceDate" value="${esc(d.balanceDate)}"></label>
      </div>
    </div>
    ${d.account === 'total' ? '<p class="note">This compares the screenshot with the total of all your accounts in the app.</p>' : `<section>
      <div class="section-head"><h2>${d.rows.length ? `${d.rows.length} transaction${d.rows.length > 1 ? 's' : ''} found${d.rows.length !== newCount ? `, ${newCount} new` : ''}` : 'Transactions'}</h2></div>
      ${rows}
      <button class="button plain" data-action="draft-add-row">${icons.plus}<span>Add a line that was missed</span></button>
    </section>`}
    <details class="raw"><summary>Show the text that was read</summary><pre>${esc(d.text)}</pre></details>
    <div class="sticky-actions"><button class="button primary wide" data-action="save-draft">Save</button></div>
  </main>`;
}

function saveDraft() {
  const d = draft;
  const nowIso = new Date().toISOString();
  if (d.account === 'new' && !d.newName.trim()) { toast('Give the new account a name.'); return; }
  if (d.account === 'total') {
    if (d.balance == null) { toast('Type the total shown on the screenshot.'); return; }
    const check = { id: uid(), accountId: null, date: d.balanceDate, balance: d.balance, candidates: [], status: 'open', createdAt: nowIso };
    check.status = checkDiff(state, check).diff === 0 ? 'match' : 'open';
    state.checks.push(check);
    draft = null;
    commit({ rerender: false });
    if (check.status === 'open') go(`#/fix/${check.id}`);
    else { toast('Your total matches the screenshot.'); go('#/'); }
    return;
  }
  let acc = d.account === 'new' ? null : accountById(d.account);
  if (!acc) {
    const tmpl = draftAccount(d);
    acc = { id: uid(), name: d.newName.trim(), kind: d.newKind, color: ACCOUNT_COLORS[state.accounts.length % ACCOUNT_COLORS.length], fundedFrom: tmpl.fundedFrom, createdAt: nowIso };
    state.accounts.push(acc);
  }
  const firstTime = !state.transactions.some((t) => t.accountId === acc.id);
  const bank = fundingBank(acc);
  const saved = [];
  for (const r of d.rows) {
    if (!r.include || r.amount === 0) continue;
    const tx = { id: uid(), accountId: acc.id, date: r.date, payee: r.payee.trim(), amount: r.amount, category: r.category || null, source: 'scan', createdAt: nowIso };
    if (bank && r.paidFromBank && r.amount < 0) tx.paidFrom = bank.id;
    state.transactions.push(tx);
    saved.push(tx);
    if (r.category && r.categoryTouched) learn(state.rules, tx.payee, r.category);
  }
  let message = saved.length ? `Saved ${saved.length} transaction${saved.length === 1 ? '' : 's'}.` : '';
  let goTo = `#/account/${acc.id}`;
  if (d.balance != null) {
    if (firstTime) {
      // The first screenshot of an account sets its starting balance.
      const gap = d.balance - accountBalance(state, acc.id, d.balanceDate);
      if (gap) {
        const earliest = saved.reduce((m, t) => (t.date < m ? t.date : m), d.balanceDate);
        state.transactions.push({ id: uid(), accountId: acc.id, date: addDays(earliest, -1), payee: 'Starting balance', amount: gap, category: 'correction', source: 'opening', createdAt: nowIso });
      }
    }
    const candidates = d.rows.filter((r) => !r.include && !r.existing && r.amount).map((r) => ({ id: r.id, payee: r.payee, amount: r.amount, date: r.date, category: r.category || null }));
    const check = { id: uid(), accountId: acc.id, date: d.balanceDate, balance: d.balance, candidates, status: 'open', createdAt: nowIso };
    const { diff } = checkDiff(state, check);
    if (diff === 0) {
      check.status = 'match';
      message = `${message} ${acc.name} matches the screenshot.`.trim();
    } else if (isInvestment(acc) && !candidates.length) {
      // Investments move with the market; the difference is their change in value.
      state.transactions.push(correctionTx(state, check));
      check.status = 'match';
      message = `Updated ${acc.name}: value changed by ${money(diff, { sign: true })}.`;
    } else {
      goTo = `#/fix/${check.id}`;
    }
    state.checks.push(check);
  }
  draft = null;
  commit({ rerender: false });
  if (!goTo.startsWith('#/fix') && message) toast(message);
  go(goTo);
}

// ---------- fixing a mismatch ----------

function viewFix(id) {
  const check = state.checks.find((c) => c.id === id);
  if (!check) return viewNotFound();
  const acc = check.accountId ? accountById(check.accountId) : null;
  const back = acc ? `#/account/${acc.id}` : '#/';
  const name = acc ? acc.name : 'Your total';
  const { app, diff } = checkDiff(state, check);
  if (check.status !== 'open') {
    return `<main class="page narrow">${backBar(back)}
      <section class="empty"><div class="empty-icon ok">${icons.check}</div><h1>${esc(name)} matches</h1>
      <p class="muted">The app now agrees with the screenshot from ${esc(dateLabel(check.date))}.</p>
      <a class="button primary" href="${back}">Done</a></section></main>`;
  }
  const ideas = fixSuggestions(state, check).map((s) => {
    const t = s.tx || s.candidate;
    const what = t ? `${esc(t.payee)} (${money(t.amount, { sign: true })}, ${esc(dateLabel(t.date))})` : '';
    const card = (text, label, action, data = '') => `<div class="suggestion"><p>${text}</p><button class="button primary small" data-action="${action}" data-check="${esc(check.id)}" ${data}>${label}</button></div>`;
    switch (s.type) {
      case 'add': return card(`This transaction was on the screenshot but wasn't saved: ${what}.`, 'Add it', 'fix-add', `data-ids="${esc(t.id)}"`);
      case 'add-two': return card(`These two weren't saved and add up to the difference: ${s.candidates.map((c) => `${esc(c.payee)} (${money(c.amount, { sign: true })})`).join(' and ')}.`, 'Add both', 'fix-add', `data-ids="${esc(s.candidates.map((c) => c.id).join(','))}"`);
      case 'duplicate': return card(`${what} looks like it was saved twice.`, 'Remove the copy', 'fix-remove', `data-tx="${esc(t.id)}"`);
      case 'flip': return card(`${what} might have been saved the wrong way round.`, money(-t.amount, { sign: true }) + ' instead', 'fix-flip', `data-tx="${esc(t.id)}"`);
      case 'paid-from-balance': return card(`${what} is marked as paid from your bank. If it was paid from the ${esc(name)} balance, everything matches.`, 'Paid from balance', 'fix-funding', `data-tx="${esc(t.id)}" data-to=""`);
      case 'paid-from-bank': return card(`${what} might have been paid from ${esc(fundingBank(acc)?.name || 'your bank')} rather than the ${esc(name)} balance.`, 'Paid from bank', 'fix-funding', `data-tx="${esc(t.id)}" data-to="${esc(acc.fundedFrom)}"`);
      default: return '';
    }
  }).join('');
  const investment = isInvestment(acc);
  const accountsList = !acc ? `<section><div class="section-head"><h2>Accounts</h2></div><p class="small muted">Accounts without a recent screenshot are the usual cause. Adding one for each usually finds it.</p>
    <div class="list">${state.accounts.map((a) => `<a class="row" href="#/scan?account=${esc(a.id)}">${avatar(a)}<span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${statusLine(a)}</span></span><span class="row-end"><span class="amount">${money(accountBalance(state, a.id, check.date))}</span></span></a>`).join('')}</div></section>` : '';
  return `<main class="page">
    ${backBar(back)}
    <h1>${esc(name)} doesn't match</h1>
    <div class="card compare">
      <div><span class="muted">Screenshot, ${esc(dateLabel(check.date))}</span><span class="amount">${money(check.balance)}</span></div>
      <div><span class="muted">In the app</span><span class="amount">${money(app)}</span></div>
      <div class="total"><span>Difference</span><span class="amount warn-text">${money(diff, { sign: true })}</span></div>
    </div>
    ${ideas ? `<section><div class="section-head"><h2>Likely cause</h2></div>${ideas}</section>` : ''}
    ${accountsList}
    <section class="stack">
      ${acc ? `<a class="button secondary wide" href="#/tx/new?account=${esc(acc.id)}&amount=${diff}&check=${esc(check.id)}">Add a missing transaction</a>
      <a class="button secondary wide" href="#/scan?account=${esc(acc.id)}">Add another screenshot</a>
      <button class="button secondary wide" data-action="fix-correct" data-check="${esc(check.id)}">${investment ? 'Record as a change in value' : `Set the balance to ${money(check.balance)}`}</button>
      <p class="hint">${investment ? 'For investments the difference is usually the market moving. It is recorded as a value change, not as spending.' : `Adds a correction of ${money(diff, { sign: true })} that isn't counted as spending. Use it when you can't find the cause.`}</p>` : ''}
      <button class="button plain wide" data-action="fix-ignore" data-check="${esc(check.id)}">Ignore this time</button>
    </section>
  </main>`;
}

// ---------- add or edit a transaction ----------

function viewTx(id, q) {
  const isNew = id === 'new';
  let t = isNew ? null : state.transactions.find((x) => x.id === id);
  if (!isNew && !t) return viewNotFound();
  if (isNew) {
    const amount = Number(q.get('amount')) || 0;
    t = { accountId: q.get('account') || state.accounts[0]?.id || '', amount: amount || -0, payee: '', date: today(), category: null, note: '' };
  }
  if (!state.accounts.length) return `<main class="page">${backBar('#/')}<p class="muted">Add an account first.</p><a class="button primary" href="#/account-edit/new">Add an account</a></main>`;
  const acc = accountById(t.accountId);
  const bank = fundingBank(acc);
  const match = !isNew ? payPalMatch(state, t) : null;
  const back = q.get('check') ? `#/fix/${q.get('check')}` : acc ? `#/account/${acc.id}` : '#/';
  const out = isNew ? !(t.amount > 0) : t.amount < 0;
  return `<main class="page">
    ${backBar(back, isNew ? 'Add transaction' : 'Transaction')}
    <form data-form="tx" data-id="${esc(id)}" data-check="${esc(q.get('check') || '')}" class="stack">
      <div class="segmented" role="radiogroup" aria-label="Direction">
        <label><input type="radio" name="dir" value="out" ${out ? 'checked' : ''}><span>Money out</span></label>
        <label><input type="radio" name="dir" value="in" ${!out ? 'checked' : ''}><span>Money in</span></label>
      </div>
      <label class="field">Amount<input name="amount" inputmode="decimal" value="${t.amount ? esc(typedValue(Math.abs(t.amount))) : ''}" placeholder="0,00" required ${isNew ? 'autofocus' : ''}></label>
      <label class="field">Description<input name="payee" value="${esc(t.payee)}" placeholder="e.g. REWE" data-input="payee-suggest"></label>
      <div class="two">
        <label class="field">Date<input type="date" name="date" value="${esc(t.date)}" required></label>
        <label class="field">Account<select name="accountId">${state.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === t.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      </div>
      <label class="field">Category<select name="category" data-change="touch">${categoryOptions(t.category)}</select></label>
      ${bank ? `<label class="inline-check"><input type="checkbox" name="paidFrom" ${t.paidFrom || (isNew && out) ? 'checked' : ''}>Paid from ${esc(bank.name)} (doesn't change the ${esc(acc.name)} balance)</label>` : ''}
      ${match ? `<p class="note">This bank debit paid for ${esc(match.payee)} in ${esc(accountById(match.accountId)?.name || 'PayPal')}, so it counts as a transfer, not spending.</p>` : ''}
      <label class="field">Note<input name="note" value="${esc(t.note || '')}" placeholder="Optional"></label>
      <button class="button primary" type="submit">${isNew ? 'Add' : 'Save'}</button>
      ${isNew ? '' : `<button class="button danger" type="button" data-action="delete-tx" data-id="${esc(id)}">Delete</button>`}
    </form>
  </main>`;
}

// ---------- settings ----------

function viewSettings() {
  return `<main class="page">
    ${backBar('#/', 'Settings')}
    <section>
      <div class="list">
        <a class="row" href="#/categories"><span class="row-main"><span class="row-title">Categories</span><span class="row-sub">${state.categories.length} categories</span></span>${icons.chevron}</a>
      </div>
    </section>
    <section>
      <div class="section-head"><h2>Backup</h2></div>
      <p class="small muted">Your data only exists on this phone. A backup file lets you restore it if the phone is lost or the app is removed. The file is encrypted with your passcode.</p>
      <div class="button-row">
        <button class="button secondary" data-action="backup">Save a backup</button>
        <label class="button plain file-button">Restore<input type="file" accept=".json,application/json" data-change="restore-into"></label>
      </div>
    </section>
    <section>
      <div class="section-head"><h2>Passcode</h2></div>
      <form data-form="passcode" class="stack">
        <label class="field">New passcode<input type="password" name="p1" inputmode="numeric" autocomplete="new-password" minlength="6" required></label>
        <label class="field">Repeat it<input type="password" name="p2" inputmode="numeric" autocomplete="new-password" minlength="6" required></label>
        <button class="button secondary" type="submit">Change passcode</button>
      </form>
    </section>
    <section>
      <div class="section-head"><h2>Privacy</h2></div>
      <p class="small muted">Everything is stored encrypted on this phone and the app locks itself after 3 minutes in the background. Screenshots are read on the phone, then discarded; they're never stored or uploaded. The app works offline.</p>
    </section>
    <section>
      <button class="button danger wide" data-action="wipe">Delete all data</button>
    </section>
  </main>`;
}

function viewCategories() {
  const groups = { expense: 'Spending', income: 'Money in', neutral: 'Not counted as spending' };
  const fixed = new Set(['transfer', 'value-change', 'correction']);
  return `<main class="page">
    ${backBar('#/settings', 'Categories')}
    ${Object.entries(groups).map(([kind, label]) => `<section>
      <div class="section-head"><h2>${label}</h2></div>
      <div class="list">${state.categories.filter((c) => c.kind === kind).map((c) => `<div class="row">
        <span class="dot" style="background:${esc(c.color)}"></span>
        <input class="input bare" value="${esc(c.name)}" data-change="rename-category" data-id="${esc(c.id)}" aria-label="Category name">
        ${fixed.has(c.id) ? '' : `<button class="icon-button small-text" data-action="delete-category" data-id="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">Delete</button>`}
      </div>`).join('')}</div>
    </section>`).join('')}
    <section>
      <div class="section-head"><h2>New category</h2></div>
      <form data-form="category" class="stack">
        <div class="two">
          <label class="field">Name<input name="name" required></label>
          <label class="field">Counts as<select name="kind">${Object.entries(groups).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        </div>
        <button class="button secondary" type="submit">Add category</button>
      </form>
    </section>
  </main>`;
}

function viewNotFound() {
  return `<main class="page">${backBar('#/')}<p class="muted">This item no longer exists.</p></main>`;
}

// ---------- form handlers ----------

const forms = {
  async setup(f) {
    const p1 = f.get('p1'), p2 = f.get('p2');
    if (p1.length < 6) return fail('Use at least 6 characters.');
    if (p1 !== p2) return fail("The two passcodes don't match.");
    state = emptyState();
    await store.create(p1, state);
    vaultExists = true;
    unlockError = '';
    go('#/');
  },
  async unlock(f) {
    const btn = $app.querySelector('button[type=submit]');
    if (btn) { btn.disabled = true; btn.textContent = 'Unlocking…'; }
    const s = await store.unlock(f.get('pass'));
    if (!s) return fail('That passcode is not right.');
    state = { ...emptyState(), ...s };
    unlockError = '';
    render();
  },
  async 'restore-setup'(f) {
    const s = await store.readBackup(restoreText, f.get('pass')).catch(() => undefined);
    if (s === undefined) { restoreText = null; return fail("That file isn't a backup from this app."); }
    if (!s) return fail("That passcode doesn't open this backup.");
    state = { ...emptyState(), ...s };
    await store.create(f.get('pass'), state);
    vaultExists = true;
    restoreText = null;
    unlockError = '';
    toast('Backup restored.');
    go('#/');
  },
  account(f, form) {
    const id = form.dataset.id;
    const name = f.get('name').trim();
    if (!name) return;
    const kind = f.get('kind');
    const fundedFrom = kind === 'wallet' ? f.get('fundedFrom') || null : null;
    if (id === 'new') {
      const acc = { id: uid(), name, kind, fundedFrom, color: ACCOUNT_COLORS[state.accounts.length % ACCOUNT_COLORS.length], createdAt: new Date().toISOString() };
      state.accounts.push(acc);
      const bal = parseTyped(f.get('balance'));
      if (bal) state.transactions.push({ id: uid(), accountId: acc.id, date: today(), payee: 'Starting balance', amount: bal, category: 'correction', source: 'opening', createdAt: new Date().toISOString() });
      commit({ rerender: false });
      go(`#/account/${acc.id}`);
    } else {
      Object.assign(accountById(id), { name, kind, fundedFrom });
      commit({ rerender: false });
      go(`#/account/${id}`);
    }
  },
  tx(f, form) {
    const id = form.dataset.id;
    const value = parseTyped(f.get('amount'));
    if (!value) { toast('Enter an amount.'); return; }
    const amount = f.get('dir') === 'out' ? -Math.abs(value) : Math.abs(value);
    const accountId = f.get('accountId');
    const acc = accountById(accountId);
    const bank = fundingBank(acc);
    const fields = {
      accountId, amount,
      payee: f.get('payee').trim(),
      date: f.get('date'),
      category: f.get('category') || null,
      note: f.get('note').trim(),
    };
    let t;
    if (id === 'new') {
      t = { id: uid(), source: 'manual', createdAt: new Date().toISOString(), ...fields };
      state.transactions.push(t);
    } else {
      t = state.transactions.find((x) => x.id === id);
      Object.assign(t, fields);
    }
    if (bank && f.get('paidFrom') && amount < 0) t.paidFrom = bank.id;
    else delete t.paidFrom;
    if (form.querySelector('[name=category]').dataset.touched && fields.category) learn(state.rules, fields.payee, fields.category);
    commit({ rerender: false });
    const check = form.dataset.check;
    go(check ? `#/fix/${check}` : `#/account/${accountId}`);
  },
  async passcode(f, form) {
    if (f.get('p1').length < 6) return toast('Use at least 6 characters.');
    if (f.get('p1') !== f.get('p2')) return toast("The two passcodes don't match.");
    await store.changePasscode(state, f.get('p1'));
    form.reset();
    toast('Passcode changed. Older backups still open with the old passcode.');
  },
  category(f, form) {
    const name = f.get('name').trim();
    if (!name) return;
    const colors = ['#2F7D5B', '#C2410C', '#1D4ED8', '#7C3AED', '#BE185D', '#0E7490', '#A16207'];
    state.categories.push({ id: uid(), name, kind: f.get('kind'), color: colors[state.categories.length % colors.length] });
    form.reset();
    commit();
  },
};

function fail(message) {
  unlockError = message;
  render();
}

// ---------- actions ----------

function fixedCheck(id) {
  return state.checks.find((c) => c.id === id);
}

const actions = {
  lock: lockNow,
  forgot() {
    if (!confirm('Without the passcode the data can\'t be opened. Delete everything on this phone and start again? You can restore a backup afterwards.')) return;
    store.wipe().then(() => { vaultExists = false; state = null; go('#/'); });
  },
  'cancel-restore'() { restoreText = null; unlockError = ''; render(); },
  'apply-suggestion'(el) {
    const ids = new Set(el.dataset.ids.split(','));
    for (const t of state.transactions) if (ids.has(t.id)) { t.category = el.dataset.cat; learn(state.rules, t.payee, el.dataset.cat); }
    toast(`Moved to ${catName(el.dataset.cat)}.`);
    commit();
  },
  'draft-add-row'() {
    draft.rows.push({ id: uid(), payee: '', amount: 0, date: draft.balanceDate, include: true, category: null, existing: false, categoryTouched: false });
    render();
    $app.querySelector(`[data-row="${draft.rows.length - 1}"] .payee`)?.focus();
  },
  'save-draft': saveDraft,
  'fix-add'(el) {
    const check = fixedCheck(el.dataset.check);
    const ids = new Set(el.dataset.ids.split(','));
    for (const c of check.candidates) {
      if (!ids.has(c.id)) continue;
      c.used = true;
      state.transactions.push({ id: uid(), accountId: check.accountId, date: c.date, payee: c.payee, amount: c.amount, category: c.category, source: 'scan', createdAt: new Date().toISOString() });
    }
    commit();
  },
  'fix-remove'(el) {
    state.transactions = state.transactions.filter((t) => t.id !== el.dataset.tx);
    commit();
  },
  'fix-flip'(el) {
    const t = state.transactions.find((x) => x.id === el.dataset.tx);
    t.amount = -t.amount;
    commit();
  },
  'fix-funding'(el) {
    const t = state.transactions.find((x) => x.id === el.dataset.tx);
    if (el.dataset.to) t.paidFrom = el.dataset.to;
    else delete t.paidFrom;
    commit();
  },
  'fix-correct'(el) {
    const check = fixedCheck(el.dataset.check);
    state.transactions.push(correctionTx(state, check));
    commit();
  },
  'fix-ignore'(el) {
    const check = fixedCheck(el.dataset.check);
    check.status = 'ignored';
    commit({ rerender: false });
    go(check.accountId ? `#/account/${check.accountId}` : '#/');
  },
  'delete-tx'(el) {
    if (!confirm('Delete this transaction?')) return;
    const t = state.transactions.find((x) => x.id === el.dataset.id);
    state.transactions = state.transactions.filter((x) => x !== t);
    commit({ rerender: false });
    go(`#/account/${t.accountId}`);
  },
  'delete-account'(el) {
    const acc = accountById(el.dataset.id);
    if (!confirm(`Delete ${acc.name} and all its transactions?`)) return;
    state.accounts = state.accounts.filter((a) => a !== acc);
    state.transactions = state.transactions.filter((t) => t.accountId !== acc.id);
    state.checks = state.checks.filter((c) => c.accountId !== acc.id);
    for (const a of state.accounts) if (a.fundedFrom === acc.id) a.fundedFrom = null;
    for (const t of state.transactions) if (t.paidFrom === acc.id) delete t.paidFrom;
    commit({ rerender: false });
    go('#/');
  },
  'delete-category'(el) {
    const c = category(state, el.dataset.id);
    const used = state.transactions.filter((t) => t.category === c.id).length;
    if (!confirm(used ? `Delete ${c.name}? ${used} transaction${used > 1 ? 's' : ''} will become uncategorised.` : `Delete ${c.name}?`)) return;
    state.categories = state.categories.filter((x) => x !== c);
    for (const t of state.transactions) if (t.category === c.id) t.category = null;
    for (const [k, v] of Object.entries(state.rules)) if (v === c.id) delete state.rules[k];
    commit();
  },
  async backup() {
    const blob = await store.backupBlob(state);
    const name = `finance-backup-${today()}.json`;
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  async wipe() {
    if (!confirm('Delete all accounts, transactions and settings from this phone? This can\'t be undone.')) return;
    await store.wipe();
    state = null;
    vaultExists = false;
    go('#/');
  },
};

// ---------- change handlers ----------

const changes = {
  'restore-file'(el) {
    const file = el.files[0];
    if (!file) return;
    file.text().then((text) => { restoreText = text; unlockError = ''; render(); });
  },
  async 'restore-into'(el) {
    const file = el.files[0];
    if (!file) return;
    const text = await file.text();
    const pass = prompt('Passcode of this backup');
    if (!pass) return;
    const s = await store.readBackup(text, pass).catch(() => undefined);
    if (s === undefined) return toast("That file isn't a backup from this app.");
    if (!s) return toast("That passcode doesn't open this backup.");
    if (!confirm('Replace everything in the app with this backup?')) return;
    state = { ...emptyState(), ...s };
    commit({ rerender: false });
    toast('Backup restored.');
    go('#/');
  },
  'scan-files'(el) {
    const files = [...el.files];
    if (files.length) startScan(files, el.dataset.account || null);
  },
  'draft-account'(el) {
    draft.account = el.value;
    applyAccountToDraft(draft);
    render();
  },
  'draft-kind'(el) {
    draft.newKind = el.value;
    applyAccountToDraft(draft);
    render();
  },
  'account-kind'(el) {
    el.form.querySelector('[data-wallet-only]')?.classList.toggle('hidden', el.value !== 'wallet');
  },
  'set-category'(el) {
    const t = state.transactions.find((x) => x.id === el.dataset.id);
    t.category = el.value || null;
    learn(state.rules, t.payee, t.category);
    commit({ rerender: false });
    toast(`Moved to ${catName(t.category)}.`);
  },
  'rename-category'(el) {
    const c = category(state, el.dataset.id);
    if (el.value.trim()) c.name = el.value.trim();
    commit({ rerender: false });
  },
  touch(el) {
    el.dataset.touched = '1';
  },
};

// Review screen fields update the draft without re-rendering, so typing isn't interrupted.
function updateDraftField(el) {
  const key = el.dataset.draft;
  if (key === 'balance') draft.balance = el.value.trim() ? parseTyped(el.value) : null;
  else draft[key] = el.value;
}

function updateDraftRow(el) {
  const rowEl = el.closest('[data-row]');
  const r = draft.rows[Number(rowEl.dataset.row)];
  const field = el.dataset.rowField;
  if (field === 'include' || field === 'paidFromBank') r[field] = el.checked;
  else if (field === 'amount') {
    r.amount = parseTyped(el.value) ?? 0;
    el.classList.toggle('pos', r.amount > 0);
    el.classList.toggle('neg', r.amount < 0);
  } else if (field === 'category') { r.category = el.value || null; r.categoryTouched = true; }
  else if (field === 'payee') {
    r.payee = el.value;
    if (!r.categoryTouched) {
      r.category = suggestCategory(r.payee, r.amount, state.rules, draftAccount(draft));
      const sel = rowEl.querySelector('[data-row-field=category]');
      if (sel) sel.value = r.category || '';
    }
  } else r[field] = el.value;
}

// ---------- events ----------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  actions[el.dataset.action]?.(el, e);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(new FormData(form), form);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change) changes[el.dataset.change]?.(el);
  if (el.dataset.rowField) updateDraftRow(el);
  if (el.dataset.draft) updateDraftField(el);
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.rowField && el.type !== 'checkbox') updateDraftRow(el);
  if (el.dataset.draft) updateDraftField(el);
  if (el.dataset.input === 'payee-suggest') {
    const sel = el.form.querySelector('[name=category]');
    if (sel.dataset.touched) return;
    const acc = accountById(el.form.querySelector('[name=accountId]').value);
    const out = el.form.querySelector('[name=dir]:checked')?.value === 'out';
    sel.value = suggestCategory(el.value, out ? -1 : 1, state.rules, acc) || '';
  }
});

window.addEventListener('hashchange', render);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    if (saveTimer) flush();
  } else if (state && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS && !scanning) {
    lockNow();
  }
});
window.addEventListener('pagehide', () => { if (saveTimer) flush(); });

async function boot() {
  vaultExists = await store.hasVault();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
