// Regression tests for the comparison selection: run with `npm test` (node --test, TypeScript types stripped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCompare, fromRoute, initialSelection, letter, ordered, setReference, toggle, toRoute } from '../src/lab/compareSelection.ts';

test('the current experiment is ticked and is the reference; nothing else is added', () => {
  const s = initialSelection('A');
  assert.deepEqual(s, { ids: ['A'], reference: 'A' });
  assert.equal(canCompare(s), false);
});

test('two selected experiments give exactly two columns', () => {
  const s = toggle(initialSelection('A'), 'B');
  assert.deepEqual(ordered(s), ['A', 'B']);
  assert.equal(toRoute(s), 'A|B');
  assert.deepEqual(fromRoute(toRoute(s)).ids, ['A', 'B']);
});

test('three selected experiments give exactly three columns A, B, C', () => {
  const s = toggle(toggle(initialSelection('A'), 'B'), 'C');
  assert.deepEqual(ordered(s), ['A', 'B', 'C']);
  assert.deepEqual(ordered(s).map((_, i) => letter(i)), ['A', 'B', 'C']);
  assert.equal(toRoute(s), 'A|B,C');
});

test('more than three, and unticking the current experiment, keep exactly the ticked set', () => {
  let s = initialSelection('A');
  for (const x of ['B', 'C', 'D', 'E']) s = toggle(s, x);
  assert.equal(ordered(s).length, 5);
  s = toggle(s, 'A');                                   // the current experiment can be unticked
  assert.deepEqual(ordered(s), ['B', 'C', 'D', 'E']);
  assert.equal(s.reference, 'B');                       // the reference passes to the first remaining one
  s = toggle(toggle(toggle(s, 'C'), 'D'), 'E');
  assert.deepEqual(ordered(s), ['B']);
  assert.equal(canCompare(s), false);
});

test('the reference can be changed explicitly and leads the columns', () => {
  const s = setReference(toggle(toggle(initialSelection('A'), 'B'), 'C'), 'C');
  assert.deepEqual(ordered(s), ['C', 'A', 'B']);
  assert.equal(toRoute(s), 'C|A,B');
  assert.deepEqual(setReference(s, 'Z'), s);           // an unticked experiment cannot be the reference
});

test('routes never grow: duplicates and empty parts are dropped', () => {
  assert.deepEqual(fromRoute('A|B,A,,B,C').ids, ['A', 'B', 'C']);
  assert.deepEqual(fromRoute('A|').ids, ['A']);
  assert.deepEqual(initialSelection('A', ['A', 'B']).ids, ['A', 'B']);
});

test('letters', () => {
  assert.deepEqual([0, 1, 2, 25, 26, 27].map(letter), ['A', 'B', 'C', 'Z', 'AA', 'AB']);
});
