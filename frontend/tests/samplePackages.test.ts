// The sample packages and scenario-package reports: what the verification list shows, and how the composition check is
// stated (rebuilt here and identical, or not rebuilt because the road network is not installed). Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositionState, isScenarioReport, parseSha256Sums, samplesOffered, scenarioChecks, shortSha, sizeLabel } from '../src/lab/samplePackages.ts';

const base = { kind: 'scenario', format: 'move-openlab-scenario/1', files_checked: 3, spec_match: true, executable_code_in_package: false,
  instance: { verified: true }, geometry: { included: true, verified: true, legs: 120 } };

test('a scenario package report is told apart from an experiment bundle report', () => {
  assert.equal(isScenarioReport(base), true);
  assert.equal(isScenarioReport({ format: 'move-openlab-bundle/2' }), false);
  assert.equal(isScenarioReport(null), false);
});

test('the composition is "rebuilt and identical" only when the server rebuilt it and found the same instance', () => {
  assert.equal(compositionState({ ...base, composition: { rebuilt: true, identical: true, network_installed: true } }), 'rebuilt-identical');
  assert.equal(compositionState({ ...base, composition: { rebuilt: false, identical: null, network_installed: false } }), 'network-missing');
  assert.equal(compositionState({ ...base, composition: null }), 'none');
});

test('the checks follow the import order; a missing road network is a stated limitation, not a pass', () => {
  const missing = scenarioChecks({ ...base, composition: { rebuilt: false, identical: null } });
  assert.deepEqual(missing.map((r) => r.id), ['archive', 'problem', 'instance', 'geometry', 'composition', 'code']);
  const comp = missing.find((r) => r.id === 'composition')!;
  assert.equal(comp.ok, false); assert.equal(comp.info, true);
  assert.equal(missing.find((r) => r.id === 'geometry')!.n, 120);
  const rebuilt = scenarioChecks({ ...base, composition: { rebuilt: true, identical: true } });
  assert.equal(rebuilt.find((r) => r.id === 'composition')!.ok, true);
  const noGeo = scenarioChecks({ ...base, geometry: { included: false, verified: false, legs: 0 }, composition: null });
  assert.deepEqual(noGeo.find((r) => r.id === 'geometry'), { id: 'geometry', ok: false, info: true });
  assert.equal(noGeo.some((r) => r.id === 'composition'), false);
});

test('checksum files, sizes and digests are read and shown as published', () => {
  const sums = parseSha256Sums(`${'a'.repeat(64)}  sample_experiment.zip\n${'b'.repeat(64)} *sample_scenario.zip\n\nnot a line\n`);
  assert.deepEqual(sums, { 'sample_experiment.zip': 'a'.repeat(64), 'sample_scenario.zip': 'b'.repeat(64) });
  assert.equal(sizeLabel(274781), '274.8 kB');
  assert.equal(sizeLabel(869357), '869.4 kB');
  assert.equal(sizeLabel(2_500_000), '2.50 MB');
  assert.equal(shortSha('0123456789abcdef'), '0123456789ab…');
  assert.equal(shortSha(null), '—');
});

test('each sample card is offered only when its package ships', () => {
  assert.deepEqual(samplesOffered({ sample: { available: true }, sample_scenario: { available: false } }), { scenario: false, experiment: true, any: true });
  assert.deepEqual(samplesOffered(null), { scenario: false, experiment: false, any: false });
});
