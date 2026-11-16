import { useEffect, useRef, useState } from 'react';
import { Download, FileUp, RotateCcw } from 'lucide-react';
import { errText, num } from '../components/common';
import { tr } from '../i18n';
import { lab, type ResultRow } from './api';
import type { MlEvaluation as Evaluation, MlPopulation } from './metrics';
import { clamp, decisionLabel, fmtThreshold, sliderStep } from './mlEvidence';
import { ImportEvidenceDialog } from './MlEvidenceImport';
import { ThresholdCurve } from './MlThresholdCurve';

type Value = number | null | undefined;
const pc = (v: Value) => (v == null ? '—' : `${num(100 * v, 2)} %`);
const METRICS: [string, string][] = [['accuracy', 'Accuracy'], ['balanced_accuracy', 'Balanced accuracy'], ['precision', 'Precision'], ['recall', 'Recall'],
  ['specificity', 'Specificity'], ['f1', 'F1'], ['pr_auc', 'PR-AUC'], ['roc_auc', 'ROC-AUC']];
const count = (v: number) => v.toLocaleString('en');
const rowKey = (r: ResultRow) => `${r.campaign_id}:${r.method_id}`;
const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** ML evaluation of the compared methods, from labelled predictions only: per method, the confusion matrix, the
 *  classification figures and where they come from — the problem package, or evidence the researcher imported for
 *  this experiment. A learned method without evidence says so and offers the import; an exact or heuristic method is
 *  "not applicable". Nothing here is derived from an optimization result. */
export function MlEvaluationView({ rows, evals, population, setPopulation, reload }: {
  rows: ResultRow[]; evals: (r: ResultRow) => Evaluation | null; population: number; setPopulation: (i: number) => void;
  /** Re-read one row's evaluation after an import or a withdrawal (the tables read the same data). */
  reload?: (r: ResultRow) => Promise<unknown>;
}) {
  const [importing, setImporting] = useState<ResultRow | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);
  // the population chooser lists the populations of the problem package; imported evidence is chosen on its own card
  const pops = Array.from(new Set(rows.flatMap((r) => evals(r)?.evaluations.filter((e) => !fromEvidence(e)).map((e) => e.population) ?? [])));
  const popName = pops[Math.min(population, Math.max(0, pops.length - 1))];
  return <div className="ml-eval">
    <div className="row gap wrap"><h3 className="grow">{tr('ML evaluation (labelled predictions)')}</h3>
      {pops.length > 0 && <label className="row small gap">{tr('Evaluation population')}
        <select aria-label={tr('evaluation population')} value={population} onChange={(e) => setPopulation(Number(e.target.value))}>{pops.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></label>}</div>
    <p className="small muted">{tr('Accuracy, precision, recall and F1 need real predictions and real labels on a named population. They are separate from optimization outcomes: reference-arc retention of a run is not a general recall, and no matrix is derived from route results.')}</p>
    <div className="ml-grid">{rows.map((r) => <MethodCard key={rowKey(r)} row={r} ev={evals(r)} popName={popName} onImport={() => setImporting(r)} reload={reload}
      notice={notice?.key === rowKey(r) ? notice.text : null} />)}</div>
    {importing && <ImportEvidenceDialog row={importing} onClose={() => setImporting(null)} onImported={(sha, created) => {
      const row = importing; setImporting(null);
      setNotice({ key: rowKey(row), text: created ? tr('Evidence imported and stored (SHA-256 {h}…).', { h: sha.slice(0, 16) }) : tr('This evidence was already imported: nothing was stored twice.') });
      reload?.(row).catch(() => { /* the card keeps what it shows */ });
    }} />}
  </div>;
}

