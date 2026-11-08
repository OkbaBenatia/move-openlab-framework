import { useCallback, useEffect, useState } from 'react';
import { call, type Json } from '../api/client';
import { TraceDrawer } from './TraceDrawer';
import { errText, secs } from './common';

/** Run history (persisted jobs of the signed-in user); Trace opens the execution timeline of a job. */
export function JobsPage({ setErr }: { setErr: (s: string | null) => void }) {
  const [jobs, setJobs] = useState<Json[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const load = useCallback(() => { call('/jobs?limit=100').then((r) => setJobs(r.jobs)).catch((e) => setErr(errText(e))); }, [setErr]);
  useEffect(load, [load]);
  return <div>
    <div className="row gap actions"><button className="btn" onClick={load}>Refresh</button></div>
    {jobs.length === 0 ? <p className="muted">No job yet.</p> :
      <div className="table-scroll"><table aria-label="job history"><thead><tr><th>Started</th><th>Job</th><th>State</th><th>Progress</th><th>Duration</th><th>Events</th><th /></tr></thead>
        <tbody>{jobs.map((j) => <tr key={j.job_id} className={sel === j.job_id ? 'hl' : ''}>
          <td className="small">{new Date(j.started_at * 1000).toLocaleString()}</td><td><b>{j.title || j.kind}</b><div className="mono small muted">{j.kind} · {j.job_id}</div></td>
          <td><span className={`badge ${j.state === 'done' ? 'ok' : j.state === 'running' ? '' : 'warn'}`}>{j.state}</span></td>
          <td>{j.total == null ? '—' : j.kind === 'rpc-ingest' ? `${(j.done / 1e6).toFixed(1)} / ${(j.total / 1e6).toFixed(1)} MB` : `${j.done}/${j.total}`}</td><td>{secs(j.duration_s)}</td><td>{j.event_count}</td>
          <td><button className="btn sm" onClick={() => setSel(j.job_id)}>Trace</button></td></tr>)}</tbody></table></div>}
    {sel && <TraceDrawer jobId={sel} onClose={() => setSel(null)} />}
  </div>;
}
