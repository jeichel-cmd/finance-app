// Small inline SVG charts. No library, so nothing extra to download.

import { money, monthLabel, esc } from './format.js';

export function lineChart(points, { height = 72, width = 350 } = {}) {
  if (points.length < 2) return '';
  const values = points.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const x = (i) => (i / (points.length - 1)) * width;
  const y = (v) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = `${d} L${width} ${height} L0 ${height} Z`;
  const up = values[values.length - 1] >= values[0];
  const label = `Balance over the last ${points.length} months, from ${money(values[0])} to ${money(values[values.length - 1])}`;
  return `<svg class="chart ${up ? 'up' : 'down'}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
    <path class="area" d="${area}"></path>
    <path class="line" d="${d}" vector-effect="non-scaling-stroke"></path>
  </svg>`;
}

export function barChart(months) {
  const max = Math.max(1, ...months.map((m) => m.spent));
  return `<div class="bars" role="img" aria-label="Spending per month">
    ${months.map((m, i) => `<div class="bar-col">
      <div class="bar-track"><div class="bar ${i === months.length - 1 ? 'current' : ''}" style="height:${Math.max(2, Math.round((Math.max(0, m.spent) / max) * 100))}%"></div></div>
      <div class="bar-label">${esc(monthLabel(m.month, 'short'))}</div>
    </div>`).join('')}
  </div>`;
}
