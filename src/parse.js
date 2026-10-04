// Turns the text read from a banking screenshot into a balance and a list of transactions.
// Everything here is a best guess: the person always reviews the result before it is saved.

import { iso, parseIso, addDays } from './format.js';

export const PROVIDERS = [
  { name: 'PayPal', re: /pay\s?pal/i, kind: 'wallet' },
  { name: 'Trade Republic', re: /trade\s?republic/i, kind: 'broker' },
  { name: 'Binance', re: /binance/i, kind: 'crypto' },
  { name: 'Kraken', re: /kraken/i, kind: 'crypto' },
  { name: 'Coinbase', re: /coinbase/i, kind: 'crypto' },
  { name: 'Bitpanda', re: /bitpanda/i, kind: 'crypto' },
  { name: 'Scalable Capital', re: /scalable/i, kind: 'broker' },
  { name: 'Revolut', re: /revolut/i, kind: 'bank' },
  { name: 'N26', re: /\bn26\b/i, kind: 'bank' },
  { name: 'Sparkasse', re: /sparkasse/i, kind: 'bank' },
  { name: 'Volksbank', re: /volksbank|raiffeisen/i, kind: 'bank' },
  { name: 'DKB', re: /\bdkb\b/i, kind: 'bank' },
  { name: 'ING', re: /\bING\b|ing-diba/, kind: 'bank' },
  { name: 'Comdirect', re: /comdirect/i, kind: 'bank' },
  { name: 'Commerzbank', re: /commerzbank/i, kind: 'bank' },
  { name: 'Deutsche Bank', re: /deutsche\s?bank/i, kind: 'bank' },
  { name: 'Postbank', re: /postbank/i, kind: 'bank' },
  { name: 'C24', re: /\bc24\b/i, kind: 'bank' },
  { name: 'Wise', re: /\bwise\b/i, kind: 'bank' },
];

const BALANCE_WORDS = /(kontostand|saldo|guthaben|verf[uü]gbar|gesamtwert|gesamtverm|verm[oö]gen|portfolio|depotwert|depot|balance|available|total|gesamt|net\s?worth|estimated|equity|wert)/i;
const INCOMING_WORDS = /(gutschrift|eingang|erhalten|received|refund|erstattung|r[uü]ckzahlung|gehalt|lohn|salary|deposit|einzahlung|zinsen|interest|dividend|cashback|received from|money from)/i;
const NOISE_WORDS = /(limit|kreditrahmen|dispo|p\.\s?a\.|rendite|performance|%)/i;

const MONTHS = {
  jan: 1, januar: 1, january: 1, jän: 1,
  feb: 2, februar: 2, february: 2,
  mar: 3, mär: 3, mrz: 3, märz: 3, march: 3, maerz: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function makeDate(y, m, d, ref) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const refDate = parseIso(ref);
  let year = y ?? refDate.getFullYear();
  if (year < 100) year += 2000;
  const dt = new Date(year, m - 1, d);
  if (dt.getMonth() !== m - 1) return null;
  // A date without a year that lands in the future belongs to last year.
  if (y == null && iso(dt) > addDays(ref, 1)) dt.setFullYear(year - 1);
  return iso(dt);
}

// Finds a date in a line. Returns { date, start, end } or null.
export function findDate(line, ref) {
  let m;
  if ((m = /\b(heute|today)\b/i.exec(line))) return { date: ref, start: m.index, end: m.index + m[0].length };
  if ((m = /\b(gestern|yesterday)\b/i.exec(line))) return { date: addDays(ref, -1), start: m.index, end: m.index + m[0].length };
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(line))) {
    const date = makeDate(+m[1], +m[2], +m[3], ref);
    if (date) return { date, start: m.index, end: m.index + m[0].length };
  }
  // 04.10.2026, 04.10.26, 04.10. (a trailing dot is required without a year, so 12.05 stays an amount)
  if ((m = /(?<![\d,.])(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2})(?!\d)|\.(?!\d))/.exec(line))) {
    const date = makeDate(m[3] ? +m[3] : null, +m[2], +m[1], ref);
    if (date) return { date, start: m.index, end: m.index + m[0].length };
  }
  // 4. Oktober 2026, 4 Oct
  const dm = new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?(?![\\p{L}])`, 'iu');
  if ((m = dm.exec(line))) {
    const date = makeDate(m[3] ? +m[3] : null, MONTHS[m[2].toLowerCase()], +m[1], ref);
    if (date) return { date, start: m.index, end: m.index + m[0].length };
  }
  // Oct 4, 2026
  const md = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?(?!\\d|[.,]\\d)`, 'iu');
  if ((m = md.exec(line))) {
    const date = makeDate(m[3] ? +m[3] : null, MONTHS[m[1].toLowerCase()], +m[2], ref);
    if (date) return { date, start: m.index, end: m.index + m[0].length };
  }
  return null;
}

