// Money is stored as integer cents everywhere. Dates are ISO strings (YYYY-MM-DD).

const locale = (typeof navigator !== 'undefined' && navigator.language) || 'de-DE';
const eur = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
const eurShort = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

export function money(cents, { sign = false, short = false } = {}) {
  const f = short ? eurShort : eur;
  const text = f.format(Math.abs(cents) / 100);
  if (cents < 0) return '− ' + text;
  if (sign && cents > 0) return '+ ' + text;
  return text;
}

export function percent(ratio) {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(ratio);
}

export function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function today() {
  return iso(new Date());
}

export function parseIso(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseIso(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function daysBetween(a, b) {
  return Math.round((parseIso(b) - parseIso(a)) / 86400000);
}

export function monthStart(s) {
  return s.slice(0, 8) + '01';
}

export function addMonths(s, n) {
  const d = parseIso(monthStart(s));
  d.setMonth(d.getMonth() + n);
  return iso(d);
}

export function monthEnd(s) {
  return addDays(addMonths(s, 1), -1);
}

export function monthLabel(s, style = 'long') {
  return new Intl.DateTimeFormat(locale, { month: style, year: style === 'long' ? 'numeric' : undefined }).format(parseIso(s));
}

export function dateLabel(s) {
  const t = today();
  if (s === t) return 'Today';
  if (s === addDays(t, -1)) return 'Yesterday';
  const sameYear = s.slice(0, 4) === t.slice(0, 4);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' }).format(parseIso(s));
}

export function ago(s) {
  const n = daysBetween(s, today());
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 30) return `${n} days ago`;
  const months = Math.round(n / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

// Parses what a person types into an amount field: "12,50", "-1.234,56", "€ 9.99".
export function parseTyped(text) {
  if (text == null) return null;
  let s = String(text).trim().replace(/[€\s]|EUR/gi, '').replace('−', '-');
  if (!s) return null;
  const neg = s.startsWith('-');
  s = s.replace(/^[+-]/, '');
  const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let whole = s, frac = '';
  if (last >= 0 && s.length - last - 1 <= 2) {
    whole = s.slice(0, last);
    frac = s.slice(last + 1);
  }
  whole = whole.replace(/[.,']/g, '');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac) || (whole + frac) === '') return null;
  const cents = Number(whole || '0') * 100 + Number(frac.padEnd(2, '0') || '0');
  return neg ? -cents : cents;
}

export function typedValue(cents) {
  return (cents / 100).toFixed(2).replace('.', locale.startsWith('en') ? '.' : ',');
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
