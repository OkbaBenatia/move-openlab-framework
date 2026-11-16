// Regression tests for the comparison values: scenarios are matched by frozen instance, never by position, and a total
// over another scenario set is never put beside the reference's. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapLabel, hasCap, participantsOf, ridersOf, sameScenarios, sampleHash, servedLabel, servedOf, totalsComparable } from '../src/lab/scenarioMatch.ts';

test('a reference is called exact only when it is proven optimal in every scenario', () => {
  const proven = { method_id: 'ref', kind: 'exact', proven_optimal: 3, scenarios: 3 };
  const limited = { method_id: 'ref', kind: 'exact', proven_optimal: 61, scenarios: 78 };
  const hybrid = { method_id: 'h', kind: 'hybrid', proven_optimal: 0, scenarios: 78 };
  assert.equal(gapLabel([proven, hybrid]), 'Gap to the exact reference');
  assert.equal(gapLabel([limited, hybrid], 'ref'), 'Objective difference vs reference (reference proven optimal 61/78)');
  assert.equal(gapLabel([hybrid]), 'Gap to the exact reference');            // no reference row: unchanged wording
});

test('the served denominator is the problem\'s own when declared, else the riders', () => {
  const own = { scenarios: [{ instance_hash: 'h1', riders: 4, served_of: 11 }, { instance_hash: 'h2', riders: 3, served_of: 9 }] };
  const ride = { scenarios: [{ instance_hash: 'h1', riders: 4 }, { instance_hash: 'h2', riders: 3 }] };
  assert.equal(ridersOf(own, 0), 11);
  assert.equal(ridersOf(own, 'all'), 20);
  assert.equal(ridersOf(ride, 'all'), 7);                  // ride matching unchanged
  assert.equal(servedOf(own, 1), 9);
  assert.equal(servedOf(ride, 'all'), 7);
  assert.equal(servedOf(null, 'all'), null);
});

test('map, playback and served wording come from the problem\'s presentation', () => {
  const ride = { problem: { presentation: { capabilities: ['map', 'playback'], participants: 'riders', served_label: 'Served riders' } } };
  const other = { problem: { presentation: { capabilities: [], participants: 'requests', served_label: 'Served requests' } } };
  assert.ok(hasCap(ride, 'map') && hasCap(ride, 'playback'));
  assert.ok(!hasCap(other, 'map') && !hasCap(null, 'map'));
  assert.equal(servedLabel(other), 'Served requests');
  assert.equal(participantsOf(other), 'requests');
  assert.equal(servedLabel({ problem: {} }), 'Served riders');   // no presentation: the ride-matching wording
});

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
