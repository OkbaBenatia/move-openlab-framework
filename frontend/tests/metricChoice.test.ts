// The state of "Choose metrics" (one selection for results, comparisons, charts and exports): run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenIds, defaultIds, isDefault, ordered, selectAll, selectNone, setGroup, toggleId, type Choosable } from '../src/lab/metricChoice.ts';

const DEFS: Choosable[] = [
  { id: 'validated', group: 'validation', byDefault: true },
  { id: 'served', group: 'optimization', byDefault: true, compact: true },
  { id: 'gap', group: 'optimization', byDefault: true, compact: true },
  { id: 'ml:f1', group: 'ml', byDefault: false },
  { id: 'runtime', group: 'performance', byDefault: true, compact: true },
  { id: 'co2', group: 'mobility', byDefault: true },
  { id: 'custom:x', group: 'custom', byDefault: true },
];

test('defaults: every default metric, or the compact set for a narrow table', () => {
  assert.deepEqual(defaultIds(DEFS), ['validated', 'served', 'gap', 'runtime', 'co2', 'custom:x']);
  assert.deepEqual(defaultIds(DEFS, true), ['served', 'gap', 'runtime']);
});

test('nothing saved, or a saved choice that names no available metric: the defaults', () => {
  assert.deepEqual([...chosenIds(DEFS, undefined)], defaultIds(DEFS));
  assert.deepEqual([...chosenIds(DEFS, [])], defaultIds(DEFS));
  assert.deepEqual([...chosenIds(DEFS, ['metric-of-another-problem'], true)], defaultIds(DEFS, true));
});

test('a saved choice is kept as it is, restricted to the metrics that exist here (the same in every view)', () => {
  const saved = ['co2', 'ml:f1', 'gone'];
  assert.deepEqual([...chosenIds(DEFS, saved)].sort(), ['co2', 'ml:f1']);
  assert.deepEqual([...chosenIds(DEFS, saved, true)].sort(), ['co2', 'ml:f1']);      // compact changes the defaults only
});

test('select individual metrics, select all, deselect all', () => {
  let sel = new Set(defaultIds(DEFS, true));
  sel = toggleId(sel, 'co2'); assert.equal(sel.has('co2'), true);
  sel = toggleId(sel, 'served'); assert.equal(sel.has('served'), false);
  assert.equal(selectAll(DEFS).size, DEFS.length);
  assert.equal(selectNone().size, 0);
});

test('a whole group is ticked or unticked without touching the others', () => {
  const sel = setGroup(new Set(['served']), DEFS, 'ml', true);
  assert.deepEqual([...sel].sort(), ['ml:f1', 'served']);
  assert.deepEqual([...setGroup(selectAll(DEFS), DEFS, 'optimization', false)].sort(), ['co2', 'custom:x', 'ml:f1', 'runtime', 'validated']);
});

test('the selection is saved in the order of the tables; the default selection needs no saved choice', () => {
  assert.deepEqual(ordered(DEFS, new Set(['runtime', 'validated', 'co2'])), ['validated', 'runtime', 'co2']);
  assert.equal(isDefault(DEFS, new Set(defaultIds(DEFS))), true);
  assert.equal(isDefault(DEFS, new Set(defaultIds(DEFS)), true), false);
  assert.equal(isDefault(DEFS, new Set(defaultIds(DEFS, true)), true), true);
  assert.equal(isDefault(DEFS, toggleId(new Set(defaultIds(DEFS)), 'ml:f1')), false);
});
