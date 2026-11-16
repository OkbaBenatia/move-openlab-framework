// Participant authoring: the logic of the Randomize dialog and of the participant editor that needs no interface —
// ratio and counts, vehicle-type shares, early refusals, identifiers, capacity variants and the undo stack. Run with
// `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allTo, clipBox, driversForRatio, groupOf, idError, innerBox, insideBox, nextId, popUndo, pushUndo, randomizeError, ratioOf, sharesError, sharesTotal, splitCounts, withCapacity,
  type RandomizeForm } from '../src/mobility/authoring.ts';

const ALL = { combustion: true, hybrid: true, electric: true };
const FORM: RandomizeForm = { drivers: 10, riders: 15, seed: 1, shares: { combustion: 60, hybrid: 0, electric: 40 }, capacity: 4, start: 7 * 3600, end: 9 * 3600,
  driverWindowMin: 15, riderWindowMin: 20, detourMin: 15, detourRatio: 0.5, minTripKm: 1.5 };

test('the driver-to-rider ratio follows the counts, and a typed ratio sets the drivers', () => {
  assert.equal(ratioOf(10, 15), 0.67);
  assert.equal(ratioOf(20, 20), 1);
  assert.equal(ratioOf(3, 0), 3);                          // never a division by zero
  assert.equal(driversForRatio(15, 0.67), 10);             // the round trip gives the counts back
  assert.equal(driversForRatio(30, 0.5), 15);
  assert.equal(driversForRatio(30, 2), 60);
  assert.equal(driversForRatio(80, 2), 100);               // clamped to the largest scenario
  assert.equal(driversForRatio(10, 0.01), 1);              // at least one driver
  assert.equal(driversForRatio(10, 0), null);              // not a ratio: the counts stay
  assert.equal(driversForRatio(10, Number.NaN), null);
  assert.equal(driversForRatio(10, -1), null);
});

test('vehicle shares must add up to 100 % over the types that have a profile', () => {
  assert.equal(sharesTotal({ combustion: 60, hybrid: 0, electric: 40 }), 100);
  assert.equal(sharesTotal({ combustion: 33.3, hybrid: 33.3, electric: 33.4 }), 100);
  assert.equal(sharesError({ combustion: 60, hybrid: 0, electric: 40 }, ALL), null);
  assert.deepEqual(sharesError({ combustion: 60, hybrid: 0, electric: 30 }, ALL), { text: 'The vehicle shares add up to {n} %, not 100 %.', vars: { n: 90 } });
  assert.equal(sharesError({ combustion: 120, hybrid: 0, electric: -20 }, ALL)?.text, 'Each vehicle share is a percentage between 0 and 100.');
  assert.equal(sharesError({ combustion: Number.NaN, hybrid: 0, electric: 100 }, ALL)?.text, 'Each vehicle share is a percentage between 0 and 100.');
  assert.equal(sharesError({ combustion: 50, hybrid: 50, electric: 0 }, { ...ALL, hybrid: false })?.text, 'No hybrid vehicle is available: set its share to 0 % or add one with Manage.');
  assert.equal(sharesError({ combustion: 100, hybrid: 0, electric: 0 }, { combustion: true, hybrid: false, electric: false }), null);
  assert.deepEqual(allTo('electric'), { combustion: 0, hybrid: 0, electric: 100 });
});

test('drivers are split by shares with the largest remainder, as the server does', () => {
  assert.deepEqual(splitCounts(10, [60, 10, 30]), [6, 1, 3]);
  assert.deepEqual(splitCounts(10, [60, 0, 40]), [6, 0, 4]);
  assert.deepEqual(splitCounts(3, [50, 50]), [2, 1]);      // a tie goes to the earlier share
  assert.deepEqual(splitCounts(7, [100, 0, 0]), [7, 0, 0]);
  assert.equal(splitCounts(9, [33.4, 33.3, 33.3]).reduce((a, b) => a + b, 0), 9);
  assert.deepEqual(splitCounts(1, [34, 33, 33]), [1, 0, 0]);
  assert.deepEqual(splitCounts(5, [0, 0, 0]), [0, 0, 0]);
});

test('powertrains fall into the three vehicle types', () => {
  assert.equal(groupOf('ICE'), 'combustion');
  assert.equal(groupOf('custom'), 'combustion');
  assert.equal(groupOf('HEV'), 'hybrid');
  assert.equal(groupOf('PHEV'), 'hybrid');
  assert.equal(groupOf('BEV'), 'electric');
  assert.equal(groupOf(undefined), 'combustion');
});

