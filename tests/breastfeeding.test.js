import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFeed, elapsed, switchSide, pause, validateFeed, formatDuration } from '../breastfeeding-timer.js';

test('switching and pausing allocate time to only the active side', () => {
  let feed = switchSide(emptyFeed(), 'left', 1000);
  feed = switchSide(feed, 'right', 6000);
  feed = pause(feed, 14000);
  assert.equal(feed.left, 5000);
  assert.equal(feed.right, 8000);
  assert.equal(feed.last, 'right');
  assert.equal(feed.start, 1000);
  assert.equal(feed.active, null);
  assert.deepEqual(elapsed(feed, 100000), feed);
  feed = switchSide(feed, 'left', 100000);
  feed = switchSide(feed, 'left', 102000);
  assert.equal(feed.left, 7000);
  assert.equal(feed.right, 8000);
  assert.equal(feed.last, 'left');
  assert.equal(feed.active, null);
});

test('serialized active timer recovers elapsed time after a long background interval', () => {
  const feed = switchSide(emptyFeed(), 'right', 1000);
  const restored = JSON.parse(JSON.stringify(feed));
  assert.equal(elapsed(restored, 3601000).right, 3600000);
  assert.equal(elapsed(restored, 3601000).right, 3600000); // Rendering never double-counts.
  assert.equal(restored.right, 0);
  assert.equal(elapsed(restored, 0).right, 0);
});

test('manual correction can continue timing and preserves start and opposite side', () => {
  const edited = { ...emptyFeed(), start: 1000, left: 60000, right: 30000, last: 'right' };
  const result = pause(switchSide(edited, 'left', 200000), 210000);
  assert.equal(result.left, 70000);
  assert.equal(result.right, 30000);
  assert.equal(result.start, 1000);
  assert.equal(validateFeed(result, 210000), result);
});

test('invalid and empty feeds cannot be saved', () => {
  assert.throws(() => validateFeed(emptyFeed(), 1000));
  const valid = { ...emptyFeed(), start: 1000, left: 1000, last: 'left' };
  for (const overrides of [{ start: 3000 }, { left: -1 }, { right: NaN }, { left: Infinity }, { left: 0 }, { last: 'right' }]) {
    assert.throws(() => validateFeed({ ...valid, ...overrides }, 2000));
  }
  assert.equal(formatDuration(3661000), '01:01:01');
});
