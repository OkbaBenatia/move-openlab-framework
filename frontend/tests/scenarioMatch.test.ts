// Regression tests for the comparison values: scenarios are matched by frozen instance, never by position, and a total
// over another scenario set is never put beside the reference's. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ridersOf, sameScenarios, sampleHash, totalsComparable } from '../src/lab/scenarioMatch.ts';

const exp = (hs: string[]) => ({ scenarios: hs.map((h, i) => ({ instance_hash: h, riders: 10 + i })) });

test('sample k is the reference\'s k-th scenario, found by instance hash in the other experiment', () => {
  const a = exp(['h1', 'h2', 'h3']), b = exp(['h3', 'h1']);              // another order, one scenario fewer
  assert.equal(sampleHash(0, a), 'h1');
  assert.equal(ridersOf(b, 0, a), 11);                                  // h1 is B's second scenario (11 riders)
  assert.equal(ridersOf(b, 1, a), null);                                // h2 is not in B: no value, not B's h1
  assert.equal(ridersOf(b, 2, a), 10);
});

test('totals are compared only over the same scenario set', () => {
  const a = exp(['h1', 'h2', 'h3']), sub = exp(['h1']), shuffled = exp(['h3', 'h1', 'h2']);
  assert.equal(totalsComparable(sub, a), false);
  assert.equal(ridersOf(sub, 'all', a), null);
  assert.ok(sameScenarios(shuffled, a) && totalsComparable(shuffled, a) && totalsComparable(a, a));
  assert.equal(ridersOf(shuffled, 'all', a), 33);
});

test('a controlled variant is matched to the scenarios it derives from', () => {
  const a = exp(['h1', 'h2', 'h3']);
  const v = { scenarios: [{ instance_hash: 'v2', riders: 11, derived_from: 'h2' }, { instance_hash: 'v1', riders: 10, derived_from: 'h1' }, { instance_hash: 'v3', riders: 12, derived_from: 'h3' }] };
  assert.equal(sampleHash(0, a, v), 'v1');                 // A's sample 1 (h1) is the variant's v1
  assert.equal(sampleHash(1, v, a), 'h1');                 // the other way round: the variant's 2nd scenario (v1) is A's h1
  assert.ok(sameScenarios(v, a) && totalsComparable(v, a));
  assert.equal(ridersOf(v, 'all', a), 33);
  assert.equal(sampleHash(0, a, exp(['x1'])), undefined);  // an unrelated scenario is never matched
});
