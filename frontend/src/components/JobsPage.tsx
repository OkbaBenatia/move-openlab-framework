import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, StepForward } from 'lucide-react';
import { call, type Json } from '../api/client';
import { errText, secs } from './common';

/** Run history (persisted jobs of the signed-in user) and the per-stage execution trace of a selected job. */
export function JobsPage({ setErr }: { setErr: (s: string | null) => void }) {
  const [jobs, setJobs] = useState<Json[]>([]);
  const [sel, setSel] = useState<Json | null>(null);
  const load = useCallback(() => { call('/jobs?limit=100').then((r) => setJobs(r.jobs)).catch((e) => setErr(errText(e))); }, [setErr]);
  useEffect(load, [load]);
  return <div>
    <div className="row gap actions"><button className="btn" onClick={load}>Refresh</button></div>
    {jobs.length === 0 ? <p className="muted">No job yet.</p> :
      <div className="table-scroll"><table aria-label="job history"><thead><tr><th>Started</th><th>Job</th><th>State</th><th>Progress</th><th>Duration</th><th>Events</th><th /></tr></thead>
        <tbody>{jobs.map((j) => <tr key={j.job_id} className={sel?.job_id === j.job_id ? 'hl' : ''}>
          <td className="small">{new Date(j.started_at * 1000).toLocaleString()}</td><td><b>{j.title || j.kind}</b><div className="mono small muted">{j.kind} · {j.job_id}</div></td>
          <td><span className={`badge ${j.state === 'done' ? 'ok' : j.state === 'running' ? '' : 'warn'}`}>{j.state}</span></td>
          <td>{j.total == null ? '—' : j.kind === 'rpc-ingest' ? `${(j.done / 1e6).toFixed(1)} / ${(j.total / 1e6).toFixed(1)} MB` : `${j.done}/${j.total}`}</td><td>{secs(j.duration_s)}</td><td>{j.event_count}</td>
          <td><button className="btn sm" onClick={() => call(`/jobs/${j.job_id}`).then(setSel).catch((e) => setErr(errText(e)))}>Trace</button></td></tr>)}</tbody></table></div>}
    {sel && <Trace job={sel} />}
  </div>;
}

function Trace({ job }: { job: Json }) {
  const events: Json[] = job.events ?? [];
  const [i, setI] = useState(events.length - 1);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => { setI(events.length - 1); setPlaying(false); }, [job.job_id, events.length]);
  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => setI((x) => { if (x >= events.length - 1) { setPlaying(false); return x; } return x + 1; }), 350);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [playing, events.length]);
  const stages = useMemo(() => {
    const acc: Record<string, number[]> = {};
    for (const e of events) if (e.stages) for (const [k, v] of Object.entries(e.stages as Record<string, number>)) (acc[k] ??= []).push(v);
    return Object.entries(acc).map(([k, v]) => { const s = [...v].sort((a, b) => a - b); return { stage: k, n: v.length, median: s[Math.floor(s.length / 2)], max: s[s.length - 1], total: v.reduce((a, b) => a + b, 0) }; });
  }, [events]);
  const cur = events[i];
  return <div>
    <h3>Execution trace — {job.title || job.kind}</h3>
    {stages.length > 0 && <table aria-label="stage durations"><thead><tr><th>Stage (per run)</th><th>Runs</th><th>Median</th><th>Max</th><th>Total</th></tr></thead>
      <tbody>{stages.map((s) => <tr key={s.stage}><td>{s.stage}</td><td>{s.n}</td><td>{secs(s.median)}</td><td>{secs(s.max)}</td><td>{secs(s.total)}</td></tr>)}</tbody></table>}
    <div className="row gap actions">
      <button className="btn" aria-label={playing ? 'pause' : 'replay'} onClick={() => { if (i >= events.length - 1) setI(0); setPlaying(!playing); }}>{playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Pause' : 'Replay'}</button>
      <button className="btn" aria-label="next event" onClick={() => setI(Math.min(events.length - 1, i + 1))}><StepForward size={13} /></button>
      <input type="range" min={0} max={Math.max(0, events.length - 1)} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} aria-label="trace position" className="grow" />
      <span className="mono small">{i + 1}/{events.length}</span></div>
    {cur && <p className="note"><b>{cur.t.toFixed(2)} s · {cur.stage}</b> — {cur.message}{cur.stages && <span className="small muted"> · {Object.entries(cur.stages as Record<string, number>).map(([k, v]) => `${k} ${secs(v)}`).join(' · ')}</span>}</p>}
    <div className="table-scroll tall"><table aria-label="trace events"><tbody>{events.slice(0, i + 1).slice(-200).map((e, k) => <tr key={k} className={e === cur ? 'hl' : ''}><td className="mono small">{e.t.toFixed(2)} s</td><td>{e.stage}</td><td className="small">{e.message}</td></tr>)}</tbody></table></div>
  </div>;
}
