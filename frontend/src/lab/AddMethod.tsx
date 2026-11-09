import { useCallback, useEffect, useState } from 'react';
import { Copy, Puzzle, X } from 'lucide-react';
import { call, post, type Json } from '../api/client';
import { errText, sh } from '../components/common';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'my_method';

/** "+ Add method": use a built-in method, register a plugin from the approved directory, create one from the
 *  template, or test it against an imported experiment — without leaving the workflow. */
export function AddMethod({ problemId, onClose, onChanged, setErr }: { problemId: string; onClose: () => void; onChanged: () => void; setErr: (s: string | null) => void }) {
  const [m, setM] = useState<Json | null>(null);
  const [name, setName] = useState('my_method');
  const [last, setLast] = useState<Json | null>(null);
  const [copied, setCopied] = useState('');
  const load = useCallback(() => { call(`/problems/${problemId}/methods`).then(setM).catch((e) => setErr(errText(e))); }, [problemId, setErr]);
  useEffect(load, [load]);
  const register = async (plugin: string) => {
    setErr(null);
    try { setLast(await post(`/problems/${problemId}/methods/register`, { plugin })); load(); onChanged(); } catch (e) { setErr(`Registration refused: ${errText(e)}`); }
  };
  const copy = (id: string, text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }).catch(() => { /* clipboard unavailable */ }); };
  const cmdNew = `move-openlab method new ${slug(name)} --problem ${problemId} --dir plugins`;
  const cmdCheck = `move-openlab method check plugins/${slug(name)} --bundle <exported-experiment>.zip`;
  const Cmd = ({ id, text }: { id: string; text: string }) => <div className="row gap cmd"><code className="mono grow">{text}</code>
    <button className="btn sm" type="button" onClick={() => copy(id, text)} aria-label="copy command"><Copy size={12} /> {copied === id ? 'Copied' : 'Copy'}</button></div>;
  return <div className="overlay" role="dialog" aria-label="add method" onClick={onClose}>
    <div className="drawer" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2>Add method</h2><span className="grow" /><button className="btn icon" aria-label="close" onClick={onClose}><X size={15} /></button></div>
      {!m ? <p className="muted small">Loading…</p> : <>
        <section><h3>Use a built-in method</h3>
          <ul className="small">{m.builtin.map((b: Json) => <li key={b.method_id}><b>{b.name}</b> <span className="muted">· {b.kind}</span></li>)}</ul>
          <p className="small muted">Tick it in the Method list, then Run.</p></section>
        <section><h3>Register a plugin</h3>
          {!m.plugins_enabled ? <p className="small muted">Plugins are off on this installation: {m.plugin_status.reason}</p> : <>
            <p className={`small ${m.plugin_status.isolation === 'sandbox' ? 'muted' : 'bad'}`}>{m.plugin_status.isolation === 'sandbox' ? 'Runs in the verified sandbox.' : 'Trusted-process mode: administrators only.'}</p>
            {m.plugins.length === 0 ? <p className="small muted">No plugin in the approved directory yet.</p> :
              <ul className="people" aria-label="plugins">{m.plugins.map((p: Json) => <li key={p.plugin}><div className="row gap plug">
                <span className="grow"><b>{p.metadata?.name ?? p.plugin}</b> <span className="mono small muted">{p.plugin} · {p.metadata?.version}</span>
                  <div className="small muted">{p.registered ? `registered · code ${sh(p.code_sha256, 12)}` : p.compatible ? 'compatible' : `incompatible: ${p.incompatibility}`}</div></span>
                {!p.registered && p.compatible && m.can_register && <button className="btn sm" onClick={() => register(p.plugin)}><Puzzle size={12} /> Register</button>}
                {p.registered && <span className="badge ok">registered</span>}</div></li>)}</ul>}
            {last && <p className="note ok small">Registered {last.name} {last.version}: code pinned, self-test accepted. It is now in the Method list.</p>}</>}</section>
        <section><h3>Create from the template</h3>
          <label className="small">Name <input value={name} onChange={(e) => setName(e.target.value)} aria-label="method name" /></label>
          <Cmd id="new" text={cmdNew} />
          <p className="small muted">Implement <span className="mono">solve(instance, config)</span> in <span className="mono">plugins/{slug(name)}/plugin.py</span>; the experiment keeps the scenario, objective, validator, metrics and CO₂ settings — the method proposes decisions only.</p></section>
        <section><h3>Test against an imported experiment</h3>
          <Cmd id="check" text={cmdCheck} />
          <p className="small muted">Export the experiment (Export), run the check, then Register above and tick the method.</p></section>
      </>}
    </div>
  </div>;
}
