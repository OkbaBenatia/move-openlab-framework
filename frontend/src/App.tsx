import { useCallback, useContext, useEffect, useState } from 'react';
import { ArrowLeft, FlaskConical, ListChecks, LogOut, Map as MapIcon, Moon, Plus, Puzzle, Sun, Upload, Users } from 'lucide-react';
import { api, call, type Json, type Problem } from './api/client';
import { APP_NAME, APP_SUBTITLE, DEVELOPER } from './brand';
import { UserContext } from './context';
import { ErrorNote, errText } from './components/common';
import { Workspace } from './components/Workspace';
import { NewCampaign } from './components/NewCampaign';
import { ImportBundle } from './components/ImportBundle';
import { Methods } from './components/Methods';
import { CampaignView } from './components/CampaignView';
import { Compare } from './components/Compare';
import { Reproducibility } from './components/Reproducibility';
import { Semantic } from './components/Semantic';
import { ThresholdReport } from './components/ThresholdReport';
import { JobsPage } from './components/JobsPage';
import { AdminPage } from './components/AdminPage';
import { GeoWorkbench } from './geo/GeoWorkbench';
import { Playback } from './geo/Playback';

type Section = 'experiments' | 'geo' | 'jobs' | 'admin';

function useTheme(): [string, () => void] {
  const [t, setT] = useState(document.documentElement.getAttribute('data-theme') ?? 'light');
  const toggle = () => {
    const n = t === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', n);
    try { localStorage.setItem('move-openlab-theme', n); } catch { /* storage unavailable */ }
    setT(n);
  };
  return [t, toggle];
}

