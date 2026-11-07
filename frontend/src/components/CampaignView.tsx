import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, GitBranch, GitCompare, Lock, Map as MapIcon, Play, RotateCcw, Scale, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { call, download, post, type Json, type Problem } from '../api/client';
import { JobProgress } from './JobProgress';
import { KIND, Lineage, errText, secs, sh } from './common';

export function CampaignView({ id, problem, go, setErr }: { id: string; problem: Problem; go: (v: string) => void; setErr: (s: string | null) => void }) {
  const [d, setD] = useState<Json | null>(null);
  const [job, setJob] = useState<Json | null>(null);
  const [registered, setRegistered] = useState<Json[]>([]);
  const [variant, setVariant] = useState(problem.variants[0]?.id ?? '');
  const [thr, setThr] = useState({ method: '', scorer: problem.scorers.find((s) => s.id !== 'keep-all')?.id ?? '', thresholds: '0.25, 0.5, 0.75, 1', mode: 'absolute' });
  const load = useCallback(() => {
    call(`/campaigns/${id}`).then(setD).catch((e) => setErr(errText(e)));
    call(`/problems/${problem.spec.problem_id}/methods`).then((m) => setRegistered(m.registered)).catch(() => { /* optional */ });
  }, [id, problem, setErr]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(errText(e)); } };
  if (!d) return null;
  const c = d.campaign; const imported = !!d.import_record; const runs: Json[] = c.runs;
  const byMethod: Record<string, Json[]> = {};
  runs.forEach((r) => (byMethod[r.method_id] ??= []).push(r));
  const extendable = registered.filter((m) => !c.methods.some((x: Json) => x.method_id === m.method_id));   // the server also refuses methods already in the lineage
  const methodsInRuns = c.methods.filter((m: Json) => runs.some((r) => r.method_id === m.method_id));
  const med = (rs: Json[], k: string) => { const v = rs.map((r) => r[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const root = d.lineage[d.lineage.length - 1].campaign_id;
  return <div>
    <div className="row gap"><h2>{c.title}</h2><span className={`badge ${imported ? 'warn' : ''}`}>{imported ? `Imported ${(KIND[c.kind] ?? c.kind).toLowerCase()}` : KIND[c.kind] ?? c.kind}</span>
      <span className={`badge ${c.checksum ? 'ok' : ''}`}>{c.status}</span>{c.checksum && <span className="badge ok"><Lock size={10} /> immutable</span>}</div>
    <Lineage lineage={d.lineage} />
    <table className="kv"><tbody>
      <tr><th>Campaign</th><td className="mono">{c.campaign_id}</td><th>Researcher</th><td>{c.owner_display} · <span className="mono">{c.installation_id}</span></td></tr>
      <tr><th>Scenarios</th><td>{c.scenario_set.instance_hashes.length} instances{c.scenario_set.params && !c.scenario_set.params.instance_hashes && <span className="mono small"> {JSON.stringify(c.scenario_set.params)}</span>}
        <div className="mono small muted wrap-anywhere">{c.scenario_set.instance_hashes.map((h: string) => h.slice(0, 12)).join(' · ')}</div></td>
        <th>Methods</th><td>{c.methods.map((m: Json) => <div key={m.method_id} className="mono small">{m.method_id}@{m.version}{m.code_sha256 ? ` · code ${sh(m.code_sha256)}` : ''}</div>)}</td></tr>
      <tr><th>Configuration</th><td>{c.config.repetitions} repetitions · {c.config.order} · timeout {c.config.timeout_s} s · budget {c.config.time_budget_s} s</td>
        <th>Specification</th><td className="mono small">{c.spec.problem_id} · {c.spec.objective_spec_id} · validator {c.spec.validator_version}</td></tr>
      <tr><th>Checksum</th><td className="mono small">{c.checksum ?? 'not locked'}</td><th>Environment</th>
        <td className="small">{c.environment ? `Python ${c.environment.python} · ${c.environment.os} ${c.environment.machine} · CPU ${sh(c.environment.cpu_model_sha256, 8)} · framework ${c.environment.framework_version}` : '—'}</td></tr>
      {imported && <tr><th>Imported</th><td colSpan={3} className="small">by {d.import_record.imported_by} at {d.import_record.imported_at} · bundle <span className="mono">{sh(d.import_record.bundle_sha256, 16)}</span> · checksum re-verified · original researcher {d.import_record.original_owner_display} ({d.import_record.original_installation})</td></tr>}
      {c.semantic_variant && <tr><th>Controlled variant</th><td colSpan={3} className="small"><b>{c.semantic_variant.variant}</b> — {c.semantic_variant.description} · {c.semantic_variant.modifications.length} derived scenario(s){c.semantic_variant.not_applicable.length ? ` · not applicable to ${c.semantic_variant.not_applicable.length}` : ''}</td></tr>}
      {c.threshold_study && <tr><th>Threshold study</th><td colSpan={3} className="small">method <span className="mono">{c.threshold_study.method.method_id}</span> · scorer <b>{c.threshold_study.scorer.label}</b> · {c.threshold_study.mode === 'share' ? 'shares kept' : 'score thresholds'} {c.threshold_study.thresholds.join(', ')}{c.threshold_study.top_k ? ` · top-k ${c.threshold_study.top_k}` : ''}</td></tr>}
      {c.parent && <tr><th>Parent</th><td colSpan={3} className="small">{c.parent.relation} <span className="mono">{c.parent.campaign_id}</span> ({c.parent.owner_display}, checksum <span className="mono">{sh(c.parent.checksum, 16)}</span>) · differences: {c.config_differences_from_parent?.length ? c.config_differences_from_parent.join('; ') : 'none'}</td></tr>}
    </tbody></table>
    {runs.length > 0 && <><h3>Results <span className="muted small">({runs.length} runs · {imported ? 'imported records' : 'executed in this workspace'} · first repetition totals)</span></h3>
      <div className="table-scroll"><table aria-label="method summary"><thead><tr><th>Method</th><th>Runs</th><th>Accepted &amp; feasible</th>
        {problem.metrics.map((m) => <th key={m.id}>{m.label}</th>)}<th>Median solver time</th><th>Median total time</th></tr></thead>
        <tbody>{Object.entries(byMethod).map(([m, rs]) => { const first = rs.filter((r) => r.repetition === 1);
          return <tr key={m}><td className="mono">{m}</td><td>{rs.length}</td><td>{rs.filter((r) => r.accepted && r.validation.feasible).length} / {rs.length}</td>
            {problem.metrics.map((x) => <td key={x.id}>{first.reduce((s, r) => s + (r.validation.metrics[x.id] ?? 0), 0)}</td>)}
            <td>{secs(med(rs, 'solver_time_s'))}</td><td>{secs(med(rs, 'total_time_s'))}</td></tr>; })}</tbody></table></div></>}
    {d.optimality_scope && Object.keys(d.optimality_scope).length > 0 && <><h3>What the results prove <span className="muted small">(first repetition)</span></h3>
      <table aria-label="optimality scope"><tbody>{Object.entries(d.optimality_scope as Record<string, Record<string, number>>).map(([m, sc]) => <tr key={m}><td className="mono">{m}</td>
        <td>{Object.entries(sc).map(([label, n]) => <span key={label} className={`badge ${label.startsWith('proven') ? 'ok' : label.startsWith('invalid') ? 'bad' : label.startsWith('optimal for the reduced') ? 'warn' : ''}`}>{n} × {label}</span>)}</td></tr>)}</tbody></table></>}
    {job && <JobProgress job={job} setErr={setErr} onFinished={(j) => { setJob(j.state === 'running' ? j : null); load(); }} />}
    <div className="row gap actions">
      {!imported && c.status === 'draft' && !job && <button className="btn primary" onClick={() => act(async () => { setJob(await post(`/campaigns/${id}/execute`)); })}><Play size={13} /> Execute</button>}
      {c.status === 'running' && !job && <span className="badge">running in another session</span>}
      {runs.length > 0 && problem.scenario_parameters.fields.some((f) => f.type === 'scenario-library') && <button className="btn" onClick={() => go(`play:${id}`)}><MapIcon size={13} /> Route playback</button>}
      {!imported && c.status === 'completed' && <button className="btn primary" onClick={() => act(async () => { await post(`/campaigns/${id}/lock`); load(); })}><Lock size={13} /> Lock (immutable)</button>}
      {c.checksum && <button className="btn" onClick={() => act(() => download(`/campaigns/${id}/export`, `move_openlab_campaign_${id}.zip`))}><Download size={13} /> Export bundle</button>}
      <button className="btn" onClick={() => act(() => download(`/campaigns/${id}/record.json`, `campaign_${id}.json`))}><FileText size={13} /> Record (JSON)</button>
      {c.checksum && c.kind === 'baseline' && <button className="btn" onClick={() => act(async () => { const r = await post(`/campaigns/${id}/reproduce`); go(`c:${r.campaign_id}`); })}><RotateCcw size={13} /> Independently re-execute</button>}
      {c.kind === 'reproduction' && runs.length > 0 && <button className="btn" onClick={() => go(`rep:${id}`)}><ShieldCheck size={13} /> Reproducibility verification</button>}
      {c.checksum && !imported && ['baseline', 'reproduction', 'extended'].includes(c.kind) && extendable.map((m) => <button key={m.method_id} className="btn" onClick={() => act(async () => { const r = await post(`/campaigns/${id}/extend`, { methods: [[m.method_id, m.version]] }); go(`c:${r.campaign_id}`); })}><GitBranch size={13} /> Extend with {m.name} {m.version}</button>)}
      {['baseline', 'reproduction', 'extended'].includes(c.kind) && runs.length > 0 && <button className="btn" onClick={() => go(`cmp:${id}`)}><GitCompare size={13} /> Compare methods</button>}
      {c.parent && runs.length > 0 && ['variant', 'reproduction', 'extended'].includes(c.kind) && <button className="btn" onClick={() => go(`sem:${root}|${id}`)}><Scale size={13} /> Semantic comparability</button>}
      {c.kind === 'threshold-study' && runs.length > 0 && <button className="btn" onClick={() => go(`thr:${id}`)}><SlidersHorizontal size={13} /> Threshold report</button>}
    </div>
    {c.checksum && ['baseline', 'reproduction', 'extended'].includes(c.kind) && <div className="derive">
      {problem.variants.length > 0 && <div className="row gap">
        <select aria-label="variant" value={variant} onChange={(e) => setVariant(e.target.value)}>{problem.variants.map((v) => <option key={v.id} value={v.id}>{v.id} — {v.description}</option>)}</select>
        <button className="btn" onClick={() => act(async () => { const r = await post(`/campaigns/${id}/variant`, { variant }); go(`c:${r.campaign_id}`); })}><GitBranch size={13} /> Create controlled variant</button></div>}
      {problem.candidate_scoring && methodsInRuns.length > 0 && <div className="row gap">
        <select aria-label="threshold method" value={thr.method} onChange={(e) => setThr({ ...thr, method: e.target.value })}><option value="">method…</option>
          {methodsInRuns.map((m: Json) => <option key={m.method_id} value={`${m.method_id}@${m.version}`}>{m.method_id}</option>)}</select>
        <select aria-label="scorer" value={thr.scorer} onChange={(e) => setThr({ ...thr, scorer: e.target.value })}>{problem.scorers.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
        <select aria-label="threshold mode" value={thr.mode} onChange={(e) => setThr({ ...thr, mode: e.target.value, thresholds: e.target.value === 'share' ? '0.25, 0.5, 0.75, 1' : thr.thresholds })}>
          <option value="absolute">fixed score thresholds</option><option value="share">dynamic: share of candidates kept</option></select>
        <input aria-label="thresholds" value={thr.thresholds} onChange={(e) => setThr({ ...thr, thresholds: e.target.value })} />
        <button className="btn" disabled={!thr.method} onClick={() => act(async () => {
          const r = await post(`/campaigns/${id}/threshold-study`, { method: thr.method.split('@'), scorer: thr.scorer, mode: thr.mode, thresholds: thr.thresholds.split(/[\s,]+/).filter(Boolean).map(Number) });
          go(`c:${r.campaign_id}`); })}><SlidersHorizontal size={13} /> Create threshold study</button></div>}
    </div>}
  </div>;
}
