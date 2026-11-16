// Regression test: the axis always reaches the largest value (a bar was once drawn above the top tick). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticks } from '../src/lab/chartScale.ts';

test('the top tick is at or above the largest value, the bottom at or below the smallest', () => {
  for (const [lo, hi] of [[0, 117.6], [0, 105 * 1.12], [0, 1], [0, 3.3], [-41.2, 12], [0, 999.9], [0, 0.0123], [-5, 0]] as [number, number][]) {
    const t = ticks(lo, hi);
    assert.ok(t[0] <= lo + 1e-9 && t[t.length - 1] >= hi - 1e-9, `${lo}..${hi} -> ${t}`);
    assert.ok(t.length >= 2 && t.length <= 12);
  }
});
