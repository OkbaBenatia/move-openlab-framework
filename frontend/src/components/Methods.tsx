import { useCallback, useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import { call, post, type Json, type Problem } from '../api/client';
import { tr } from '../i18n';
import { errText, sh } from './common';

export function Methods({ problem, setErr }: { problem: Problem; setErr: (s: string | null) => void }) {
  const [m, setM] = useState<Json | null>(null);
  const [last, setLast] = useState<Json | null>(null);
  const pid = problem.spec.problem_id;
  const load = useCallback(() => { call(`/problems/${pid}/methods`).then(setM).catch((e) => setErr(errText(e))); }, [pid, setErr]);
  useEffect(load, [load]);
  const register = async (plugin: string, origin = 'approved') => {
    setErr(null);
    try { setLast(await post(`/problems/${pid}/methods/register`, { plugin, origin })); load(); } catch (e) { setErr(tr('Registration refused: {error}', { error: errText(e) })); }
  };
  if (!m) return null;
  return <div>
    <p className="muted">{tr('Register a method from the approved plugin directory, then tick it in the workspace to run it.')}</p>
    <details className="small muted"><summary>{tr('How registration works')}</summary>
      <p>{tr('Interface')} <span className="mono">solve(instance, config) → {'{'}decisions, status, declared, metadata, diagnostics{'}'}</span>{tr('; decisions: {d}.', { d: tr(problem.decision_description) })} {tr("Registration reads the metadata without executing the plugin, checks problem and objective compatibility and the semantic version, pins the code hash, then runs a self-test with the installation's plugin isolation. A plugin changed after registration is refused.")} {tr('Create one with')} <span className="mono">move-openlab method new</span> {tr('and check it with')} <span className="mono">move-openlab method check</span> (docs/EXTENDING.md).</p></details>
    <h3>{tr('Built-in methods')}</h3>
    <table><tbody>{m.builtin.map((b: Json) => <tr key={b.method_id}><td><b>{b.name}</b></td><td className="mono">{b.method_id}@{b.version}</td><td>{tr(b.kind)}</td><td>{b.author}</td></tr>)}</tbody></table>
    <h3>{tr('Plugins in the approved directory')}</h3>
    <p className={`note ${m.plugin_status.isolation === 'sandbox' ? 'ok' : 'warn'}`}>
      {m.plugin_status.isolation === 'sandbox' && tr("Plugins run in a verified sandbox: no network, no access to other researchers' data or server secrets, private process view ({n} isolation checks passed).", { n: Object.values(m.isolation_checks ?? {}).filter(Boolean).length })}
      {m.plugin_status.isolation === 'process' && tr("Trusted-process mode: plugins run with the server's permissions — this is not a sandbox. Only administrators can register plugins.")}
      {!m.plugins_enabled && tr('Plugins are off on this installation: {reason}', { reason: m.plugin_status.reason })}
    </p>
    {!m.plugins_enabled ? null :
      <div className="table-scroll"><table aria-label={tr('plugins')}>
        <thead><tr><th>{tr('Plugin')}</th><th>{tr('Method')}</th><th>{tr('Version')}</th><th>{tr('Kind')}</th><th>{tr('Author')}</th><th>{tr('Compatible')}</th><th>{tr('Code SHA-256')}</th><th>{tr('Status')}</th><th /></tr></thead>
        <tbody>{m.plugins.map((p: Json) => <tr key={`${p.origin}:${p.plugin}`}>
          <td className="mono">{p.plugin}</td><td className="desc"><b>{p.metadata?.name ?? '—'}</b><div className="small muted">{p.metadata?.description}</div></td>
          <td className="mono">{p.metadata?.version}</td><td>{p.metadata?.kind && tr(p.metadata.kind)}</td><td>{p.metadata?.author}</td>
          <td>{p.compatible ? <span className="badge ok">{tr('compatible')}</span> : <span className="badge warn" title={p.incompatibility}>{tr('incompatible')}</span>}</td>
          <td className="mono small">{sh(p.code_sha256, 16)}</td><td>{p.registered ? <span className="badge ok">{tr('registered')}</span> : tr('not registered')}</td>
          <td>{!p.registered && p.compatible && m.can_register && <button className="btn sm" onClick={() => register(p.plugin, p.origin)}><Puzzle size={12} /> {tr('Register')}</button>}</td></tr>)}</tbody>
      </table></div>}
    {m.registered.length > 0 && <><h3>{tr('Registered in this workspace')}</h3>
      <table><thead><tr><th>{tr('Method')}</th><th>{tr('Version')}</th><th>{tr('Registered by')}</th><th>{tr('At')}</th><th>{tr('Code SHA-256')}</th><th>{tr('Self-test')}</th></tr></thead>
        <tbody>{m.registered.map((r: Json) => <tr key={r.method_id + r.version}><td><b>{r.name}</b> <span className="mono small">{r.method_id}</span></td>
          <td className="mono">{r.version}</td><td>{r.registered_by}</td><td className="small">{r.registered_at}</td><td className="mono small">{sh(r.code_sha256, 16)}</td>
          <td>{r.selftest.accepted ? <span className="badge ok">{tr('passed')}</span> : tr('failed')}</td></tr>)}</tbody></table></>}
    {last && <p className="note ok">{tr('Registered {name} {version}: compatible, code pinned, self-test accepted.', { name: last.name, version: last.version })}</p>}
  </div>;
}
