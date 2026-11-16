// ML evaluation view: the pure logic of the evidence import form, the threshold control and the curve. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadata, clamp, decisionLabel, emptyForm, fmtThreshold, formProblems, isCsvFile, isJsonFile, nearest, segments, sliderStep, type SweepPoint } from '../src/lab/mlEvidence.ts';

const filled = () => ({ ...emptyForm(), modelName: ' scorer ', modelVersion: '1.0.0', pipelineName: 'two features', pipelineVersion: '1', pipelineDescription: 'detour, pickup',
  datasetId: 'held-out', split: 'test', population: 'forty scenarios', unit: 'one pair', positiveLabel: 'used by the reference', threshold: '0,5' });

test('a CSV import names every missing provenance field and needs a numeric threshold', () => {
  assert.deepEqual(formProblems(emptyForm()), ['Model name', 'Model version', 'Feature pipeline name', 'Feature pipeline version', 'Feature pipeline description',
    'Dataset identifier', 'Split', 'Population', 'What one record is', 'Meaning of label 1', 'Threshold']);
  assert.deepEqual(formProblems(filled()), []);
  assert.deepEqual(formProblems({ ...filled(), threshold: 'high' }), ['Threshold']);
  assert.deepEqual(formProblems({ ...filled(), threshold: '', rule: 'predictions' }), []);       // hard predictions: no threshold
  assert.deepEqual(formProblems({ ...filled(), split: '   ' }), ['Split']);
  assert.deepEqual(formProblems({ ...filled(), modelSha: 'abc' }), ['Model SHA-256 (64 hexadecimal characters)']);
  assert.deepEqual(formProblems({ ...filled(), modelSha: 'A'.repeat(64) }), []);
});

test('the metadata sent with a CSV is the evidence format without records', () => {
  assert.deepEqual(buildMetadata(filled()), {
    model: { name: 'scorer', version: '1.0.0' }, feature_pipeline: { name: 'two features', version: '1', description: 'detour, pickup' },
    dataset: { id: 'held-out', split: 'test', population: 'forty scenarios', unit: 'one pair' }, positive_label: 'used by the reference',
    decision: { rule: 'score>=threshold', threshold: 0.5 } });
  const hard = buildMetadata({ ...filled(), rule: 'predictions', threshold: '0.5', policy: ' top 2 ', notes: ' n ', modelSha: 'A'.repeat(64), trainingData: 'none' });
  assert.deepEqual(hard.decision, { rule: 'predictions', policy: 'top 2' });                     // a threshold is never sent with hard predictions
  assert.equal(hard.notes, 'n');
  assert.deepEqual(hard.model, { name: 'scorer', version: '1.0.0', sha256: 'a'.repeat(64), training_data: 'none' });
});

test('file kinds, decision wording and threshold formatting', () => {
  assert.ok(isCsvFile('Records.CSV') && !isCsvFile('records.csv.json') && isJsonFile('evidence.json ') && !isJsonFile('evidence.txt'));
  assert.equal(decisionLabel('score>=threshold', 0.5), 'score ≥ 0.5');
  assert.equal(decisionLabel('score<=threshold', 0.1 + 0.2), 'score ≤ 0.3');
  assert.equal(decisionLabel('predictions', null), null);
  assert.equal(fmtThreshold(0.30000000000000004), '0.3');
  assert.equal(fmtThreshold(12), '12');
});

test('the slider step is a round 1/200 of the score range and values stay inside it', () => {
  assert.equal(sliderStep(0, 1), 0.005);
  assert.equal(sliderStep(0, 0.997), 0.005);
  assert.equal(sliderStep(-3, 5), 0.05);
  assert.equal(sliderStep(0, 400), 2);
  assert.equal(sliderStep(2, 2), 0.01);                                                          // one distinct score: any positive step
  assert.equal(clamp(1.4, 0, 1), 1);
  assert.equal(clamp(-2, 0, 1), 0);
  assert.equal(clamp(0.3, 0, 1), 0.3);
});

const SWEEP: SweepPoint[] = [
  { threshold: 0.1, precision: 0.5, recall: 1, f1: 0.666667, kept_share: 1 },
  { threshold: 0.5, precision: 0.6, recall: 0.75, f1: 0.666667, kept_share: 0.625 },
  { threshold: 0.9, precision: 1, recall: 0.25, f1: 0.4, kept_share: 0.125 },
  { threshold: 0.95, precision: null, recall: 0, f1: null, kept_share: 0 },
  { threshold: 0.99, precision: null, recall: 0, f1: null, kept_share: 0 },
];

test('the nearest sweep point is read, and an undefined value breaks the curve instead of dropping to zero', () => {
  assert.equal(nearest(SWEEP, 0.45)?.threshold, 0.5);
  assert.equal(nearest(SWEEP, 0)?.threshold, 0.1);
  assert.equal(nearest(SWEEP, 2)?.threshold, 0.99);
  assert.equal(nearest([], 0.5), null);
  const x = (t: number) => 100 * t, y = (v: number) => 100 * (1 - v);
  assert.deepEqual(segments(SWEEP, 'recall', x, y), ['10,0 50,25 90,75 95,100 99,100']);          // recall is defined everywhere (0 is a value)
  assert.deepEqual(segments(SWEEP, 'precision', x, y), ['10,50 50,40 90,0']);                      // stops where nothing is predicted positive
  const gap: SweepPoint[] = [SWEEP[0], { ...SWEEP[1], f1: null }, SWEEP[2]];
  assert.deepEqual(segments(gap, 'f1', x, y), ['10,33.3', '90,60']);                               // two pieces, no line through the gap
  assert.deepEqual(segments([], 'f1', x, y), []);
});
