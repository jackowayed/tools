import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../baby-weight.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function matchesHistoryFilters('), html.indexOf('function historyEmptyMessage('));

test('day and night filters use local time and combine with existing filters', () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const context = vm.createContext({ Date,
      historyClothingEl: { value: 'all' }, historyFeedEl: { value: 'all' }, historyTimeEl: { value: 'all' },
    });
    vm.runInContext(source, context);
    const entries = [
      ['2026-10-25T03:59:59-07:00', true],
      ['2026-10-25T04:00:00-07:00', false],
      ['2026-10-25T16:59:59-07:00', false],
      ['2026-10-25T17:00:00-07:00', true],
      ['2026-10-26T00:00:00-07:00', true],
      ['2026-11-01T03:59:59-08:00', true],
      ['2026-11-01T04:00:00-08:00', false],
    ];
    for (const [time, night] of entries) {
      const entry = { ts: Date.parse(time), afterFeed: false, clothed: false };
      for (const filter of ['all', 'day', 'night']) {
        context.historyTimeEl.value = filter;
        assert.equal(context.matchesHistoryFilters(entry), filter === 'all' || night === (filter === 'night'), `${time}: ${filter}`);
      }
      context.historyFeedEl.value = 'after';
      assert.equal(context.matchesHistoryFilters(entry), false);
      context.historyFeedEl.value = 'all';
      context.historyClothingEl.value = 'clothed';
      assert.equal(context.matchesHistoryFilters(entry), false);
      context.historyClothingEl.value = 'all';
    }
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
