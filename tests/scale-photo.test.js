import test from 'node:test';
import assert from 'node:assert/strict';
import { readScalePixels } from '../scale-photo.js';

import { scaleFixture } from './scale-photo-fixture.js';

test('reads pounds and tenths of ounces, including narrow ones and every digit', () => {
  for (const [pounds, ounces] of [['12','6.2'], ['7','0.1'], ['23','14.5'], ['8','9.3'], ['10','7.8'], ['4','2.4']]) {
    assert.deepEqual(readScalePixels(scaleFixture(pounds, ounces)), { pounds: Number(pounds), ounces: Number(ounces) });
  }
});
test('rejects absent separators, unsupported colors and out-of-range ounces', () => {
  assert.throws(() => readScalePixels(scaleFixture('12', '6.2', { colon: false })));
  assert.throws(() => readScalePixels(scaleFixture('12', '6.2', { color: [120,120,120] })));
  assert.throws(() => readScalePixels(scaleFixture('12', '16.2')));
  assert.throws(() => readScalePixels(scaleFixture('0', '0.0')));
});
