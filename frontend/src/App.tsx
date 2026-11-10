import { useContext, useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { api } from './api/client';
import { APP_NAME, DEVELOPER } from './brand';
import { UserContext } from './context';
import { ErrorNote } from './components/common';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AdminPage } from './components/AdminPage';
import { ExperimentsSection } from './components/ExperimentsSection';
import { JobsPage } from './components/JobsPage';
import { GeoWorkbench } from './geo/GeoWorkbench';
import { t } from './i18n';
import { CompareAB } from './lab/CompareAB';
import { CompareMethods } from './lab/CompareMethods';
import { Lab, OPEN_WIZARD } from './lab/Lab';
import { useRoute, type Section } from './router';
import { AccountPage, BenchmarksPage, HiddenPage } from './shell/Pages';
import { Header, useTheme } from './shell/Header';

const TITLES: Partial<Record<Section, string>> = {
  data: t('nav.library'), experiments: t('lib.experiments'), jobs: t('lib.jobs'), students: t('menu.students'), admin: t('menu.admin'),
  account: t('menu.account'), hidden: t('lib.hidden'), benchmarks: t('lib.benchmarks'),
};

/** Application shell. The Workspace is the main screen; advanced management sits in the Library menu and account
 *  matters (account, students, administration, appearance) in the profile menu. Every view has a URL (hash routes). */
export default function App() {
  const user = useContext(UserContext)!;
  const [theme, setTheme] = useTheme();
  const [route, go] = useRoute();
  const [err, setErr] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  // one-shot request from Help: consumed by the workspace once, so returning to the workspace never reopens the tour
  const [tourRequest, setTourRequest] = useState(0);
  useEffect(() => { api.info().then((i) => setVersion(i.version)).catch(() => { /* optional */ }); }, []);
  // the scenario wizard opens over the workspace only: the old Data › Generate address leads there
  useEffect(() => {
    if (route.section === 'data' && route.arg === 'generate') { try { sessionStorage.setItem(OPEN_WIZARD, '1'); } catch { /* */ } go('workspace', '', true); }
  }, [route, go]);
  const open = (s: Section, arg = '') => { setErr(null); go(s, arg); };
  const full = route.section === 'workspace' || route.section === 'compare' || route.section === 'methods';
  const supervises = user.role === 'researcher' && !!user.can_supervise;
  return <div className={`app ${full ? 'app-lab' : ''}`}>
    <Header user={user} section={route.section} go={open} theme={theme} setTheme={setTheme}
      onTour={() => { if (route.section !== 'workspace') go('workspace'); setTourRequest((k) => k + 1); }} />
    <ErrorBoundary resetKey={`${route.section}/${route.arg}`}>
    {route.section === 'workspace' && <Lab key="lab" cid={route.arg} go={go} tourRequest={tourRequest} onTourShown={() => setTourRequest(0)} />}
    {route.section === 'methods' && <CompareMethods key={route.arg.split('|')[0]} arg={route.arg} go={(r) => go('methods', r, true)} back={() => go('workspace', route.arg.split('|')[0])} />}
    {route.section === 'compare' && <CompareAB key={route.arg} arg={route.arg} go={(r) => go('compare', r)} back={() => go('workspace', route.arg.split('|')[0])} />}
    {!full && <main className={route.section === 'experiments' ? 'page' : 'content page'}>
      <div className="page-head row gap"><button className="btn ghost sm" onClick={() => go('workspace')}><ChevronLeft size={14} />{t('nav.workspace')}</button>
        <h1 className="grow">{TITLES[route.section] ?? ''}</h1></div>
      {route.section !== 'experiments' && <ErrorNote text={err} />}
      {route.section === 'data' && route.arg !== 'generate' && <GeoWorkbench initialView={route.arg} onView={(v) => go('data', v)} setErr={setErr}
        onOpenWorkspace={() => go('workspace')} onRun={(cid) => go('workspace', cid)} />}
      {route.section === 'experiments' && <ExperimentsSection view={route.arg} go={(v) => open('experiments', v)} preset={null} clearPreset={() => { /* scenarios from the Library open in the workspace */ }} />}
      {route.section === 'jobs' && <JobsPage setErr={setErr} />}
      {route.section === 'students' && supervises && <AdminPage me={user.username} supervisorMode setErr={setErr} />}
      {route.section === 'admin' && user.role === 'admin' && <AdminPage me={user.username} setErr={setErr} />}
      {(route.section === 'admin' && user.role !== 'admin') || (route.section === 'students' && !supervises) ? <p className="muted">This page is not available for your account.</p> : null}
      {route.section === 'account' && <AccountPage user={user} theme={theme} setTheme={setTheme} />}
      {route.section === 'hidden' && <HiddenPage setErr={setErr} />}
      {route.section === 'benchmarks' && <BenchmarksPage go={go} />}
    </main>}
    </ErrorBoundary>
    {!full && <footer className="foot small muted">{APP_NAME} · {version || t('build.dev')} · developed by {DEVELOPER}</footer>}
  </div>;
}
