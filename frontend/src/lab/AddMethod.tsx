import { Fragment, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Ban, Box, CheckCircle2, Circle, Code2, Copy, Download, FileArchive, Info, Lock, Play, Puzzle, Search, Shield, ShieldCheck, Terminal, Upload, X, XCircle } from 'lucide-react';
import { api, call, post, type Json } from '../api/client';
import { errText, sh } from '../components/common';
import { tr } from '../i18n';
import { type Block, type CatalogItem, type TemplateForm, KINDS, cliCheck, cliCopy, cliNew, cliTest, cliZip, displayName, groupCatalog, itemKey, methodId,
  nameProblem, reasonOf, registerBlock, slug, stepOfError, zipPrecheck } from './pluginCatalog';

type Choice = 'builtin' | 'register' | 'template';
/** One step of a check, as shown: ok, failed (with the reason) or not reached yet. */
interface Step { id: string; label: string; ok: boolean | null; detail?: string }
interface UploadState { pid: string; file: string; steps: Step[]; upload?: Json; unchanged?: boolean }

const GROUP_TITLE = { example: 'Ready-made examples', installation: 'Provided on this installation', uploaded: 'Uploaded by you' } as const;
const STEP_LABEL: Record<string, string> = { archive: 'ZIP checked', metadata: 'Metadata (read without running the code)', registration: 'Not registered yet', 'self-test': 'Self-test in the sandbox' };

/** Plain words for why a plug-in cannot be registered (the server's own reason is shown under Details). */
function blockText(b: Block, p: CatalogItem, problemId: string): string {
  const id = `${p.metadata?.method_id ?? p.plugin}@${p.metadata?.version ?? '?'}`;
  switch (b) {
    case 'off': return tr('Plug-ins are off on this installation.');
    case 'not-allowed': return tr('Trusted-process mode: administrators only.');
    case 'registered': return tr('Already registered: {id}. Registering the same method id and version again is refused — change the version to register changed code.', { id });
    case 'changed': return tr('Registered version differs from the file: {id} is pinned to other code. It is not replaced — change the version to register the new code.', { id });
    case 'taken': return tr('{id} is already registered from another plug-in — change the version.', { id });
    case 'incompatible': return p.metadata?.problem_id && p.metadata.problem_id !== problemId ? tr('Written for a different problem — not for this experiment') : tr('Does not meet the method contract for this problem');
    default: return '';
  }
}

function stateLine(p: CatalogItem, problemId: string): string {
  if (p.state === 'registered') return tr('Registered · code pinned {digest}', { digest: sh(p.code_sha256, 12) });
  if (p.state === 'available') return tr('Available, not registered');
  return blockText(registerBlock(p, true, true), p, problemId);
}

function Steps({ steps }: { steps: Step[] }) {
  return <ol className="plain amsteps" aria-label={tr('check steps')}>{steps.map((s) => <li key={s.id} className={`row gap ${s.ok === false ? 'bad-text' : ''}`}>
    {s.ok === true ? <CheckCircle2 size={14} className="ok-text" /> : s.ok === false ? <XCircle size={14} /> : <Circle size={14} className="muted" />}
    <span className="grow"><b>{s.label}</b>{s.ok === true ? ` — ${tr('ok')}` : s.ok === false ? ` — ${tr('failed')}` : ` — ${tr('not run yet')}`}{s.detail && <span className="small muted block mono amdetail">{s.detail}</span>}</span></li>)}</ol>;
}

const serverSteps = (steps: Json[] = []): Step[] => steps.map((s) => ({ id: s.step, label: tr(STEP_LABEL[s.step] ?? s.step), ok: !!s.ok, detail: s.detail }));

/** "+ Add method": use a built-in method; register a plug-in from the catalogue (ready-made examples shipped with the
 *  framework, plug-ins provided on this installation, plug-ins this account uploaded) — checked statically, then the
 *  sandboxed self-test, code pinned; or create one from the template (the same template as `move-openlab method new`),
 *  complete solve(), upload it, register it. The experiment keeps the scenario, objective, constraints, validator,
 *  metrics, baseline and CO₂ semantics; a method only proposes decisions, which are validated independently. */