export default function App() {
  const user = useContext(UserContext)!;
  const [theme, toggleTheme] = useTheme();
  const [info, setInfo] = useState<Json | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [pid, setPid] = useState<string>('');
  const [view, setView] = useState('list');
  const [list, setList] = useState<Json[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('experiments');
  const [preset, setPreset] = useState<string[] | null>(null);
  const problem = problems.find((p) => p.spec.problem_id === pid) ?? null;

  useEffect(() => {
    api.info().then(setInfo).catch((e) => setErr(errText(e)));
    api.problems().then((r) => { setProblems(r.problems); const syn = r.problems.find((p) => p.synthetic) ?? r.problems[0]; if (syn) setPid(syn.spec.problem_id); }).catch((e) => setErr(errText(e)));
  }, []);
  const reload = useCallback(() => {
    if (pid) call(`/campaigns?problem_id=${encodeURIComponent(pid)}`).then((r) => setList(r.campaigns)).catch((e) => setErr(errText(e)));
  }, [pid]);
  useEffect(reload, [reload]);
  const go = (v: string) => { setErr(null); setView(v); if (v === 'list') reload(); };
  const open = (s: Section) => { setErr(null); setSection(s); };
  const useScenarios = (hashes: string[]) => {
    const ride = problems.find((p) => p.scenario_parameters.fields.some((f) => f.type === 'scenario-library'));
    if (!ride) return;
    setPid(ride.spec.problem_id); setPreset(hashes); setSection('experiments'); setView('new');
  };
  const sections: [Section, string, typeof MapIcon][] = [['experiments', 'Experiments', FlaskConical], ['geo', 'Scenarios & maps', MapIcon], ['jobs', 'Jobs & traces', ListChecks],
    ...(user.role === 'admin' ? [['admin', 'Administration', Users] as [Section, string, typeof MapIcon]] : [])];

  return <div className="app">
    <header className="topbar">
      <div className="brand"><FlaskConical size={18} aria-hidden /><div><b>{APP_NAME}</b><span className="muted small"> · {APP_SUBTITLE}</span></div></div>
      <div className="row gap">
        {section === 'experiments' && problems.length > 1 && <select aria-label="problem" value={pid} onChange={(e) => { setPid(e.target.value); go('list'); }}>
          {problems.map((p) => <option key={p.spec.problem_id} value={p.spec.problem_id}>{p.title}</option>)}</select>}
        <span className="small muted">{user.display} · <span className="mono">{info?.installation_id ?? ''}</span></span>
        <button className="btn icon" aria-label="toggle theme" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
        <button className="btn icon" aria-label="log out" onClick={() => api.logout().finally(() => window.location.replace('/login'))}><LogOut size={15} /></button>
      </div>
    </header>
    <nav className="sections" aria-label="sections">{sections.map(([s, label, Icon]) =>
      <button key={s} className={`tab ${section === s ? 'active' : ''}`} onClick={() => open(s)}><Icon size={14} /> {label}</button>)}</nav>
    <main className="content">
      {section === 'geo' && <><ErrorNote text={err} /><GeoWorkbench setErr={setErr} onUseInCampaign={useScenarios} /></>}
      {section === 'jobs' && <><ErrorNote text={err} /><JobsPage setErr={setErr} /></>}
      {section === 'admin' && user.role === 'admin' && <><ErrorNote text={err} /><AdminPage me={user.username} setErr={setErr} /></>}
      {section === 'experiments' && <>
      {problem && <section className="problem-head">
        <h1>{problem.title} {problem.synthetic && <span className="badge warn">SYNTHETIC DATA</span>}</h1>
        <p className="muted">{problem.description}</p>
        <p className="small mono muted">{problem.spec.problem_id} · objective {problem.spec.objective_spec_id} · validator {problem.validator_version}</p>
      </section>}
      <nav className="row gap actions">
        {view !== 'list' && <button className="btn" onClick={() => go('list')}><ArrowLeft size={13} /> Workspace</button>}
        {view === 'list' && problem && <>
          <button className="btn primary" onClick={() => go('new')}><Plus size={13} /> New campaign</button>
          <button className="btn" onClick={() => go('import')}><Upload size={13} /> Import bundle</button>
          <button className="btn" onClick={() => go('methods')}><Puzzle size={13} /> Methods &amp; extensions</button>
        </>}
      </nav>
      <ErrorNote text={err} />
      {problem && view === 'list' && <Workspace list={list} onOpen={(id) => go(`c:${id}`)} />}
      {problem && view === 'new' && <NewCampaign key={problem.spec.problem_id + (preset ?? []).join()} problem={problem} preset={preset} onCreated={(id) => { setPreset(null); go(`c:${id}`); }} setErr={setErr} />}
      {problem && view === 'import' && <ImportBundle onImported={(id) => go(`c:${id}`)} setErr={setErr} />}
      {problem && view === 'methods' && <Methods problem={problem} setErr={setErr} />}
      {problem && view.startsWith('c:') && <CampaignView key={view + problem.spec.problem_id} id={view.slice(2)} problem={problem} go={go} setErr={setErr} onProblem={setPid} />}
      {problem && view.startsWith('cmp:') && <Compare id={view.slice(4)} problem={problem} setErr={setErr} />}
      {problem && view.startsWith('rep:') && <Reproducibility id={view.slice(4)} problem={problem} setErr={setErr} />}
      {problem && view.startsWith('sem:') && <Semantic ids={view.slice(4)} problem={problem} setErr={setErr} />}
      {problem && view.startsWith('thr:') && <ThresholdReport id={view.slice(4)} problem={problem} setErr={setErr} />}
      {problem && view.startsWith('play:') && <PlaybackLoader id={view.slice(5)} setErr={setErr} />}
      {!problem && !err && <p className="muted">Loading…</p>}
      </>}
    </main>
    <footer className="foot small muted">{APP_NAME} {info?.version ?? ''} · developed by {DEVELOPER}</footer>
  </div>;
}

function PlaybackLoader({ id, setErr }: { id: string; setErr: (s: string | null) => void }) {
  const [c, setC] = useState<Json | null>(null);
  useEffect(() => { call(`/campaigns/${id}`).then((r) => setC(r.campaign)).catch((e) => setErr(errText(e))); }, [id, setErr]);
  return c ? <><h2>Route playback — {c.title}</h2><Playback campaign={c} setErr={setErr} /></> : null;
}
