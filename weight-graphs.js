import { escHtml } from './html-utils.js';

export function graphDailyTrend(points) {
  const days = new Map();
  for (const point of points) {
    const d = new Date(point.ts);
    const day = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(point);
  }
  const daily = [...days].sort((a, b) => a[0] - b[0]).map(([day, values]) => ({
    day, ts: values.reduce((sum, p) => sum + p.ts, 0) / values.length,
    value: values.reduce((sum, p) => sum + p.value, 0) / values.length,
  }));
  return daily.map((point, i) => {
    const window = daily.slice(0, i + 1).filter(p => p.day > point.day - 7 * 86400000);
    return { ts: point.ts, value: window.reduce((sum, p) => sum + p.value, 0) / window.length };
  });
}

export function graphYAxis(min, max) {
  const rawStep = (max - min) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].find(n => n * magnitude >= rawStep) * magnitude;
  const first = Math.floor(min / step) * step;
  const last = Math.ceil(max / step) * step;
  // Remove floating-point noise and unnecessary trailing decimal places.
  const ticks = Array.from({ length: Math.round((last - first) / step) + 1 },
    (_, i) => Number((first + i * step).toPrecision(12)));
  return { min: ticks[0], max: ticks.at(-1), ticks };
}

export function weightGraph(title, unit, points, references = []) {
  const trend = graphDailyTrend(points);
  const all = [...points, ...trend, ...references.flatMap(r => r.points)];
  let xMin = Math.min(...all.map(p => p.ts)), xMax = Math.max(...all.map(p => p.ts));
  if (xMin === xMax) { xMin -= 43200000; xMax += 43200000; }
  let yMin = Math.min(...all.map(p => p.value));
  let yMax = Math.max(...all.map(p => p.value));
  const pad = Math.max((yMax - yMin) * .12, .05);
  yMin -= pad; yMax += pad;
  const axis = graphYAxis(yMin, yMax);
  yMin = axis.min; yMax = axis.max;
  const x = ts => 58 + (ts - xMin) / (xMax - xMin) * 500;
  const y = value => 230 - (value - yMin) / (yMax - yMin) * 198;
  const date = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  const path = (values, breakGaps = false) => values.map((p, i) =>
    `${!i || (breakGaps && p.ts - values[i - 1].ts > 7 * 86400000) ? 'M' : 'L'}${x(p.ts).toFixed(2)},${y(p.value).toFixed(2)}`).join(' ');
  let svg = `<svg viewBox="0 0 680 280" role="img" aria-label="${escHtml(title)}"><title>${escHtml(title)} (${escHtml(unit)})</title>`;
  for (const v of axis.ticks) {
    svg += `<path d="M58,${y(v)}H558" stroke="#e0e8e5"/><text class="y-axis-label y-axis-left" x="50" y="${y(v) + 4}" text-anchor="end">${v}</text><text class="y-axis-label y-axis-right" x="625" y="${y(v) + 4}">${v}</text>`;
  }
  // Reserve x=565–610 for WHO curve labels, separate from the right axis.
  svg += `<text x="58" y="18">${escHtml(unit)}</text><text x="625" y="18">${escHtml(unit)}</text>`;
  for (let i = 0; i <= 2; i++) {
    const ts = xMin + (xMax - xMin) * i / 2;
    svg += `<text x="${x(ts)}" y="254" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${escHtml(date(ts))}</text>`;
  }
  for (const ref of references) {
    const last = ref.points.at(-1);
    svg += `<path d="${path(ref.points)}" fill="none" stroke="#9aa9a3" stroke-dasharray="${ref.label === '50th' ? 'none' : '4 4'}"/><text class="curve-label" x="565" y="${y(last.value) + 4}">${ref.label}</text>`;
  }
  for (const p of points) svg += `<circle cx="${x(p.ts)}" cy="${y(p.value)}" r="3" fill="#718d86" opacity=".6"><title>${escHtml(new Date(p.ts).toLocaleString())}: ${p.value.toFixed(2)} ${escHtml(unit)}</title></circle>`;
  svg += `<path d="${path(trend, true)}" fill="none" stroke="#16796c" stroke-width="3" stroke-linejoin="round"/>`;
  for (const p of trend) svg += `<circle cx="${x(p.ts)}" cy="${y(p.value)}" r="3" fill="#16796c"><title>7-day average: ${p.value.toFixed(2)} ${escHtml(unit)}</title></circle>`;
  return `<section class="growth-chart"><h3>${escHtml(title)}</h3><div class="chart-scroll">${svg}</svg></div><p class="chart-key">● Individual readings · Teal: 7-day average${references.length ? ' · Gray: WHO percentiles' : ''}</p></section>`;
}
