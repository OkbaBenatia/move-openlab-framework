import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { call, type Json } from '../api/client';
import { tr } from '../i18n';
import { errText, secs } from './common';

interface Phase { name: string; detail: string; start: number; duration: number | null; state: 'done' | 'error' | 'cancelled' | 'interrupted' | 'running'; sub?: [string, number][] }

const FINAL: Record<string, Phase['state']> = { done: 'done', error: 'error', cancelled: 'cancelled', interrupted: 'interrupted' };
const LABEL: Record<string, string> = { started: 'Created', queued: 'Queued', prepare: 'Preparing', run: 'Method run', validate: 'Validating', complete: 'Persisting results', done: 'Completed', error: 'Error', cancelled: 'Cancelled', cancel: 'Cancellation requested', interrupted: 'Interrupted' };
const WAITING = 'waiting for the worker';

/** The execution timeline of a job, built from its event log: one phase per stage change (runs are listed one by
 *  one with their prepare / method / validation durations), each with its start time and duration. */
export function phases(job: Json): Phase[] {
  const ev: Json[] = job.events ?? [];
  const end = job.duration_s ?? (ev.length ? ev[ev.length - 1].t : null);
  const out: Phase[] = [];
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i], next = ev[i + 1];
    const isFinal = e.stage in FINAL;
    const duration = isFinal ? 0 : next ? next.t - e.t : end != null ? end - e.t : null;
    const sub = e.stages ? (Object.entries(e.stages as Record<string, number>).map(([k, v]) => [k === 'execute' ? 'method' : k === 'validate' ? 'validation' : k === 'domain' ? 'metrics' : k, v]) as [string, number][]) : undefined;
    out.push({ name: LABEL[e.stage] ?? e.stage, detail: e.message, start: e.t, duration, sub,
      state: isFinal ? FINAL[e.stage] : e.stage === 'run' && e.accepted === false ? 'error' : job.state === 'running' && !next ? 'running' : 'done' });
  }
  if (out.length && out[0].name === LABEL.started && out[1]) out.splice(1, 0, { name: LABEL.queued, detail: WAITING, start: out[0].start, duration: out[1].start - out[0].start, state: 'done' });
  return out;
}

export function TraceTimeline({ job }: { job: Json }) {
  const ph = useMemo(() => phases(job), [job]);
  const total = Math.max(0.001, job.duration_s ?? (ph.length ? ph[ph.length - 1].start : 0));
  const stages = useMemo(() => {
    const acc: Record<string, number[]> = {};
    for (const e of (job.events ?? []) as Json[]) if (e.stages) for (const [k, v] of Object.entries(e.stages as Record<string, number>)) (acc[k] ??= []).push(v);
    return Object.entries(acc).map(([k, v]) => { const s = [...v].sort((a, b) => a - b); return { stage: k, n: v.length, median: s[Math.floor(s.length / 2)], max: s[s.length - 1], total: v.reduce((a, b) => a + b, 0) }; });
  }, [job]);
  if (!ph.length) return <p className="muted">{tr('No trace available')}</p>;
  return <div className="trace">
    <ol className="phases" aria-label={tr('execution timeline')}>{ph.map((p, i) => <li key={i} className={`phase ${p.state}`}>
      <span className="phase-t mono small">{p.start.toFixed(2)} s</span>
      <span className="phase-name"><b>{tr(p.name)}</b> <span className="small muted">{p.detail === WAITING ? tr(WAITING) : p.detail}</span>{p.sub && <span className="small muted"> · {p.sub.map(([k, v]) => `${tr(k)} ${secs(v)}`).join(' · ')}</span>}</span>
      <span className="phase-bar" aria-hidden><i style={{ left: `${(100 * p.start) / total}%`, width: `${Math.max(0.5, (100 * (p.duration ?? 0)) / total)}%` }} /></span>
      <span className="phase-d small">{p.duration == null ? '…' : secs(p.duration)}</span></li>)}</ol>
    {stages.length > 0 && <table className="compact" aria-label={tr('stage durations')}><thead><tr><th>{tr('Per run')}</th><th>{tr('Runs')}</th><th>{tr('Median')}</th><th>{tr('Max')}</th><th>{tr('Total')}</th></tr></thead>
      <tbody>{stages.map((s) => <tr key={s.stage}><td>{s.stage}</td><td>{s.n}</td><td>{secs(s.median)}</td><td>{secs(s.max)}</td><td>{secs(s.total)}</td></tr>)}</tbody></table>}
    <details className="small"><summary>{tr('Technical details')}</summary>
      <div className="table-scroll tall"><table aria-label={tr('trace events')}><tbody>{((job.events ?? []) as Json[]).slice(-500).map((e, k) => <tr key={k}><td className="mono small">{e.t.toFixed(2)} s</td><td>{e.stage}</td><td className="small">{e.message}</td></tr>)}</tbody></table></div>
      <p className="mono small muted">{job.kind} · {job.job_id} · {job.state}</p></details>
  </div>;
}

/** Trace of one job, in a drawer: loads the job (with events) and shows "No trace available" when it is gone. */
export function TraceDrawer({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [job, setJob] = useState<Json | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = () => call(`/jobs/${jobId}`).then((j) => { if (!live) return; setJob(j); if (j.state === 'running') setTimeout(tick, 800); })
      .catch((e) => { if (!live) return; if (/404|not found/i.test(errText(e))) setJob(null); else setErr(errText(e)); });
    tick();
    return () => { live = false; };
  }, [jobId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return <div className="overlay" role="dialog" aria-label={tr('execution trace')} onClick={onClose}>
    <div className="drawer wide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2>{tr('Trace')}</h2>{job && <span className="muted small">{job.title || job.kind}</span>}<span className="grow" />
        <button className="btn icon" aria-label={tr('close')} onClick={onClose}><X size={15} /></button></div>
      {err && <p className="note warn" role="alert">{err}</p>}
      {job === undefined && !err && <p className="muted small">{tr('Loading…')}</p>}
      {job === null && <p className="muted">{tr('No trace available')}</p>}
      {job && <TraceTimeline job={job} />}
    </div>
  </div>;
}