function MethodCard({ row, ev, popName, onImport, reload, notice }: { row: ResultRow; ev: Evaluation | null; popName: string | undefined; onImport: () => void;
  reload?: (r: ResultRow) => Promise<unknown>; notice: string | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  const label = `${row.name} ${tr('evaluation')}`;
  const importButton = <button className="btn sm" onClick={onImport}><FileUp size={13} /> {tr('Import evaluation evidence')}</button>;
  if (!ev) return <section className="card ml-card"><h4>{row.name}</h4><p className="small muted">{tr('Loading the evaluation…')}</p></section>;
  if (!ev.available) {
    const notApplicable = ev.can_import === false || /^not applicable/i.test(ev.reason ?? '');
    return <section className="card ml-card" aria-label={label}><h4>{row.name}</h4>
      {notApplicable ? <>
        <p className="small"><span className="badge">{tr('Not applicable')}</span></p>
        <p className="small muted">{ev.reason && tr(ev.reason)}</p>
        <p className="small muted">{tr('An exact or heuristic method computes a solution directly: it classifies nothing, so there is no confusion matrix, accuracy, precision or recall to report for it. Its results are in the Results tab.')}</p>
      </> : <>
        <p className="small"><span className="badge">{tr('Not available')}</span> <b>{tr('Not available — import evaluation evidence')}</b></p>
        <p className="small muted">{ev.reason && tr(ev.reason)}</p>
        {ev.can_import !== false && <><p className="small muted">{tr('No figure is shown without evidence: nothing is estimated and nothing is derived from the optimization results.')}</p>
          <div className="row gap wrap">{importButton}</div></>}
        <Withdrawn n={ev.withdrawn} />
      </>}
      {notice && <p className="note ok small" role="status">{notice}</p>}</section>;
  }
  const id = (e: MlPopulation, i: number) => e.evidence_sha256 ?? `provided:${i}`;
  const byPop = ev.evaluations.findIndex((e) => !fromEvidence(e) && e.population === popName);
  const at = ev.evaluations.findIndex((e, i) => id(e, i) === picked);
  const chosen = at >= 0 ? at : byPop >= 0 ? byPop : ev.evaluations.findIndex((e) => fromEvidence(e));
  if (chosen < 0) return <section className="card ml-card" aria-label={label}><div className="row gap wrap"><h4 className="grow">{row.name}</h4>{ev.can_import !== false && importButton}</div>
    <p className="small"><span className="badge">{tr('Not available')}</span></p><p className="small muted">{tr('This method has no evaluation on the chosen population.')}</p></section>;
  const p = ev.evaluations[chosen];
  return <section className="card ml-card" aria-label={label}>
    <div className="row gap wrap"><h4 className="grow">{row.name}</h4>{ev.can_import !== false && importButton}</div>
    {ev.evaluations.length > 1 && <label className="field">{tr('Evaluation shown')}
      <select aria-label={`${tr('evaluation shown')} ${row.name}`} value={id(p, chosen)} onChange={(e) => setPicked(e.target.value)}>
        {ev.evaluations.map((e, i) => <option key={id(e, i)} value={id(e, i)}>{short(e.population)} · {e.split} — {e.origin === 'bundle-reference' ? tr('reference received with a bundle') : e.origin === 'imported' ? tr('imported evidence') : tr('provided by the problem package')}</option>)}</select></label>}
    {notice && <p className="note ok small" role="status">{notice}</p>}
    <EvaluationBody key={id(p, chosen)} row={row} p={p} reload={reload} />
    {(ev.evidence_errors ?? []).map((e) => <p key={e.evidence_sha256} className="note bad small" role="alert">{tr('Stored evidence {h}… cannot be used', { h: e.evidence_sha256.slice(0, 12) })}: {e.reason}</p>)}
    {ev.adapter_error && <p className="small warn-text">{tr(ev.adapter_error)}</p>}
    <Withdrawn n={ev.withdrawn} />
  </section>;
}

/** Evaluations computed from evidence documents (imported here, or received with a bundle), as opposed to those a
 *  problem package provides. */
const fromEvidence = (e: { origin?: string }) => e.origin === 'imported' || e.origin === 'bundle-reference';

function Withdrawn({ n }: { n?: number }) {
  return n ? <p className="tiny muted">{tr('{n} imported evidence withdrawn (hidden, the files are kept; importing the same file again shows it again).', { n })}</p> : null;
}

/** One evaluation: matrix, metric tiles, provenance and — for a decision `score ≥ / ≤ threshold` on imported evidence —
 *  the threshold control and its curve. Exploring a threshold asks the server to recompute on the stored evidence; the
 *  recorded decision stays shown, and the Results table keeps using it. */
function EvaluationBody({ row, p, reload }: { row: ResultRow; p: MlPopulation; reload?: (r: ResultRow) => Promise<unknown> }) {
  const [hover, setHover] = useState<string | null>(null);
  const recorded = p.recorded_decision?.threshold ?? null;
  const adjustable = !!p.threshold_adjustable && recorded != null && !!p.evidence_sha256;
  const [text, setText] = useState(recorded == null ? '' : fmtThreshold(recorded));
  const [target, setTarget] = useState<number | null>(null);        // the threshold being explored (null: the recorded one)
  const [answer, setAnswer] = useState<MlPopulation | null>(null);   // what the server computed for it
  const [state, setState] = useState<{ busy: boolean; err: string | null }>({ busy: false, err: null });
  const [confirm, setConfirm] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const imported = fromEvidence(p);
  const reference = p.origin === 'bundle-reference';
  const explored = target != null ? answer : null;                   // while a new threshold is computed, the last answer stays (it names its own threshold)
  const shown = explored ?? p;
  const current = target ?? recorded;
  const explore = (t: number, shownText?: string) => {
    setText(shownText ?? fmtThreshold(t));
    if (timer.current) clearTimeout(timer.current);
    const mine = ++seq.current;
    if (t === recorded) { setTarget(null); setAnswer(null); setState({ busy: false, err: null }); return; }
    setTarget(t); setState({ busy: true, err: null });
    timer.current = setTimeout(() => {
      lab.evaluationAt(row.campaign_id, row.method_id, t).then((res) => {
        if (mine !== seq.current) return;
        const got = (res.evaluations as MlPopulation[]).find((e) => e.evidence_sha256 === p.evidence_sha256) ?? null;
        setAnswer(got?.exploratory ? got : null); setState({ busy: false, err: null });
      }).catch((e) => { if (mine === seq.current) setState({ busy: false, err: errText(e) }); });
    }, 220);
  };
  const typed = (s: string) => { const v = Number(s.replace(',', '.')); if (s.trim() !== '' && Number.isFinite(v)) explore(v, s); else setText(s); };
  const withdraw = async () => {
    if (!p.evidence_sha256) return;
    try { await lab.withdrawEvidence(row.campaign_id, p.evidence_sha256); await reload?.(row); } catch (e) { setState({ busy: false, err: errText(e) }); }
  };
  const c = shown.confusion, total = c.tp + c.fn + c.fp + c.tn;
  const key = `${rowKey(row)}:${p.evidence_sha256 ?? p.population}`;
  const cells: [string, string, number, string][] = imported
    ? [['tp', tr('True positive'), c.tp, tr('label positive, predicted positive')], ['fn', tr('False negative'), c.fn, tr('label positive, predicted negative')],
      ['fp', tr('False positive'), c.fp, tr('label negative, predicted positive')], ['tn', tr('True negative'), c.tn, tr('label negative, predicted negative')]]
    : [['tp', tr('True positive'), c.tp, tr('reference-positive, kept')], ['fn', tr('False negative'), c.fn, tr('reference-positive, removed')],
      ['fp', tr('False positive'), c.fp, tr('reference-negative, kept')], ['tn', tr('True negative'), c.tn, tr('reference-negative, removed')]];
  const metrics = shown.metrics as Record<string, Value>;
  const reasons = shown.metric_reasons ?? {};
  // a problem package lists the figures it provides; imported evidence shows all eight, an undefined one with its reason
  const tiles = METRICS.filter(([id]) => imported || metrics[id] != null);
  const prov = p.provenance;
  const ruleText = (rule: string, t: number | null | undefined, policy?: string | null) => `${decisionLabel(rule, t) ?? tr('hard predictions provided with the evidence')}${policy ? ` (${policy})` : ''}`;
  const range = p.score_range ?? null;
  return <>
    <div className="row gap wrap ml-origin">
      <span className={`badge ${imported ? 'info' : 'outline'}`}>{reference ? tr('reference received with a bundle') : imported ? tr('imported evidence') : tr('provided by the problem package')}</span>
      {reference && <span className="badge warn" title={tr('Received as a reference: the predictions and labels were not included in the bundle, so these figures are the exporter\u2019s and cannot be recomputed here.')}>{tr('not recomputable here')}</span>}
      {explored && <span className="badge warn">{tr('exploratory threshold')}</span>}
      <span className="small muted ml-pop" title={p.population}>{short(p.population, 90)} · {p.split}</span></div>
    <table className="confusion" aria-label={`${tr('confusion matrix')} ${row.name}`}>
      <thead><tr><th />{imported ? <><th>{tr('Predicted: positive')}</th><th>{tr('Predicted: negative')}</th></> : <><th>{tr('Predicted: keep')}</th><th>{tr('Predicted: remove')}</th></>}</tr></thead>
      <tbody>{[0, 1].map((r) => <tr key={r}><th>{imported ? (r === 0 ? tr('Label: positive') : tr('Label: negative')) : r === 0 ? tr('Reference: positive') : tr('Reference: negative')}</th>
        {[0, 1].map((col) => { const [id, name, v, what] = cells[r * 2 + col]; const good = id === 'tp' || id === 'tn';
          return <td key={id} data-cell={id} className={`cm ${good ? 'cm-ok' : 'cm-err'} ${hover === `${key}${id}` ? 'on' : ''}`} onMouseEnter={() => setHover(`${key}${id}`)} onMouseLeave={() => setHover(null)}
            title={`${name}: ${count(v)} ${tr('of')} ${count(total)} (${num(100 * v / total, 2)} %) — ${what}`}>
            <b>{count(v)}</b><span className="tiny block">{id.toUpperCase()} · {num(100 * v / total, 1)} %</span><span className="tiny block cm-name">{name}</span></td>; })}</tr>)}</tbody></table>
    <div className="ml-tiles" role="list" aria-label={`${tr('classification metrics')} ${row.name}`}>{tiles.map(([id, name]) => { const v = metrics[id]; const why = reasons[id];
      return <div key={id} role="listitem" data-metric={id} className={`ml-tile ${v == null ? 'na' : ''}`} title={v == null ? (why ? tr(why) : tr('Not available')) : p.metric_basis?.[id] ?? p.metric_basis?.other}>
        <span className="tiny muted">{tr(name)}</span>{v == null ? <><b className="na">{tr('Not available')}</b><span className="tiny muted">{why ? tr(why) : ''}</span></> : <b>{pc(v)}</b>}</div>; })}</div>
    {(shown.extra_metrics ?? []).length > 0 && <dl className="facts-list ml-extra" aria-label={tr('additional metrics')}>{shown.extra_metrics!.map((x) => <div key={x.id} title={[tr(x.description), x.source === 'builtin' ? '' : x.source].filter(Boolean).join(' · ')}>
      <dt>{tr(x.label)}{x.source !== 'builtin' && <span className="tiny muted"> · {x.source}</span>}</dt><dd>{x.value == null ? <span className="muted" title={x.reason ? tr(x.reason) : ''}>{tr('Not available')}</span> : num(x.value, 3)}</dd></div>)}</dl>}
    {adjustable && range && p.sweep && <div className="ml-threshold" role="group" aria-label={`${tr('decision threshold')} ${row.name}`}>
      <div className="row gap wrap"><label className="row gap small">{tr('Threshold')}
        <input type="number" aria-label={`${tr('threshold')} ${row.name}`} value={text} step={sliderStep(range[0], range[1])} onChange={(e) => typed(e.target.value)} /></label>
        <input type="range" className="grow" aria-label={`${tr('threshold slider')} ${row.name}`} min={range[0]} max={range[1]} step={sliderStep(range[0], range[1])}
          value={clamp(current ?? recorded!, range[0], range[1])} onChange={(e) => explore(Number(e.target.value))} />
        <button className="btn sm" disabled={target == null && text === fmtThreshold(recorded!)} onClick={() => explore(recorded!)} title={tr('Back to the threshold recorded with the evidence')}><RotateCcw size={13} /> {tr('Recorded: {t}', { t: fmtThreshold(recorded!) })}</button></div>
      {explored ? <p className="small warn-text" role="status">{tr('Exploring {d}: these figures are recomputed from the stored evidence and are not the recorded decision ({r}: TP {tp} · FP {fp} · TN {tn} · FN {fn}). The Results table keeps the recorded decision.',
        { d: ruleText(prov?.decision.rule ?? '', explored.threshold), r: ruleText(prov?.decision.rule ?? '', recorded), tp: count(p.confusion.tp), fp: count(p.confusion.fp), tn: count(p.confusion.tn), fn: count(p.confusion.fn) })}</p>
        : <p className="tiny muted">{state.busy ? tr('Recomputing…') : tr('Move the threshold to see how the matrix and the metrics change. Nothing is stored, and the recorded decision is kept.')}</p>}
      <ThresholdCurve sweep={p.sweep} range={range} recorded={recorded!} current={current ?? recorded!} name={row.name} onPick={(t) => explore(t)} />
    </div>}
    {state.err && <p className="note bad small" role="alert">{state.err}</p>}
    {imported && prov && <dl className="facts ml-prov" aria-label={`${tr('provenance')} ${row.name}`}>
      <dt>{tr('Dataset')}</dt><dd>{prov.dataset.id} · {tr('split')} {prov.dataset.split}</dd>
      <dt>{tr('Population')}</dt><dd>{prov.dataset.population}</dd>
      <dt>{tr('Decision')}</dt><dd>{ruleText(prov.decision.rule, prov.decision.threshold, prov.decision.policy)}</dd>
      <dt>{tr('Model')}</dt><dd>{prov.model.name} · {prov.model.version}{prov.model.sha256 ? <> · sha256 <span className="mono">{prov.model.sha256.slice(0, 16)}…</span></> : ''}</dd>
      <dt>{tr('Feature pipeline')}</dt><dd>{prov.feature_pipeline.name} · {prov.feature_pipeline.version}</dd>
      <dt>{tr('Evidence')}</dt><dd>sha256 <span className="mono" title={p.evidence_sha256}>{p.evidence_sha256?.slice(0, 16)}…</span></dd></dl>}
    <details className="small"><summary>{imported ? tr('Class balance, labels, import and notes') : tr('Population, decision and source')}</summary>
      <ul className="plain muted">
        {imported ? <li><b>{tr('Records')}</b>: {count(p.candidates)} · {tr('one record')} = {p.unit}</li>
          : <li><b>{tr('Population')}</b>: {p.population} · {p.split}{p.graphs != null ? <> · {p.graphs} {tr('scenarios')}</> : ''} · {count(p.candidates)} {tr('candidates')}</li>}
        <li><b>{tr('Class balance')}</b>: {count(p.positives)} {tr('positives')} ({num(p.prevalence_pct, 2)} %), {count(p.candidates - p.positives)} {tr('negatives')}</li>
        {!imported && <li><b>{tr('Decision')}</b>: {p.decision}</li>}
        <li><b>{tr('Labels')}</b>: {imported ? `${tr('label 1')} = ` : ''}{p.positive_label}</li>
        {imported ? <li><b>{tr('PR-AUC and ROC-AUC')}</b>: {p.has_scores ? tr('from the scores of the evidence; they do not depend on the threshold') : tr('not available: the evidence has no score for every record')}</li>
          : <li><b>{tr('PR-AUC and ROC-AUC')}</b>: {p.metric_basis?.roc_auc ?? tr('raw score')}; {tr('the other figures')}: {p.metric_basis?.other ?? p.decision}</li>}
        {imported && prov && <>
          <li><b>{tr('Feature pipeline')}</b>: {prov.feature_pipeline.description}</li>
          {prov.model.training_data && <li><b>{tr('Training data')}</b>: {prov.model.training_data}</li>}
          {prov.model.sha256 && <li><b>{tr('Model')}</b> sha256: <span className="mono ml-hash">{prov.model.sha256}</span></li>}
          <li><b>{tr('Evidence')}</b> sha256: <span className="mono ml-hash">{p.evidence_sha256}</span></li>
          <li><b>{tr('Imported by')}</b>: {p.imported_by}{p.imported_at ? ` · ${new Date(p.imported_at).toLocaleString()}` : ''} · {tr('file')} {p.source.name}{p.source.sha256 !== p.evidence_sha256 ? <> · sha256 <span className="mono">{p.source.sha256.slice(0, 16)}…</span></> : ''}</li>
          <li>{reference ? tr('Received as a reference: the predictions and labels were not included in the bundle, so these figures are the exporter\u2019s and cannot be recomputed here.') : tr('Computed by MOVE OpenLab from the imported records. The platform cannot verify that they are the method’s real predictions: that is the statement of the person who imported them.')}</li></>}
        {!imported && <li><b>{tr('Source')}</b>: {p.source.name} · sha256 <span className="mono">{p.source.sha256.slice(0, 16)}…</span></li>}
        {p.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      {imported && !reference && p.evidence_sha256 && <div className="row gap wrap ml-actions">
        <a className="btn sm" href={`/api${lab.evidencePath(row.campaign_id, p.evidence_sha256)}`} download><Download size={13} /> {tr('Download the stored evidence')}</a>
        {confirm ? <><span className="small">{tr('Hide this evidence from the evaluation? The file is kept.')}</span>
          <button className="btn sm danger" onClick={withdraw}>{tr('Withdraw')}</button><button className="btn sm ghost" onClick={() => setConfirm(false)}>{tr('Cancel')}</button></>
          : <button className="btn sm ghost" onClick={() => setConfirm(true)}>{tr('Withdraw this evidence…')}</button>}</div>}
    </details>
  </>;
}
