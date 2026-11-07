import { useEffect, useState } from 'react';
import { CircleStop, RotateCcw } from 'lucide-react';
import { call, post, type Json } from '../api/client';
import { errText } from './common';

/** Live status of one background job: stage, progress, last events, cancellation. Calls `onFinished` once. */
export function JobProgress({ job, onFinished, setErr, unit }: { job: Json; onFinished: (j: Json) => void; setErr: (s: string | null) => void; unit?: 'bytes' | 'runs' }) {
  const [j, setJ] = useState<Json>(job);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const n = await call(`/jobs/${job.job_id}`);
        if (!alive) return;
        setJ(n);
        if (n.state === 'running') setTimeout(tick, 600); else onFinished(n);
      } catch (e) { if (alive) setErr(errText(e)); }
    };
    const t = setTimeout(tick, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [job.job_id]);
  const pct = j.total ? Math.min(100, Math.round((100 * j.done) / j.total)) : null;
  const fmt = (v: number) => (unit === 'bytes' ? `${(v / 1e6).toFixed(1)} MB` : String(v));
  const last = (j.events ?? []).slice(-3);
  return <div className="note job" data-state={j.state}>
    <div className="row gap"><RotateCcw size={12} className={j.state === 'running' ? 'spin' : ''} /><b>{j.title || j.kind}</b>
      <span className="badge">{j.state}</span><span className="small muted">stage {j.stage}</span>
      {j.state === 'running' && <button className="btn sm" onClick={() => post(`/jobs/${j.job_id}/cancel`).then(setJ).catch((e) => setErr(errText(e)))}><CircleStop size={12} /> Cancel</button>}</div>
    {j.total != null && <div className="progress" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct ?? 0}%` }} /></div>}
    <div className="small muted">{j.total != null ? `${fmt(j.done)} / ${fmt(j.total)}` : ''} {last.map((e: Json, i: number) => <div key={i}>{e.t.toFixed(1)} s · {e.message}</div>)}</div>
    {j.error && <div className="small" role="alert">{j.error}</div>}
  </div>;
}