test('the Randomize dialog says what to change before asking the server', () => {
  assert.equal(randomizeError(FORM, ALL, true), null);
  const text = (change: Partial<RandomizeForm>, fleet = true) => randomizeError({ ...FORM, ...change }, ALL, fleet)?.text;
  assert.equal(text({ drivers: 0 }), 'Drivers and riders are whole numbers between 1 and 100.');
  assert.equal(text({ riders: 101 }), 'Drivers and riders are whole numbers between 1 and 100.');
  assert.equal(text({ shares: { combustion: 50, hybrid: 0, electric: 40 } }), 'The vehicle shares add up to {n} %, not 100 %.');
  assert.equal(text({ capacity: 0 }), 'The vehicle capacity must be at least 1 seat.');
  assert.equal(text({ capacity: 2.5 }), 'The vehicle capacity must be at least 1 seat.');
  assert.equal(text({ capacity: 61 }), 'The vehicle capacity is at most 60 seats.');
  assert.equal(text({ capacity: 0, shares: { combustion: 1, hybrid: 0, electric: 0 } }, false), undefined);    // no fleet: vehicles are not checked
  assert.equal(text({ start: Number.NaN }), 'Times are written HH:MM, for example 07:30.');
  assert.equal(text({ start: 9 * 3600, end: 7 * 3600 }), 'The departure interval ends before it starts.');
  assert.equal(text({ start: 8 * 3600, end: 8 * 3600 }), undefined);                                   // one departure time
  assert.equal(text({ riderWindowMin: -1 }), 'A time window lasts between 0 and 240 minutes.');
  assert.equal(text({ driverWindowMin: 241 }), 'A time window lasts between 0 and 240 minutes.');
  assert.equal(text({ detourMin: 121 }), 'The maximum detour is between 0 and 120 minutes.');
  assert.equal(text({ detourRatio: 6 }), 'The maximum detour ratio is between 0 and 5.');
  assert.equal(text({ minTripKm: 0.1 }), 'The minimum trip length is between 0.2 and 50 km.');
  assert.equal(text({ seed: 1.5 }), 'The seed is a whole number between 0 and 1000000.');
});

test('a generation rectangle starts inside the area and never leaves it', () => {
  const area: [number, number, number, number] = [10, 20, 10.08, 20.08];
  assert.deepEqual(innerBox(area), [10.02, 20.02, 10.06, 20.06]);
  assert.deepEqual(clipBox([9.9, 19.9, 10.05, 20.2], area), [10, 20, 10.05, 20.08]);
  assert.ok(insideBox(10.04, 20.04, area));
  assert.ok(!insideBox(10.09, 20.04, area));
});

test('identifiers are numbered after the highest in use and checked', () => {
  assert.equal(nextId('D', []), 'D1');
  assert.equal(nextId('D', ['D1', 'D2', 'R7']), 'D3');
  assert.equal(nextId('R', ['D21', 'R3', 'R30']), 'R31');
  assert.equal(nextId('D', ['D1', 'D5', 'Dx']), 'D6');     // a hole is not reused, a name without a number is ignored
  assert.equal(idError('D1', ['D2', 'R1']), null);
  assert.equal(idError('bus_7-b', []), null);
  assert.equal(idError('1D', [])?.text, 'An identifier starts with a letter, then letters, digits, - or _ (at most 32 characters).');
  assert.equal(idError('', [])?.text, 'An identifier starts with a letter, then letters, digits, - or _ (at most 32 characters).');
  assert.equal(idError('D 1', [])?.text, 'An identifier starts with a letter, then letters, digits, - or _ (at most 32 characters).');
  assert.deepEqual(idError('D2', ['D2', 'R1']), { text: 'Another participant already has the identifier {id}.', vars: { id: 'D2' } });
});

test('another capacity is another vehicle profile that names its source', () => {
  const petrol = { id: 'petrol-car', name: 'Petrol car', passenger_capacity: 4, powertrain: 'ICE', provenance: { kind: 'preset' }, version: 3, updated_at: 'x' };
  assert.equal(withCapacity(petrol, 4), petrol);           // the same capacity: the same profile
  const two = withCapacity(petrol, 2);
  assert.equal(two.id, 'petrol-car-2p');
  assert.equal(two.name, 'Petrol car · 2 seats');
  assert.equal(two.passenger_capacity, 2);
  assert.equal(two.powertrain, 'ICE');                     // everything else is kept
  assert.deepEqual(two.provenance, { kind: 'researcher', derived_from: 'petrol-car', change: 'passenger_capacity' });
  assert.ok(!('version' in two) && !('updated_at' in two));
  assert.equal(petrol.passenger_capacity, 4);              // the source profile is not changed
  const six = withCapacity(two, 6);                        // a variant of a variant keeps the original source
  assert.equal(six.id, 'petrol-car-6p');
  assert.equal(six.name, 'Petrol car · 6 seats');
  assert.equal(withCapacity(petrol, 3, 'Voiture essence', '{n} places').name, 'Voiture essence · 3 places');
  assert.ok(withCapacity({ ...petrol, id: 'x'.repeat(40) }, 12).id.length <= 40);
});

test('undo restores the states in reverse order and keeps a bounded history', () => {
  let stack: number[] = [];
  for (const s of [1, 2, 3]) stack = pushUndo(stack, s);
  assert.deepEqual(stack, [1, 2, 3]);
  let r = popUndo(stack);
  assert.equal(r.state, 3);
  r = popUndo(r.stack);
  assert.equal(r.state, 2);
  r = popUndo(r.stack);
  assert.equal(r.state, 1);
  r = popUndo(r.stack);
  assert.equal(r.state, null);                             // nothing left to undo
  assert.deepEqual(r.stack, []);
  let long: number[] = [];
  for (let i = 0; i < 60; i++) long = pushUndo(long, i, 50);
  assert.equal(long.length, 50);
  assert.equal(long[0], 10);                               // the oldest states are dropped
  const before = [1, 2];
  pushUndo(before, 3);
  assert.deepEqual(before, [1, 2]);                        // the stack is never changed in place
});
