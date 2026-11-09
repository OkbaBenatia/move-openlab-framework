import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Ban, Box, CheckCircle2, Code2, Copy, Lock, Puzzle, Shield, ShieldCheck, Terminal, X } from 'lucide-react';
import { call, post, type Json } from '../api/client';
import { errText, sh } from '../components/common';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'my_method';
type Choice = 'builtin' | 'register' | 'template';

/** Plain words for why a plugin cannot run here (the technical reason stays under Developer details). */
const whyNot = (p: Json, problemId: string) => (p.metadata?.problem_id && p.metadata.problem_id !== problemId
  ? 'Written for a different problem — not for this experiment' : 'Does not meet the method contract for this problem');

/** "+ Add method": use a built-in method, register my method (a plug-in from the approved folder, run in the verified
 *  sandbox), or create one from the template. The experiment keeps the scenario, objective, constraints, validator,
 *  metrics, baseline and CO₂ semantics; a method only proposes decisions. */
export function AddMethod({ problemId, onClose, onChanged, setErr }: { problemId: string; onClose: () => void; onChanged: () => void; setErr: (s: string | null) => void }) {
  const [m, setM] = useState<Json | null>(null);
  const [choice, setChoice] = useState<Choice>('register');
  const [name, setName] = useState('my_method');
  const [last, setLast] = useState<Json | null>(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(() => { call(`/problems/${problemId}/methods`).then(setM).catch((e) => setErr(errText(e))); }, [problemId, setErr]);
  useEffect(load, [load]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const register = async (plugin: string) => {
    setErr(null); setBusy(plugin);
    try { setLast(await post(`/problems/${problemId}/methods/register`, { plugin })); load(); onChanged(); }
    catch (e) { setErr(`Registration refused: ${errText(e).split('\n')[0].slice(0, 200)}`); } finally { setBusy(''); }
  };
  const copy = (id: string, text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }).catch(() => { /* clipboard unavailable */ }); };
  const Cmd = ({ id, text }: { id: string; text: string }) => <div className="row gap cmd"><code className="mono grow">{text}</code>
    <button className="btn sm" type="button" onClick={() => copy(id, text)} aria-label="copy command"><Copy size={12} /> {copied === id ? 'Copied' : 'Copy'}</button></div>;
  const opt = (c: Choice, icon: React.ReactNode, title: string, sub: string) => <button className={`choice ${choice === c ? 'on' : ''}`} aria-pressed={choice === c} onClick={() => setChoice(c)}>
    <span className="choice-ico">{icon}</span><span><b>{title}</b><span>{sub}</span></span></button>;
  const flow = ['Frozen experiment', 'Your method', 'Independent validator', 'Same metrics and CO₂', 'Compare'];
  return <div className="overlay top" role="dialog" aria-label="add a method" onClick={onClose}>
    <div className="drawer addm" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2 className="grow">Add a method</h2><button className="btn icon ghost" aria-label="close" onClick={onClose}><X size={16} /></button></div>
      {!m ? <p className="muted small">Loading…</p> : <>
        <div className="choices3">{opt('builtin', <Box size={18} />, 'Built-in methods', 'Ready to use')}{opt('register', <Puzzle size={18} />, 'Register my method', 'A plug-in in the approved folder')}{opt('template', <Code2 size={18} />, 'Create from template', 'Start a new plug-in')}</div>
        {choice === 'builtin' && <section className="sec"><h3>Built-in methods</h3>
          <ul className="plain">{m.builtin.map((b: Json) => <li key={b.method_id} className="row gap"><CheckCircle2 size={14} className="ok-text" /><b>{b.name}</b><span className="small muted">· {b.kind} · {b.version}</span></li>)}</ul>
          <p className="small muted">Tick a method in the Methods list, then Run.</p></section>}
        {choice === 'register' && <section className="sec"><h3>Plug-ins in the approved folder</h3>
          {!m.plugins_enabled ? <p className="note warn small">Plug-ins are off on this installation: {m.plugin_status.reason}</p> : <>
            <p className={`small ${m.plugin_status.isolation === 'sandbox' ? 'muted' : 'bad-text'}`}>{m.plugin_status.isolation === 'sandbox' ? 'Each registered method runs in the verified sandbox; its code is pinned by its digest.' : 'Trusted-process mode: administrators only.'}</p>
            {m.plugins.length === 0 ? <p className="small muted">No plug-in in the approved folder yet — create one from the template.</p> :
              <div className="card">{m.plugins.map((p: Json) => <div key={p.plugin} className="row gap plug">
                {p.compatible ? <CheckCircle2 size={17} className="ok-text" /> : <Ban size={17} className="muted" />}
                <span className="grow"><b>{p.metadata?.name ?? p.plugin}</b> <span className="muted small">{p.metadata?.version}</span>
                  <span className="small muted block">{p.registered ? `Registered · code pinned ${sh(p.code_sha256, 12)}` : p.compatible ? 'Written for this problem · fits this experiment' : whyNot(p, problemId)}</span></span>
                {!p.registered && p.compatible && m.can_register && <button className="btn primary sm" disabled={!!busy} onClick={() => register(p.plugin)}><Puzzle size={12} /> {busy === p.plugin ? 'Checking…' : 'Register'}</button>}
                {!p.registered && !p.compatible && <span className="badge">Not compatible</span>}
                {p.registered && <span className="badge ok">Registered</span>}</div>)}</div>}
            {last && <p className="note ok small">Registered {last.name} {last.version}: code pinned, self-test accepted in the sandbox. It is now in the Methods list.</p>}</>}</section>}
        {choice === 'template' && <section className="sec"><h3>Create from the template</h3>
          <label className="field">Method name <input value={name} onChange={(e) => setName(e.target.value)} aria-label="method name" /></label>
          <ol className="small steps-list"><li>Create the plug-in from the template (command under Developer details).</li><li>Implement <span className="mono">solve(instance, config)</span>: return the decisions; nothing else.</li>
            <li>Run its self-test and check it against an exported experiment.</li><li>Back here: Register, tick it, Run — then Compare.</li></ol></section>}
        <section className="sec"><h3>How your method is evaluated</h3>
          <div className="flow5">{flow.map((x, i) => <span key={x} className="row gap"><span className={`flow-node ${i === 1 ? 'on' : ''}`}>{x}</span>{i < flow.length - 1 && <ArrowRight size={13} className="muted" />}</span>)}</div>
          <ul className="plain small soft"><li><Lock size={12} /> Same scenarios, constraints and objective as the other methods (the frozen experiment)</li>
            <li><Shield size={12} /> Isolated sandbox: no network, no access to your other files</li><li><ShieldCheck size={12} /> Every solution is checked by the validator, not by your code</li></ul></section>
        <details className="sec small"><summary><Terminal size={13} /> Developer details</summary>
          <p className="small muted">Create from the template:</p><Cmd id="new" text={`move-openlab method new ${slug(name)} --problem ${problemId} --dir plugins`} />
          <p className="small muted">Check it against an exported experiment (for example the sample bundle):</p><Cmd id="check" text={`move-openlab method check plugins/${slug(name)} --bundle move-openlab-sample-montbeliard.zip`} />
          <p className="small muted">A working example is in <span className="mono">plugins/nearest_pickup/</span>; the contract is documented in docs/EXTENDING.md.</p>
          {m.plugins.filter((p: Json) => !p.compatible).map((p: Json) => <p key={p.plugin} className="tiny muted mono">{p.plugin}: {p.incompatibility}</p>)}</details>
      </>}
    </div>
  </div>;
}
