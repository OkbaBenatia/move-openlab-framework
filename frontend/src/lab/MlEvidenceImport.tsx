import { useEffect, useRef, useState } from 'react';
import { FileUp, Upload, X } from 'lucide-react';
import { errText } from '../components/common';
import { tr } from '../i18n';
import { lab, type ResultRow } from './api';
import { buildMetadata, emptyForm, formProblems, isCsvFile, needsThreshold, RULES, type EvidenceForm, type Rule } from './mlEvidence';

const RULE_LABEL: Record<Rule, string> = { 'score>=threshold': 'score ≥ threshold (a higher score means positive)', 'score<=threshold': 'score ≤ threshold (a lower score means positive)',
  predictions: 'hard predictions (the file has a prediction column)' };
const MAX_MB = 8;

/** Import evaluation evidence for one method: a JSON evidence document (it carries its own metadata), or a CSV of
 *  records with the metadata typed here. The server validates everything; a refusal is shown in place with its reason
 *  and nothing is stored. */
export function ImportEvidenceDialog({ row, onClose, onImported }: { row: ResultRow; onClose: () => void; onImported: (sha: string, created: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState<EvidenceForm>(emptyForm);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const csv = !!file && isCsvFile(file.name);
  const problems = csv ? formProblems(form) : [];
  const tooBig = !!file && file.size > MAX_MB * 1024 * 1024;
  const set = (k: keyof EvidenceForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const text = (k: keyof EvidenceForm, label: string, opts: { hint?: string; optional?: boolean; area?: boolean } = {}) => <label className="field">
    <span>{tr(label)}{opts.optional ? <span className="muted"> · {tr('optional')}</span> : ''}</span>
    {opts.area ? <textarea rows={2} aria-label={tr(label)} value={form[k]} onChange={set(k)} placeholder={opts.hint ? tr(opts.hint) : undefined} />
      : <input aria-label={tr(label)} value={form[k]} onChange={set(k)} placeholder={opts.hint ? tr(opts.hint) : undefined} />}</label>;
  const send = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const r = await lab.importEvidence(row.campaign_id, row.method_id, file, csv ? buildMetadata(form) : undefined);
      onImported(r.evidence_sha256, r.created);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return <div className="overlay" role="dialog" aria-label={tr('import evaluation evidence')} onClick={onClose}>
    <div className="drawer ml-import" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><FileUp size={18} /><div className="grow"><h2>{tr('Import evaluation evidence')}</h2>
        <div className="small muted">{tr('For the method {m}', { m: row.name })}</div></div>
        <button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
      <p className="small">{tr('Evidence is a list of records, each with a true label (0 or 1) and the method’s own score or prediction for it, on a population you name. MOVE OpenLab computes the confusion matrix and the metrics from these records; it cannot check that they are the method’s real predictions — that is what you state by importing them.')}</p>
      <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) { setFile(f); setErr(null); } }}>
        {file ? <span className="row gap wrap"><b className="mono small">{file.name}</b><span className="small muted">{(file.size / 1024).toFixed(1)} kB · {csv ? tr('CSV records') : tr('JSON evidence document')}</span></span>
          : <span className="small muted">{tr('A JSON evidence document (format move-openlab/ml-evaluation-evidence@1), or a CSV with the columns id, label, score and, optionally, prediction.')}</span>}
        <button className="btn sm" onClick={() => input.current?.click()}><Upload size={13} /> {file ? tr('Choose another file') : tr('Choose a JSON or CSV file')}</button>
        <input ref={input} type="file" accept=".json,.csv,application/json,text/csv" hidden aria-label={tr('evidence file')} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setFile(f); setErr(null); } }} />
      </div>
      {tooBig && <p className="note bad small" role="alert">{tr('This file is larger than {n} MB: it will be refused.', { n: MAX_MB })}</p>}
      {file && !csv && <p className="small muted">{tr('A JSON evidence document carries its own description (method, model, feature pipeline, dataset, decision): nothing more to fill in.')}</p>}
      {csv && <fieldset className="ml-form" aria-label={tr('description of the evidence')}>
        <legend>{tr('Describe the evidence')}</legend>
        <p className="tiny muted span2">{tr('A CSV holds the records only. These fields are stored with them, so that the evaluation says what was evaluated, on what, and how.')}</p>
        {text('modelName', 'Model name')}{text('modelVersion', 'Model version')}
        {text('modelSha', 'Model SHA-256', { optional: true, hint: 'digest of the weights file' })}{text('trainingData', 'Training data', { optional: true })}
        {text('pipelineName', 'Feature pipeline name')}{text('pipelineVersion', 'Feature pipeline version')}
        <div className="span2">{text('pipelineDescription', 'Feature pipeline description', { area: true, hint: 'which features, computed how' })}</div>
        {text('datasetId', 'Dataset identifier')}{text('split', 'Split', { hint: 'test, validation, held-out…' })}
        <div className="span2">{text('population', 'Population', { area: true, hint: 'in words: which records, from which scenarios' })}</div>
        {text('unit', 'What one record is', { hint: 'a candidate pair, an arc, a trip…' })}{text('positiveLabel', 'Meaning of label 1')}
        <label className="field"><span>{tr('Decision rule')}</span>
          <select aria-label={tr('Decision rule')} value={form.rule} onChange={set('rule')}>{RULES.map((r) => <option key={r} value={r}>{tr(RULE_LABEL[r])}</option>)}</select></label>
        {needsThreshold(form.rule) ? text('threshold', 'Threshold') : <span />}
        <div className="span2">{text('policy', 'Decision policy', { optional: true, hint: 'for example: top 3 per rider, then the threshold' })}</div>
        <div className="span2">{text('notes', 'Notes', { optional: true, area: true })}</div>
      </fieldset>}
      {csv && problems.length > 0 && <p className="small warn-text" role="status">{tr('Still needed')}: {problems.map((p) => tr(p)).join(', ')}</p>}
      {err && <p className="note bad small" role="alert"><b>{tr('The evidence was refused; nothing was stored.')}</b> {err}</p>}
      <p className="note small ml-stored">{tr('What is stored: the evidence (for a JSON file, the file exactly as it is) as a private file of your workspace, named by its SHA-256, beside this experiment. The experiment record and its checksum do not change. The import is written to the audit log. Evidence is not included in an exported bundle.')}</p>
      <div className="row gap drawer-foot"><span className="grow" />
        <button className="btn ghost" onClick={onClose}>{tr('Cancel')}</button>
        <button className="btn primary" disabled={!file || busy || tooBig || problems.length > 0} onClick={send}><FileUp size={14} /> {busy ? tr('Checking the evidence…') : tr('Import evidence')}</button></div>
    </div>
  </div>;
}
