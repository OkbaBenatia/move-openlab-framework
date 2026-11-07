import { useCallback, useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import { call, post, type Json, type Problem } from '../api/client';
import { errText, sh } from './common';

export function Methods({ problem, setErr }: { problem: Problem; setErr: (s: string | null) => void }) {
  const [m, setM] = useState<Json | null>(null);
  const [last, setLast] = useState<Json | null>(null);
  const pid = problem.spec.problem_id;
  const load = useCallback(() => { call(`/problems/${pid}/methods`).then(setM).catch((e) => setErr(errText(e))); }, [pid, setErr]);
  useEffect(load, [load]);
  const register = async (plugin: string) => {
    setErr(null);
    try { setLast(await post(`/problems/${pid}/methods/register`, { plugin })); load(); } catch (e) { setErr(`Registration refused: ${errText(e)}`); }
  };
  if (!m) return null;
  return <div>
    <p className="muted">Extension interface <span className="mono">solve(instance, config) → {'{'}decisions, status, declared, metadata, diagnostics{'}'}</span>.
      The operator places a plugin in the approved plugin directory; a researcher registers it here. Registration reads the metadata without executing the
      plugin, checks problem and objective compatibility and the semantic version, pins the code hash, then runs a self-test with the installation's plugin isolation.
      A plugin changed after registration is refused. Decisions: {problem.decision_description}.</p>
    <h3>Built-in methods</h3>
    <table><tbody>{m.builtin.map((b: Json) => <tr key={b.method_id}><td><b>{b.name}</b></td><td className="mono">{b.method_id}@{b.version}</td><td>{b.kind}</td><td>{b.author}</td></tr>)}</tbody></table>
    <h3>Plugins in the approved directory</h3>
    <p className={`note ${m.plugin_status.isolation === 'sandbox' ? 'ok' : 'warn'}`}>
      {m.plugin_status.isolation === 'sandbox' && <>Plugins run in a verified sandbox: no network, no access to other researchers' data or server secrets, private process view
        ({Object.values(m.isolation_checks ?? {}).filter(Boolean).length} isolation checks passed).</>}
      {m.plugin_status.isolation === 'process' && <>Trusted-process mode: plugins run with the server's permissions — this is not a sandbox. Only administrators can register plugins.</>}
      {!m.plugins_enabled && <>Plugins are off on this installation: {m.plugin_status.reason}</>}
    </p>
    {!m.plugins_enabled ? null :
      <div className="table-scroll"><table aria-label="plugins">
        <thead><tr><th>Plugin</th><th>Method</th><th>Version</th><th>Kind</th><th>Author</th><th>Compatible</th><th>Code SHA-256</th><th>Status</th><th /></tr></thead>
        <tbody>{m.plugins.map((p: Json) => <tr key={p.plugin}>
          <td className="mono">{p.plugin}</td><td className="desc"><b>{p.metadata?.name ?? '—'}</b><div className="small muted">{p.metadata?.description}</div></td>
          <td className="mono">{p.metadata?.version}</td><td>{p.metadata?.kind}</td><td>{p.metadata?.author}</td>
          <td>{p.compatible ? <span className="badge ok">compatible</span> : <span className="badge warn" title={p.incompatibility}>incompatible</span>}</td>
          <td className="mono small">{sh(p.code_sha256, 16)}</td><td>{p.registered ? <span className="badge ok">registered</span> : 'not registered'}</td>
          <td>{!p.registered && p.compatible && m.can_register && <button className="btn sm" onClick={() => register(p.plugin)}><Puzzle size={12} /> Register</button>}</td></tr>)}</tbody>
      </table></div>}
    {m.registered.length > 0 && <><h3>Registered in this workspace</h3>
      <table><thead><tr><th>Method</th><th>Version</th><th>Registered by</th><th>At</th><th>Code SHA-256</th><th>Self-test</th></tr></thead>
        <tbody>{m.registered.map((r: Json) => <tr key={r.method_id + r.version}><td><b>{r.name}</b> <span className="mono small">{r.method_id}</span></td>
          <td className="mono">{r.version}</td><td>{r.registered_by}</td><td className="small">{r.registered_at}</td><td className="mono small">{sh(r.code_sha256, 16)}</td>
          <td>{r.selftest.accepted ? <span className="badge ok">passed</span> : 'failed'}</td></tr>)}</tbody></table></>}
    {last && <p className="note ok">Registered {last.name} {last.version}: compatible, code pinned, self-test accepted.</p>}
  </div>;
}