export function AddMethod({ problemId, onClose, onChanged, setErr, onRun, done = [], runNote }: { problemId: string; onClose: () => void; onChanged: () => void; setErr: (s: string | null) => void;
  /** run one method on the open experiment's frozen scenarios (absent: nothing open to run on); done: methods it already ran */
  onRun?: (methodId: string, version: string) => void; done?: string[]; runNote?: string }) {
  const [m, setM] = useState<Json | null>(null);
  const [choice, setChoice] = useState<Choice>('register');
  const [sel, setSel] = useState('');
  const [checks, setChecks] = useState<Record<string, Json>>({});
  const [last, setLast] = useState<Json | null>(null);
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState('');
  // Create from template
  const [problems, setProblems] = useState<{ problem_id: string; title: string }[]>([]);
  const [tplPid, setTplPid] = useState(problemId);
  const [info, setInfo] = useState<Json | null>(null);
  const [form, setForm] = useState<TemplateForm>({ name: 'my_method', display_name: '', author: '', kind: 'heuristic', description: '' });
  const [made, setMade] = useState<{ file: string; bytes: number } | null>(null);
  // the upload pipeline, shared by "Register my method" and "Create from template"
  const [up, setUp] = useState<UploadState | null>(null);
  const load = useCallback(() => { call(`/problems/${problemId}/methods`).then(setM).catch((e) => setErr(errText(e))); }, [problemId, setErr]);
  useEffect(load, [load]);
  useEffect(() => { if (choice === 'template' && !problems.length) api.info().then((i) => setProblems(i.problems ?? [])).catch(() => { /* the open problem only */ }); }, [choice, problems.length]);
  useEffect(() => { if (choice === 'template') call(`/problems/${tplPid}/methods/template`).then(setInfo).catch(() => setInfo(null)); }, [choice, tplPid]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const register = async (plugin: string, origin: string, pid = problemId) => {
    setNote(null); setBusy(`reg:${origin}:${plugin}`);
    try {
      const r = await post(`/problems/${pid}/methods/register`, { plugin, origin });
      setLast({ ...r, pid }); setChecks({}); load(); onChanged();          // an earlier check result is out of date
    } catch (e) { setNote({ bad: true, text: tr('Registration refused: {reason}', { reason: errText(e).split('\n')[0].slice(0, 240) }) }); } finally { setBusy(''); }
  };
  const check = async (p: CatalogItem) => {
    setBusy(`chk:${itemKey(p)}`);
    try { const r = await post(`/problems/${problemId}/methods/check`, { plugin: p.plugin, origin: p.origin }); setChecks((c) => ({ ...c, [itemKey(p)]: r })); }
    catch (e) { setChecks((c) => ({ ...c, [itemKey(p)]: { ok: false, steps: [{ step: 'metadata', ok: false, detail: errText(e) }] } })); } finally { setBusy(''); }
  };
  const uploadZip = async (file: File, pid: string) => {
    setNote(null); setLast(null);
    const base: Step[] = [{ id: 'archive', label: tr(STEP_LABEL.archive), ok: null }, { id: 'metadata', label: tr(STEP_LABEL.metadata), ok: null }, { id: 'self-test', label: tr(STEP_LABEL['self-test']), ok: null }];
    const pre = zipPrecheck(file, m?.upload_limits?.zip_bytes ?? 2_000_000);
    if (pre) { setUp({ pid, file: file.name, steps: [{ ...base[0], ok: false, detail: pre === 'not-zip' ? tr('Choose a .zip file.') : pre === 'empty' ? tr('The file is empty.') : tr('The ZIP is larger than the limit.') }, base[1], base[2]] }); return; }
    setBusy('upload'); setUp({ pid, file: file.name, steps: base });
    const fd = new FormData(); fd.append('file', file, file.name);
    try {
      const r = await call(`/problems/${pid}/methods/upload`, { method: 'POST', body: fd });
      const first = serverSteps(r.steps);
      setUp({ pid, file: file.name, steps: [...first, { ...base[2], detail: tr('Running in the sandbox…') }], upload: r.upload, unchanged: r.upload.unchanged });
      load();
      const c = await post(`/problems/${pid}/methods/check`, { plugin: r.upload.plugin, origin: 'uploaded', selftest: true });
      setUp({ pid, file: file.name, steps: [...first, ...serverSteps(c.steps).filter((s) => s.id !== 'metadata')], upload: r.upload, unchanged: r.upload.unchanged });
    } catch (e) {
      const msg = errText(e), at = stepOfError(msg);
      setUp((u) => (u?.upload ? { ...u, steps: [...u.steps.filter((s) => s.id !== 'self-test'), { ...base[2], ok: false, detail: msg }] }
        : { pid, file: file.name, steps: at === 'metadata' ? [{ ...base[0], ok: true }, { ...base[1], ok: false, detail: reasonOf(msg) }, base[2]] : [{ ...base[0], ok: false, detail: reasonOf(msg) }, base[1], base[2]] }));
    } finally { setBusy(''); }
  };
  const generate = async () => {
    setNote(null); setBusy('generate');
    try {
      const r = await fetch(`/api/problems/${tplPid}/methods/template`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!r.ok) { let d: unknown = `${r.status}`; try { d = (await r.json()).detail ?? d; } catch { /* not JSON */ } throw new Error(typeof d === 'string' ? d : JSON.stringify(d)); }
      const blob = await r.blob(), file = `${form.name}.zip`;
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setMade({ file, bytes: blob.size });
    } catch (e) { setNote({ bad: true, text: tr('The template was not generated: {reason}', { reason: errText(e) }) }); } finally { setBusy(''); }
  };

  const copy = (id: string, text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }).catch(() => { /* clipboard unavailable */ }); };
  const Cmd = ({ id, text }: { id: string; text: string }) => <div className="row gap cmd"><code className="mono grow">{text}</code>
    <button className="btn sm" type="button" onClick={() => copy(id, text)} aria-label={tr('copy command')}><Copy size={12} /> {copied === id ? tr('Copied') : tr('Copy')}</button></div>;
  const opt = (c: Choice, icon: React.ReactNode, title: string, sub: string) => <button className={`choice ${choice === c ? 'on' : ''}`} aria-pressed={choice === c} onClick={() => setChoice(c)}>
    <span className="choice-ico">{icon}</span><span><b>{title}</b><span>{sub}</span></span></button>;
  const runBtn = (id: string | undefined, ver: string | undefined, primary = false, pid = problemId) => onRun && id && ver && pid === problemId && (done.includes(`${id}@${ver}`)
    ? <span className="badge ok" title={tr('Already run in this experiment')}>{tr('Run')}</span>
    : <button className={`btn sm ${primary ? 'primary' : ''}`} onClick={() => onRun(id, ver)} title={runNote}><Play size={12} /> {tr('Run with this method')}</button>);
  const flow = [tr('Frozen experiment'), tr('Your method'), tr('Independent validator'), tr('Same metrics and CO₂'), tr('Compare')];
  const canUpload = !!m?.can_upload, canReg = !!m?.can_register;
  const nameErr = nameProblem(form.name);
  const setF = (k: keyof TemplateForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const lastNote = last && <div className="note ok small row gap wrap"><span className="grow">{tr('Registered {name} {version}: code pinned, self-test accepted in the sandbox. It is now in the Methods list.', { name: last.name, version: last.version })}</span>{runBtn(last.method_id, last.version, true, last.pid)}</div>;

  const uploadBlock = (pid: string, compact = false) => {
    const ready = !!up?.upload && up.steps.every((s) => s.ok === true);
    const registered = !!up?.upload && last?.method_id === up.upload.method_id && last?.version === up.upload.version;
    return <div className="amupload">
      {!canUpload ? <p className="note warn small">{m?.plugins_enabled ? tr('Uploads need the verified sandbox; this installation runs plug-ins in trusted-process mode (administrators only, folder plug-ins only).') : tr('Plug-ins are off on this installation: {reason}', { reason: m?.plugin_status?.reason ?? '' })}</p> : <>
        <label className={`btn amfile ${busy === 'upload' ? 'busy' : ''}`}><Upload size={14} /> {busy === 'upload' ? tr('Checking…') : tr('Upload the completed plug-in (.zip)')}
          <input type="file" accept=".zip,application/zip" aria-label={tr('plug-in ZIP to upload')} disabled={busy === 'upload'}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadZip(f, pid); }} /></label>
        {!compact && <p className="tiny muted">{tr('One directory <name>/ with plugin.py and small text files only (test_plugin.py, README.md, LICENSE). Checked before anything is stored and nothing is executed; stored in your workspace only, visible to no other account; runs only in the verified sandbox.')}</p>}</>}
      {up && up.pid === pid && <div className="card amcard" aria-label={tr('upload result')}>
        <p className="small row gap"><FileArchive size={14} /> <span className="mono grow">{up.file}</span>{up.upload && <span className="tiny muted mono" title={up.upload.code_sha256}>{tr('code')} {sh(up.upload.code_sha256, 12)}</span>}</p>
        {up.unchanged && <p className="tiny muted">{tr('Identical to a plug-in you already uploaded: nothing was changed.')}</p>}
        <Steps steps={up.steps} />
        {up.upload && <div className="row gap wrap">
          {registered ? <span className="badge ok">{tr('Registered')}</span> : <button className="btn primary sm" disabled={!ready || !!busy} onClick={() => register(up.upload!.plugin, 'uploaded', pid)}
            title={ready ? undefined : tr('Register needs every check above to pass.')}><Puzzle size={12} /> {busy === `reg:uploaded:${up.upload.plugin}` ? tr('Checking…') : tr('Register')}</button>}
          {registered && runBtn(up.upload.method_id, up.upload.version, true, pid)}</div>}
      </div>}
    </div>;
  };

  const inspector = (p: CatalogItem) => {
    const md = p.metadata ?? {}, b = registerBlock(p, !!m?.plugins_enabled, canReg), k = itemKey(p), chk = checks[k];
    return <div className="aminspect" aria-label={tr('details of {name}', { name: displayName(p) })}>
      {md.description && <p className="small">{md.description}</p>}
      <dl className="amdl small">
        <dt>{tr('Version')}</dt><dd className="mono">{md.version ?? '—'}</dd>
        <dt>{tr('Kind')}</dt><dd>{md.kind ? tr(md.kind) : '—'}</dd>
        <dt>{tr('Author')}</dt><dd>{md.author ?? '—'}</dd>
        <dt>{tr('Problem')}</dt><dd className="mono">{md.problem_id ?? '—'}</dd>
        <dt>{tr('Objective')}</dt><dd className="mono">{md.objective_spec_id ?? '—'}</dd>
        <dt>{tr('Method id')}</dt><dd className="mono">{md.method_id ?? '—'}</dd>
        <dt>{tr('Where')}</dt><dd>{tr(GROUP_TITLE[p.catalog])} · <span className="mono">{p.plugin}</span></dd>
        <dt>{tr('Code SHA-256')}</dt><dd className="mono" title={p.code_sha256}>{sh(p.code_sha256, 16)}</dd>
        {p.registered_code_sha256 && p.registered_code_sha256 !== p.code_sha256 && <><dt>{tr('Registered code')}</dt><dd className="mono bad-text" title={p.registered_code_sha256}>{sh(p.registered_code_sha256, 16)}</dd></>}
      </dl>
      {p.incompatibility && <p className="tiny muted mono">{p.incompatibility}</p>}
      <div className="row gap wrap">
        <button className="btn sm" disabled={!!busy} onClick={() => check(p)}><Search size={12} /> {busy === `chk:${k}` ? tr('Checking…') : tr('Check compatibility')}</button>
        <button className="btn primary sm" disabled={!!b || !!busy} onClick={() => register(p.plugin, p.origin)} title={b ? blockText(b, p, problemId) : undefined}><Puzzle size={12} /> {busy === `reg:${k}` ? tr('Checking…') : tr('Register')}</button>
        {p.state === 'registered' && runBtn(md.method_id, md.version, true)}
      </div>
      {b && b !== 'incompatible' && <p className="small row gap amwhy" role="note"><Info size={13} /><span className="grow">{blockText(b, p, problemId)}</span></p>}
      {chk && <><p className="tiny muted">{tr('Static check — nothing was executed.')}</p><Steps steps={serverSteps(chk.steps)} /></>}
    </div>;
  };

  const row = (p: CatalogItem) => {
    const md = p.metadata ?? {}, k = itemKey(p), open = sel === k;
    const icon = p.state === 'registered' || p.state === 'available' ? <CheckCircle2 size={17} className="ok-text" /> : p.state === 'incompatible' ? <Ban size={17} className="muted" /> : <AlertTriangle size={17} className="warn-text" />;
    return <Fragment key={k}><div className={`row gap plug ${open ? 'on' : ''}`}>
      {icon}
      <span className="grow"><b>{displayName(p)}</b> <span className="muted small">{md.version}</span>
        <span className="small muted block">{[md.author, md.kind && tr(md.kind)].filter(Boolean).join(' · ')}{p.code_sha256 && <> · <span className="mono" title={p.code_sha256}>{sh(p.code_sha256, 8)}</span></>}</span>
        <span className="small muted block">{stateLine(p, problemId)}</span></span>
      {p.state === 'available' && canReg && <button className="btn primary sm" disabled={!!busy} onClick={() => register(p.plugin, p.origin)}><Puzzle size={12} /> {busy === `reg:${k}` ? tr('Checking…') : tr('Register')}</button>}
      {p.state === 'incompatible' && <span className="badge">{tr('Not compatible')}</span>}
      {(p.state === 'changed' || p.state === 'taken') && <span className="badge warn">{tr('Changed')}</span>}
      {p.state === 'registered' && <span className="badge ok">{tr('Registered')}</span>}
      {p.state === 'registered' && runBtn(md.method_id, md.version, true)}
      <button className="btn sm ghost" aria-expanded={open} aria-label={tr('details of {name}', { name: displayName(p) })} onClick={() => setSel(open ? '' : k)}><Info size={12} /> {tr('Details')}</button>
    </div>{open && inspector(p)}</Fragment>;
  };

  return <div className="overlay top" role="dialog" aria-label={tr('add a method')} onClick={onClose}>
    <div className="drawer addm" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><h2 className="grow">{tr('Add a method')}</h2><button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={16} /></button></div>
      {!m ? <p className="muted small">{tr('Loading…')}</p> : <>
        <div className="choices3">{opt('builtin', <Box size={18} />, tr('Built-in methods'), tr('Ready to use'))}{opt('register', <Puzzle size={18} />, tr('Register my method'), tr('Ready-made, provided or uploaded'))}{opt('template', <Code2 size={18} />, tr('Create from template'), tr('Write, upload, register'))}</div>
        {note && <p className={`note small ${note.bad ? 'bad' : 'ok'}`} role={note.bad ? 'alert' : 'status'}>{note.text}</p>}

        {choice === 'builtin' && <section className="sec"><h3>{tr('Built-in methods')}</h3>
          <ul className="plain">{m.builtin.filter((b: Json) => !b.archived).map((b: Json) => <li key={b.method_id} className="row gap wrap"><CheckCircle2 size={14} className="ok-text" /><b>{b.name}</b><span className="small muted grow">· {tr(String(b.kind))} · {b.version}{b.author ? ` · ${b.author}` : ''}</span>{runBtn(b.method_id, b.version)}</li>)}</ul>
          <p className="small muted">{onRun ? runNote : tr('Tick a method in the Methods list, then Run.')}</p></section>}

        {choice === 'register' && <section className="sec"><h3>{tr('Plug-ins you can register for this problem')}</h3>
          {!m.plugins_enabled ? <p className="note warn small">{tr('Plug-ins are off on this installation: {reason}', { reason: m.plugin_status.reason })}</p> : <>
            <p className={`small ${m.plugin_status.isolation === 'sandbox' ? 'muted' : 'bad-text'}`}>{m.plugin_status.isolation === 'sandbox' ? tr('Each registered method runs in the verified sandbox; its code is pinned by its digest.') : tr('Trusted-process mode: administrators only.')}</p>
            <p className="tiny muted">{tr('Select Details to inspect a plug-in and check its compatibility (nothing is executed); Register runs its self-test in the sandbox and pins its code.')}</p>
            {groupCatalog((m.plugins ?? []) as CatalogItem[]).map((g) => <div key={g.catalog} className="amgroup"><h4 className="small">{tr(GROUP_TITLE[g.catalog])} <span className="muted">({g.items.length})</span></h4>
              {g.items.length > 0 ? <div className="card">{g.items.map(row)}</div>
                : <p className="tiny muted">{tr('None yet — create one from the template, then upload it here.')}</p>}
              {g.catalog === 'uploaded' && uploadBlock(problemId, true)}</div>)}
            {lastNote}</>}</section>}

        {choice === 'template' && <section className="sec amtpl"><h3>{tr('Create from the template')}</h3>
          <p className="note small"><Info size={13} /> {tr('The platform does not write your algorithm or train a model: you implement solve(instance, config) yourself. The platform checks it, runs it in the sandbox and validates every solution independently.')}</p>
          <ol className="amtsteps">
            <li><b>{tr('Problem')}</b>
              {problems.length > 1 ? <select value={tplPid} onChange={(e) => { setTplPid(e.target.value); setUp(null); }} aria-label={tr('problem')}>{problems.map((p) => <option key={p.problem_id} value={p.problem_id}>{p.title} ({p.problem_id})</option>)}</select>
                : <span className="mono small"> {tplPid}</span>}
              {tplPid !== problemId && <p className="tiny muted">{tr('Not the problem of the open experiment: you can register it, and run it on an experiment of that problem.')}</p>}</li>
            <li><b>{tr('Describe your method')}</b>
              <div className="amform">
                <label className="field">{tr('Method name')} <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} onBlur={() => setForm({ ...form, name: slug(form.name) })} aria-label={tr('method name')} aria-invalid={!!nameErr} /></label>
                <label className="field">{tr('Display name')} <input value={form.display_name} onChange={setF('display_name')} placeholder={form.name.replace(/_/g, ' ')} aria-label={tr('display name')} maxLength={80} /></label>
                <label className="field">{tr('Author')} <input value={form.author} onChange={setF('author')} aria-label={tr('author')} maxLength={80} /></label>
                <label className="field">{tr('Kind')} <select value={form.kind} onChange={setF('kind')} aria-label={tr('kind')}>{KINDS.map((k) => <option key={k} value={k}>{tr(k)}</option>)}</select></label>
                <label className="field amwide">{tr('Short description')} <input value={form.description} onChange={setF('description')} aria-label={tr('short description')} maxLength={300} placeholder={tr('The rule your method follows, in one sentence.')} /></label>
              </div>
              <p className={`tiny ${nameErr ? 'bad-text' : 'muted'}`}>{nameErr ? tr('Name: 3 to 41 characters, lowercase letters, digits and _, starting with a letter.') : tr('Method id {id}, version 0.1.0.', { id: methodId(form.name) })}</p></li>
            <li><b>{tr('Generate and download')}</b>
              <div className="row gap wrap"><button className="btn primary sm" disabled={!!nameErr || !!busy} onClick={generate}><Download size={12} /> {busy === 'generate' ? tr('Generating…') : tr('Generate the template (.zip)')}</button>
                {made && <span className="small ok-text" role="status">{tr('Downloaded {file} ({bytes} bytes): plugin.py, test_plugin.py, README.md', { file: made.file, bytes: made.bytes })}</span>}</div></li>
            <li><b>{tr('Implement solve(instance, config) in plugin.py')}</b>
              {info ? <dl className="amdl small"><dt>{tr('instance')}</dt><dd className="mono">{(info.instance_keys ?? []).join(', ')}</dd>
                <dt>{tr('return')}</dt><dd><span className="mono">decisions</span>: {tr(String(info.decisions))}; <span className="mono">status</span> (HEURISTIC…)</dd>
                <dt>{tr('objective')}</dt><dd className="mono">{info.objective_spec_id}</dd></dl> : <p className="tiny muted">{tr('Loading…')}</p>}
              <p className="tiny muted">{tr('As generated, solve() returns no decision: the result is valid but serves no one, so it passes the self-test without being a method. Implement your rule before you register it. README.md explains how to test and check it.')}</p></li>
            <li><b>{tr('Upload the completed plug-in')}</b>{uploadBlock(tplPid)}</li>
            <li><b>{tr('Register, run, compare')}</b>
              <p className="tiny muted">{tr('Register runs the self-test in the sandbox and pins the code. Run with this method runs it on the frozen scenarios of the open experiment; every solution is validated independently. Then Compare shows it next to the other methods. A valid solution is not an optimal one.')}</p>
              {lastNote}</li>
          </ol></section>}

        <section className="sec"><h3>{tr('How your method is evaluated')}</h3>
          <div className="flow5">{flow.map((x, i) => <span key={x} className="row gap"><span className={`flow-node ${i === 1 ? 'on' : ''}`}>{x}</span>{i < flow.length - 1 && <ArrowRight size={13} className="muted" />}</span>)}</div>
          <ul className="plain small soft"><li><Lock size={12} /> {tr('Same scenarios, constraints and objective as the other methods (the frozen experiment)')}</li>
            <li><Shield size={12} /> {tr('Isolated sandbox: no network, no access to your other files')}</li><li><ShieldCheck size={12} /> {tr('Every solution is checked by the validator, not by your code')}</li></ul></section>
        <details className="sec small"><summary><Terminal size={13} /> {tr('Developer details')}</summary>
          <p className="small muted">{tr('Each step has a command-line equivalent (the same template and the same checks):')}</p>
          <p className="small muted">{tr('Generate the template:')}</p><Cmd id="new" text={cliNew({ ...form, name: nameErr ? slug(form.name) : form.name }, tplPid)} />
          <p className="small muted">{tr('Test solve() locally:')}</p><Cmd id="test" text={cliTest(`plugins/${form.name}`)} />
          <p className="small muted">{tr('Metadata check and sandboxed self-test (what Register does):')}</p><Cmd id="check" text={cliCheck(`plugins/${form.name}`)} />
          <p className="small muted">{tr('Run on every scenario of an exported experiment, validated and compared (Run with this method, then Compare):')}</p><Cmd id="bundle" text={cliCheck(`plugins/${form.name}`, 'move-openlab-sample-montbeliard.zip')} />
          <p className="small muted">{tr('Make the ZIP to upload:')}</p><Cmd id="zip" text={`cd plugins && ${cliZip(form.name)}`} />
          <p className="small muted">{tr('Operator alternative to uploading: copy the directory into the approved folder.')}</p><Cmd id="copy" text={cliCopy(`plugins/${form.name}`)} />
          <p className="small muted">{tr('A working example is in {path}; the contract is documented in docs/EXTENDING.md.', { path: 'plugins/my_greedy_matching/' })}</p>
          {((m.plugins ?? []) as CatalogItem[]).filter((p) => p.incompatibility).map((p) => <p key={itemKey(p)} className="tiny muted mono">{p.plugin}: {p.incompatibility}</p>)}</details>
      </>}
    </div>
  </div>;
}
