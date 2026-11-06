import test from 'node:test';
import assert from 'node:assert/strict';
import { graphDailyTrend, graphYAxis, weightGraph } from '../weight-graphs.js';

test('rolling trend weights days equally and excludes days outside the seven-day window', () => {
  const ts = day => new Date(2026, 0, day, 12).getTime();
  const result = graphDailyTrend([
    { ts: ts(1), value: 2 }, { ts: ts(1), value: 4 },
    { ts: ts(2), value: 5 }, { ts: ts(8), value: 9 },
    { ts: ts(20), value: 12 },
  ]);
  assert.deepEqual(result.map(p => p.value), [3, 4, 7, 12]);
});
test('empty and singleton trends remain usable', () => {
  assert.equal(graphDailyTrend([]).length, 0);
  assert.equal(graphDailyTrend([{ ts: 0, value: 3 }])[0].value, 3);
});

test('weight axes use round steps while enclosing the padded data range', () => {
  for (const [min, max, expected] of [
    [2.94, 3.16, [2.9, 3, 3.1, 3.2]],
    [6.37, 10.83, [6, 8, 10, 12]],
    [3.95, 4.05, [3.95, 4, 4.05]],
  ]) {
    const axis = graphYAxis(min, max);
    assert.deepEqual(axis.ticks, expected);
    assert.ok(axis.min <= min && axis.max >= max);
  }
});
test('percentile chart zooms to its data with round axis labels', () => {
  const chart = weightGraph('Percentile', '%ile', [
    { ts: 0, value: 42 }, { ts: 86400000, value: 48 },
  ]);
  const labels = [...chart.matchAll(/class="y-axis-label y-axis-left"[^>]*>([^<]+)</g)].map(match => Number(match[1]));
  assert.deepEqual(labels, [40, 42, 44, 46, 48, 50]);
});
