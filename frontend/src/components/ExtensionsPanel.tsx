import { useCallback, useEffect, useState } from 'react';
import { LockKeyhole, Puzzle } from 'lucide-react';
import { call, type Json } from '../api/client';
import { tr } from '../i18n';
import { errText } from './common';

/** The administrator's extension registry: the problem packages installed on this installation, the distribution
 *  that provides each, and — for a restricted package — the accounts granted access. Access is a per-account grant of
 *  this installation: no role implies it, and an installation without restricted packages has nothing to grant. */
export function ExtensionsPanel({ users, setErr }: { users: string[]; setErr: (s: string | null) => void }) {
  const [data, setData] = useState<Json | null>(null);
  const load = useCallback(() => call('/admin/extensions').then(setData).catch((e) => setErr(errText(e))), [setErr]);
  useEffect(() => { load(); }, [load]);
  const toggle = (p: Json, u: string) => {
    const cur: string[] = p.granted ?? [];
    const next = cur.includes(u) ? cur.filter((x) => x !== u) : [...cur, u];
    call(`/admin/extensions/${encodeURIComponent(p.problem_id)}/access`, { method: 'PUT', body: JSON.stringify({ usernames: next }) }).then(load).catch((e) => setErr(errText(e)));
  };
  if (!data) return <p className="small muted">{tr('Loading…')}</p>;
  const errs = Object.entries(data.load_errors ?? {});
  return <div className="extensions">
    <p className="small muted">{tr('Problem packages are installed with the application (entry-point group {g}); nothing is installed from this page. Open packages are available to every account. A restricted package is visible only to the accounts ticked here; the administrator role alone gives no access to it.', { g: data.group })}</p>
    <div className="card table-card"><table className="compact" aria-label={tr('installed problem packages')}>
      <thead><tr><th>{tr('Problem')}</th><th>{tr('Provided by')}</th><th>{tr('Specification')}</th><th>{tr('Access')}</th></tr></thead>
      <tbody>{(data.problems as Json[]).map((p) => <tr key={p.problem_id}>
        <td><span className="row gap">{p.restricted ? <LockKeyhole size={14} /> : <Puzzle size={14} />}<b>{tr(p.title)}</b></span><span className="tiny muted mono block">{p.problem_id}</span></td>
        <td className="small">{p.distribution ?? '—'} {p.version ?? ''}</td>
        <td className="small">{p.specification} · {tr('validator')} {p.validator}</td>
        <td>{p.restricted ? <div className="row gap wrap" role="group" aria-label={`${tr('accounts granted')} ${p.title}`}>
          <span className="badge warn">{tr('Restricted')}</span>
          {users.map((u) => <label key={u} className="row small grant"><input type="checkbox" checked={(p.granted ?? []).includes(u)} onChange={() => toggle(p, u)} aria-label={`${tr('grant')} ${u}`} /> {u}</label>)}</div>
          : <span className="badge ok">{tr('Open to every account')}</span>}</td></tr>)}</tbody></table></div>
    {errs.length > 0 && <div className="note small"><b>{tr('Packages that failed to load')}</b><ul>{errs.map(([k, v]) => <li key={k}><span className="mono">{k}</span>: {String(v)}</li>)}</ul></div>}
    <p className="small muted">{tr('Method and metric plug-ins')}: {data.plugins.enabled ? tr('enabled ({m})', { m: data.plugins.mode }) : tr('disabled')}{data.plugins.reason ? ` — ${data.plugins.reason}` : ''}</p>
  </div>;
}
