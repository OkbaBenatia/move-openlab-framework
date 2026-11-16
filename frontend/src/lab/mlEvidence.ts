/** Pure helpers of the ML evaluation view: the evidence import form (which fields a CSV needs, the metadata sent with
 *  it), the threshold control and the geometry of the precision / recall / F1 curve. No React, no network. */
export interface SweepPoint { threshold: number; precision: number | null; recall: number | null; f1: number | null; kept_share: number }
export type CurveKey = 'precision' | 'recall' | 'f1';
export const RULES = ['score>=threshold', 'score<=threshold', 'predictions'] as const;
export type Rule = typeof RULES[number];

/** The decision in a compact, language-neutral form (hard predictions have no threshold: the caller words them). */
export const decisionLabel = (rule: string, threshold: number | null | undefined): string | null =>
  (rule === 'predictions' || threshold == null ? null : `score ${rule === 'score<=threshold' ? '≤' : '≥'} ${fmtThreshold(threshold)}`);
/** A threshold without floating-point noise (0.30000000000000004 → 0.3), at most six decimals. */
export const fmtThreshold = (v: number): string => String(Number(v.toFixed(6)));
export const isCsvFile = (name: string): boolean => /\.csv$/i.test(name.trim());
export const isJsonFile = (name: string): boolean => /\.json$/i.test(name.trim());

/** Metadata fields of a CSV import. `threshold` is text, as typed. */
export interface EvidenceForm {
  modelName: string; modelVersion: string; modelSha: string; trainingData: string;
  pipelineName: string; pipelineVersion: string; pipelineDescription: string;
  datasetId: string; split: string; population: string; unit: string;
  positiveLabel: string; rule: Rule; threshold: string; policy: string; notes: string;
}
export const emptyForm = (): EvidenceForm => ({ modelName: '', modelVersion: '', modelSha: '', trainingData: '', pipelineName: '', pipelineVersion: '', pipelineDescription: '',
  datasetId: '', split: '', population: '', unit: '', positiveLabel: '', rule: 'score>=threshold', threshold: '', policy: '', notes: '' });
const REQUIRED: [keyof EvidenceForm, string][] = [['modelName', 'Model name'], ['modelVersion', 'Model version'], ['pipelineName', 'Feature pipeline name'],
  ['pipelineVersion', 'Feature pipeline version'], ['pipelineDescription', 'Feature pipeline description'], ['datasetId', 'Dataset identifier'], ['split', 'Split'],
  ['population', 'Population'], ['unit', 'What one record is'], ['positiveLabel', 'Meaning of label 1']];
export const needsThreshold = (rule: string): boolean => rule !== 'predictions';

/** What still prevents a CSV import: the labels (English, translated where shown) of the empty required fields, and of
 *  a missing or non-numeric threshold or a malformed model digest. Empty when the form can be sent. */
export function formProblems(f: EvidenceForm): string[] {
  const out = REQUIRED.filter(([k]) => !f[k].trim()).map(([, label]) => label);
  if (needsThreshold(f.rule) && (f.threshold.trim() === '' || !Number.isFinite(Number(f.threshold.replace(',', '.'))))) out.push('Threshold');
  if (f.modelSha.trim() && !/^[0-9a-f]{64}$/.test(f.modelSha.trim().toLowerCase())) out.push('Model SHA-256 (64 hexadecimal characters)');
  return out;
}

/** The metadata object sent with a CSV file (the evidence format without `records`); optional fields left empty are omitted. */
export function buildMetadata(f: EvidenceForm): Record<string, unknown> {
  const t = (s: string) => s.trim();
  const decision: Record<string, unknown> = { rule: f.rule };
  if (needsThreshold(f.rule)) decision.threshold = Number(f.threshold.replace(',', '.'));
  if (t(f.policy)) decision.policy = t(f.policy);
  return {
    model: { name: t(f.modelName), version: t(f.modelVersion), ...(t(f.modelSha) ? { sha256: t(f.modelSha).toLowerCase() } : {}), ...(t(f.trainingData) ? { training_data: t(f.trainingData) } : {}) },
    feature_pipeline: { name: t(f.pipelineName), version: t(f.pipelineVersion), description: t(f.pipelineDescription) },
    dataset: { id: t(f.datasetId), split: t(f.split), population: t(f.population), unit: t(f.unit) },
    positive_label: t(f.positiveLabel), decision, ...(t(f.notes) ? { notes: t(f.notes) } : {}),
  };
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** A slider step of about 1/200 of the score range, rounded to 1, 2 or 5 × a power of ten (0.005 for scores in 0–1). */
export function sliderStep(lo: number, hi: number): number {
  const raw = (hi - lo) / 200;
  if (!(raw > 0) || !Number.isFinite(raw)) return 0.01;
  const p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return Number(((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p).toPrecision(1));
}
/** The sweep point whose threshold is closest to `t` (the first one on a tie). */
export function nearest(sweep: SweepPoint[], t: number): SweepPoint | null {
  let best: SweepPoint | null = null;
  for (const p of sweep) if (!best || Math.abs(p.threshold - t) < Math.abs(best.threshold - t)) best = p;
  return best;
}
/** Polyline point lists of one curve; an undefined value (null) breaks the line instead of being drawn as zero. */
export function segments(sweep: SweepPoint[], key: CurveKey, x: (t: number) => number, y: (v: number) => number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const p of sweep) {
    const v = p[key];
    if (v == null) { if (cur.length) out.push(cur.join(' ')); cur = []; continue; }
    cur.push(`${Number(x(p.threshold).toFixed(1))},${Number(y(v).toFixed(1))}`);
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}
