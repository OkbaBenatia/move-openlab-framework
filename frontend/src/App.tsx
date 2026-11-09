import { useContext, useEffect, useState } from 'react';
import { Database, FlaskConical, GraduationCap, LayoutDashboard, ListChecks, LogOut, Moon, Sun, Users } from 'lucide-react';
import { api } from './api/client';
import { APP_NAME, DEVELOPER } from './brand';
import { UserContext } from './context';
import { ErrorNote } from './components/common';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AdminPage } from './components/AdminPage';
import { ExperimentsSection } from './components/ExperimentsSection';
import { JobsPage } from './components/JobsPage';
import { GeoWorkbench } from './geo/GeoWorkbench';
import { CompareAB } from './lab/CompareAB';
import { Lab } from './lab/Lab';
import { useRoute, type Section } from './router';

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

/** Application shell: the map-first workspace is the main screen; data, experiment records, jobs, students (for
 *  supervising researchers) and administration are secondary sections. Every view has a URL (hash routes). */
export default function App() {
  const user = useContext(UserContext)!;
  const [theme, toggleTheme] = useTheme();
  const [route, go] = useRoute();
  const [err, setErr] = useState<string | null>(null);
  const [preset, setPreset] = useState<string[] | null>(null);
  const [version, setVersion] = useState('');
  useEffect(() => { api.info().then((i) => setVersion(i.version)).catch(() => { /* optional */ }); }, []);
  const supervises = user.role === 'admin' || (user.role === 'researcher' && !!user.can_supervise);
  const sections: [Section, string, typeof Database][] = [['workspace', 'Workspace', LayoutDashboard], ['data', 'Data', Database],
    ['experiments', 'Experiments', FlaskConical], ['jobs', 'Jobs', ListChecks],
    ...(user.role === 'researcher' && user.can_supervise ? [['students', 'Students', GraduationCap] as [Section, string, typeof Database]] : []),
    ...(user.role === 'admin' ? [['admin', 'Administration', Users] as [Section, string, typeof Database]] : [])];
  const open = (s: Section, arg = '') => { setErr(null); go(s, arg); };
  const full = route.section === 'workspace' || route.section === 'compare';
  return <div className={`app ${full ? 'app-lab' : ''}`}>
    <header className="topbar">
      <div className="brand"><img src="/brand/move-openlab-icon-64.png" alt="" className="logo-mark" width={26} height={26} /><b>{APP_NAME}</b></div>
      <nav className="sections" aria-label="sections">{sections.map(([s, label, Icon]) =>
        <a key={s} href={`#/${s}`} className={`tab ${route.section === s || (s === 'workspace' && route.section === 'compare') ? 'active' : ''}`} onClick={(e) => { e.preventDefault(); open(s); }}><Icon size={14} /> {label}</a>)}</nav>
      <div className="row gap">
        <span className="small muted user-name">{user.display}</span>
        <button className="btn icon" aria-label="toggle theme" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
        <button className="btn icon" aria-label="log out" onClick={() => api.logout().finally(() => window.location.replace('/login'))}><LogOut size={15} /></button>
      </div>
    </header>
    <ErrorBoundary resetKey={`${route.section}/${route.arg}`}>
    {route.section === 'workspace' && <Lab key="lab" cid={route.arg} go={go} />}
    {route.section === 'compare' && <CompareAB key={route.arg} arg={route.arg} go={(a, b) => go('compare', `${a}|${b}`)} />}
    {!full && <main className={route.section === 'experiments' ? '' : 'content'}>
      {route.section !== 'experiments' && <ErrorNote text={err} />}
      {route.section === 'data' && <GeoWorkbench initialView={route.arg} onView={(v) => go('data', v)} setErr={setErr}
        onUseInCampaign={(hashes) => { setPreset(hashes); open('experiments', 'new'); }} onRun={(cid) => go('workspace', cid)} />}
      {route.section === 'experiments' && <ExperimentsSection view={route.arg} go={(v) => open('experiments', v)} preset={preset} clearPreset={() => setPreset(null)} />}
      {route.section === 'jobs' && <JobsPage setErr={setErr} />}
      {route.section === 'students' && supervises && user.role !== 'admin' && <AdminPage me={user.username} supervisorMode setErr={setErr} />}
      {route.section === 'admin' && user.role === 'admin' && <AdminPage me={user.username} setErr={setErr} />}
    </main>}
    </ErrorBoundary>
    {!full && <footer className="foot small muted">{APP_NAME}{version ? ` · ${version}` : ''} · developed by {DEVELOPER}</footer>}
  </div>;
}
