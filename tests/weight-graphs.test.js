import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../baby-weight.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function graphDailyTrend('), html.indexOf('function weightGraph('));
const context = vm.createContext({ Date, Map });
vm.runInContext(source, context);
test('rolling trend weights days equally and excludes days outside the seven-day window', () => {
  const ts = day => new Date(2026, 0, day, 12).getTime();
  const result = context.graphDailyTrend([
    { ts: ts(1), value: 2 }, { ts: ts(1), value: 4 },
    { ts: ts(2), value: 5 }, { ts: ts(8), value: 9 },
    { ts: ts(20), value: 12 },
  ]);
  assert.deepEqual(Array.from(result, p => p.value), [3, 4, 7, 12]);
});
test('empty and singleton trends remain usable', () => {
  assert.equal(context.graphDailyTrend([]).length, 0);
  assert.equal(context.graphDailyTrend([{ ts: 0, value: 3 }])[0].value, 3);
});