// Converts the digits of an amount ("1.234,56", "1,234.56", "12,5", "1 234,56") to cents.
export function numberToCents(raw) {
  const s = raw.replace(/['’]/g, '').replace(/(\d)\s(?=\d{3}(?!\d))/g, '$1');
  if (/\s/.test(s)) return null;
  const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let whole = s, frac = '';
  if (last >= 0) {
    const tail = s.slice(last + 1);
    if (tail.length === 1 || tail.length === 2) {
      whole = s.slice(0, last);
      frac = tail;
    } else if (tail.length !== 3) {
      return null;
    }
  }
  if (whole && !/^\d{1,3}([.,]\d{3})*$|^\d+$/.test(whole)) return null;
  const sep = whole.match(/[.,]/g);
  if (sep && new Set(sep).size > 1) return null;
  if (sep && frac && sep[0] === s[last]) return null;
  const digits = whole.replace(/[.,]/g, '') || '0';
  return { cents: Number(digits) * 100 + Number(frac.padEnd(2, '0') || 0), decimals: frac.length };
}

const AMOUNT_RE = /([+\-−–]\s?)?(€|EUR)?\s?([+\-−–]\s?)?(\d[\d.,'’]*(?:\s\d{3})*(?:[.,]\d{1,2})?)\s?(€|EUR|[A-Za-z]{3,5}\b|%)?/g;

// Finds euro amounts in a line. Returns [{ cents, signed, start, end }].
export function findAmounts(line) {
  const out = [];
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(line))) {
    const [all, sign1, cur1, sign2, num, cur2] = m;
    if (!num) continue;
    const start = m.index + (all.length - all.trimStart().length);
    const before = line[start - 1];
    if (before && /[\p{L}\d:]/u.test(before)) continue;
    const after = line.slice(m.index + all.length);
    if (/^\s?[:/]\d/.test(after)) continue;
    const euro = cur1 || (cur2 && /^(€|EUR)$/i.test(cur2));
    if (cur2 && !euro) continue; // %, BTC, USD, shares...
    const parsed = numberToCents(num.trim());
    if (!parsed) continue;
    if (!euro && parsed.decimals !== 2) continue;
    const sign = (sign1 || sign2 || '').trim();
    const cents = /[-−–]/.test(sign) ? -parsed.cents : parsed.cents;
    out.push({ cents, signed: Boolean(sign), start, end: m.index + all.length });
  }
  return out;
}

function cleanPayee(text) {
  return text
    .replace(/[|•·©®™>_=*~«»]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.:;\-–]+|[\s,.:;\-–]+$/g, '')
    .trim();
}

function letters(s) {
  return (s.match(/\p{L}/gu) || []).length;
}

// The reader finds text pieces one by one; a payee on the left and its amount on the right
// belong to the same row when they sit at the same height.
export function mergeRows(pieces) {
  const sorted = pieces.filter((p) => p.text).sort((a, b) => a.top - b.top);
  const rows = [];
  for (const p of sorted) {
    const mid = (p.top + p.bottom) / 2;
    const row = rows.find((r) => mid > r.top && mid < r.bottom && Math.abs((r.top + r.bottom) / 2 - mid) < (r.bottom - r.top) * 0.5);
    if (row) {
      row.pieces.push(p);
      row.top = Math.min(row.top, p.top);
      row.bottom = Math.max(row.bottom, p.bottom);
    } else {
      rows.push({ top: p.top, bottom: p.bottom, pieces: [p] });
    }
  }
  return rows.map((r) => ({
    text: r.pieces.sort((a, b) => a.left - b.left).map((p) => p.text).join('  '),
    height: Math.max(...r.pieces.map((p) => p.bottom - p.top)),
  }));
}

// The provider named first on the screen (usually in the header), not one mentioned in a transaction.
export function detectProvider(text) {
  let best = null, at = Infinity;
  for (const p of PROVIDERS) {
    const m = p.re.exec(text);
    if (m && m.index < at) { best = p; at = m.index; }
  }
  return best;
}

// lines: [{ text, height }] in reading order. ref: ISO date of "today".
export function parseScreenshot(lines, ref) {
  const rows = lines
    .map((l) => ({ text: String(l.text || '').replace(/\s+/g, ' ').trim(), height: l.height || 0 }))
    .filter((l) => l.text);
  const fullText = rows.map((r) => r.text).join('\n');
  const provider = detectProvider(fullText);

  // Work out every row's date, amounts and remaining text.
  for (const r of rows) {
    const d = findDate(r.text, ref);
    r.date = d?.date ?? null;
    let rest = d ? r.text.slice(0, d.start) + ' ' + r.text.slice(d.end) : r.text;
    r.amounts = findAmounts(rest);
    for (const a of [...r.amounts].reverse()) rest = rest.slice(0, a.start) + ' ' + rest.slice(a.end);
    r.rest = cleanPayee(rest.replace(/\d{1,2}:\d{2}/g, ' '));
  }

  // Balance: an amount on or right after a line with a balance word, else the tallest amount.
  let balanceRow = null;
  for (let i = 0; i < rows.length && !balanceRow; i++) {
    if (!BALANCE_WORDS.test(rows[i].text) || NOISE_WORDS.test(rows[i].text)) continue;
    for (let j = i; j <= Math.min(i + 2, rows.length - 1); j++) {
      const r = rows[j];
      if (r.amounts.length && (j === i || letters(r.rest) <= 3)) { balanceRow = r; break; }
    }
  }
  if (!balanceRow) {
    const heights = rows.map((r) => r.height).filter(Boolean).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)] || 0;
    const tallest = rows.filter((r) => r.amounts.length && letters(r.rest) <= 3).sort((a, b) => b.height - a.height)[0];
    if (tallest && median && tallest.height >= median * 1.6) balanceRow = tallest;
  }
  const balance = balanceRow ? Math.abs(balanceRow.amounts[balanceRow.amounts.length - 1].cents) : null;

  // Transactions: rows with one amount and a payee on the row or just above it.
  // Some apps put a date heading above a group of transactions, others a date caption below each one.
  const isDateOnly = (r) => !r.amounts.length && r.date && letters(r.rest) <= 12;
  const firstDate = rows.findIndex(isDateOnly);
  const firstAmount = rows.findIndex((r) => r !== balanceRow && r.amounts.length);
  const captionsBelow = firstDate > firstAmount && firstAmount >= 0;
  const transactions = [];
  let currentDate = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r === balanceRow) continue;
    if (!r.amounts.length) {
      if (isDateOnly(r)) currentDate = r.date;
      continue;
    }
    if (NOISE_WORDS.test(r.text)) continue;
    let payee = r.rest;
    if (letters(payee) < 2) {
      const prev = rows[i - 1];
      if (prev && !prev.amounts.length && prev !== balanceRow && letters(prev.rest) >= 2 && !BALANCE_WORDS.test(prev.text)) payee = prev.rest;
      else continue;
    }
    const next = rows[i + 1];
    const date = r.date || (captionsBelow ? (next && isDateOnly(next) ? next.date : null) : currentDate);
    const a = r.amounts[r.amounts.length - 1];
    let amount = a.cents;
    if (!a.signed) amount = INCOMING_WORDS.test(r.text) ? Math.abs(amount) : -Math.abs(amount);
    transactions.push({ payee, amount, date: date || ref, dateGuessed: !date, signGuessed: !a.signed });
  }

  return { provider, balance, transactions, text: fullText };
}
