// Categories, and suggestions learned from how the person sorted earlier transactions.

// kind: expense counts as spending, income counts as money in, neutral counts as neither
// (moving money between your own accounts, buying investments, corrections).
export const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'Groceries', kind: 'expense', color: '#2F7D5B' },
  { id: 'eating-out', name: 'Eating out', kind: 'expense', color: '#C2410C' },
  { id: 'housing', name: 'Rent & housing', kind: 'expense', color: '#1D4ED8' },
  { id: 'utilities', name: 'Utilities & phone', kind: 'expense', color: '#0E7490' },
  { id: 'transport', name: 'Transport', kind: 'expense', color: '#7C3AED' },
  { id: 'shopping', name: 'Shopping', kind: 'expense', color: '#BE185D' },
  { id: 'subscriptions', name: 'Subscriptions', kind: 'expense', color: '#4338CA' },
  { id: 'health', name: 'Health & fitness', kind: 'expense', color: '#047857' },
  { id: 'entertainment', name: 'Entertainment', kind: 'expense', color: '#A16207' },
  { id: 'travel', name: 'Travel', kind: 'expense', color: '#0369A1' },
  { id: 'insurance', name: 'Insurance', kind: 'expense', color: '#475569' },
  { id: 'fees', name: 'Fees & charges', kind: 'expense', color: '#B91C1C' },
  { id: 'cash', name: 'Cash', kind: 'expense', color: '#57534E' },
  { id: 'other', name: 'Other', kind: 'expense', color: '#78716C' },
  { id: 'income', name: 'Income', kind: 'income', color: '#15803D' },
  { id: 'transfer', name: 'Own transfers', kind: 'neutral', color: '#64748B' },
  { id: 'investing', name: 'Investing', kind: 'neutral', color: '#0F766E' },
  { id: 'value-change', name: 'Value change', kind: 'neutral', color: '#0F766E' },
  { id: 'correction', name: 'Balance correction', kind: 'neutral', color: '#94A3B8' },
];

const KEYWORDS = {
  groceries: ['rewe', 'lidl', 'aldi', 'edeka', 'netto', 'penny', 'kaufland', 'rossmann', 'dm drogerie', 'dm-drogerie', 'tegut', 'globus', 'alnatura', 'denns', 'spar', 'billa', 'norma', 'hit markt', 'flink', 'getir', 'picnic', 'supermarkt', 'supermarket'],
  'eating-out': ['lieferando', 'wolt', 'uber eats', 'mcdonald', 'burger king', 'starbucks', 'restaurant', 'cafe', 'café', 'pizza', 'döner', 'doner', 'subway', 'kfc', 'vapiano', 'bäckerei', 'baeckerei', 'backerei', 'sushi', 'bar', 'deliveroo'],
  housing: ['miete', 'rent', 'hausverwaltung', 'wohnung', 'nebenkosten', 'ikea'],
  utilities: ['vodafone', 'telekom', 'o2', '1&1', 'stadtwerke', 'vattenfall', 'e on', 'eon', 'strom', 'rundfunk', 'congstar', 'aldi talk', 'internet'],
  transport: ['deutsche bahn', 'db vertrieb', 'db fernverkehr', 'bahn', 'bvg', 'mvg', 'hvv', 'rmv', 'vbb', 'kvb', 'uber', 'bolt', 'tier', 'lime', 'free now', 'freenow', 'shell', 'aral', 'esso', 'jet', 'tankstelle', 'flixbus', 'share now', 'sixt', 'miles', 'deutschlandticket', 'parken', 'parking'],
  shopping: ['amazon', 'zalando', 'otto', 'ebay', 'mediamarkt', 'media markt', 'saturn', 'h&m', 'zara', 'about you', 'decathlon', 'temu', 'shein', 'primark', 'tk maxx', 'apple store', 'douglas'],
  subscriptions: ['spotify', 'netflix', 'disney', 'apple com', 'itunes', 'google', 'prime', 'youtube', 'openai', 'chatgpt', 'anthropic', 'claude', 'icloud', 'dazn', 'audible', 'adobe', 'microsoft', 'patreon', 'abo'],
  health: ['apotheke', 'pharmacy', 'arzt', 'doctor', 'zahnarzt', 'fitness', 'mcfit', 'urban sports', 'gym', 'clever fit', 'physio'],
  entertainment: ['kino', 'cinema', 'steam', 'playstation', 'nintendo', 'xbox', 'eventim', 'ticket', 'konzert', 'theater', 'museum'],
  travel: ['airbnb', 'booking com', 'lufthansa', 'ryanair', 'eurowings', 'easyjet', 'condor', 'hotel', 'expedia', 'hostel'],
  insurance: ['versicherung', 'allianz', 'huk', 'ergo', 'insurance', 'axa', 'debeka', 'techniker', 'aok', 'barmer', 'dak'],
  fees: ['gebühr', 'gebuehr', 'entgelt', 'kontoführung', 'kontofuehrung', 'fee', 'charge', 'provision', 'zinsen soll'],
  cash: ['geldautomat', 'atm', 'bargeld', 'cash withdrawal', 'auszahlung automat'],
  income: ['gehalt', 'lohn', 'salary', 'payroll', 'bezüge', 'rente'],
  transfer: ['übertrag', 'uebertrag', 'umbuchung', 'eigene überweisung', 'transfer to', 'transfer from', 'top up', 'top-up', 'aufladung', 'deposit', 'withdrawal to bank', 'trade republic', 'paypal', 'binance', 'kraken', 'revolut'],
  investing: ['sparplan', 'savings plan', 'kauf', 'buy', 'verkauf', 'sell', 'etf', 'order'],
};

export function normalizePayee(payee) {
  return String(payee || '')
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/\b(gmbh|ag|se|kg|ek|ltd|inc|sagt danke|europe|s a r l|et cie|s c a|sarl|co)\b/g, ' ')
    .replace(/[^\p{L}\d&\s]/gu, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return new Set(s.split(' ').filter((t) => t.length > 1));
}

function similar(a, b) {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 3;
  const ta = tokens(a), tb = tokens(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.max(1, Math.min(ta.size, tb.size)) >= 0.5 && common > 0;
}

export function isPayPalPayee(payee) {
  return /pay\s?pal/i.test(payee || '');
}

// Returns a category id or null. `rules` maps a normalized payee to a category id.
export function suggestCategory(payee, amount, rules = {}, account = null) {
  const key = normalizePayee(payee);
  if (!key) return null;
  if (rules[key]) return rules[key];
  for (const [k, cat] of Object.entries(rules)) if (similar(key, k)) return cat;
  // Money moving to PayPal from a bank account is not spending; the purchase is counted in PayPal.
  if (account && account.kind === 'bank' && isPayPalPayee(payee)) return 'transfer';
  const padded = ` ${key} `;
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    if (cat === 'income' && amount < 0) continue;
    if (words.some((w) => padded.includes(` ${w} `) || (w.length >= 5 && key.includes(w)))) return cat;
  }
  if (amount > 0 && /gutschrift|eingang|received/i.test(payee)) return 'income';
  return null;
}

export function learn(rules, payee, categoryId) {
  const key = normalizePayee(payee);
  if (!key) return rules;
  if (categoryId) rules[key] = categoryId;
  else delete rules[key];
  return rules;
}
