import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ChevronLeft, LockKeyhole } from 'lucide-react';
import { call, type Json } from './api/client';
import { ANY_CONTEXT, contextOf, nextInResearch, requestContext, setRequestContext } from './api/context';
import { APP_NAME, DEVELOPER } from './brand';
import { UserContext } from './context';
import { ErrorNote } from './components/common';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AdminPage } from './components/AdminPage';
import { ExperimentsSection } from './components/ExperimentsSection';
import { JobsPage } from './components/JobsPage';
import { GeoWorkbench } from './geo/GeoWorkbench';
import { languageChosen, setLanguage, t, tr } from './i18n';
import { ResearchPage } from './shell/ResearchPage';
import { CompareAB } from './lab/CompareAB';
import { CompareMethods } from './lab/CompareMethods';
import { Lab, OPEN_WIZARD } from './lab/Lab';
import { NEW } from './lab/TopBar';
import type { ExpItem, Study } from './lab/api';
import { useRoute, type Section } from './router';
import { AccountPage, BenchmarksPage, HiddenPage } from './shell/Pages';
import { Header, useTheme } from './shell/Header';

const titles = (): Partial<Record<Section, string>> => ({
  data: tr('Data setup'), experiments: t('lib.experiments'), jobs: t('lib.jobs'), students: t('menu.students'), admin: t('menu.admin'),
  account: t('menu.account'), hidden: t('lib.hidden'), benchmarks: t('lib.benchmarks'), research: tr('Private Research'),
});

/** Application shell. The Workspace is the main screen; advanced management sits in the Library menu and account
 *  matters (account, students, administration, appearance) in the profile menu. Every view has a URL (hash routes). */
export default function App() {
  const user = useContext(UserContext)!;
  const [theme, setTheme] = useTheme();
  const [route, go] = useRoute();
  const [err, setErr] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  // restricted problems granted to this account on this installation (none on an installation without such packages);
  // null until the server answered: nothing is shown before the context of the address is known
  const [restricted, setRestricted] = useState<{ problem_id: string; title: string }[] | null>(null);
  // which problem each record belongs to: decides the context of a bookmarked address and of Back / Forward
  const [recordProblem, setRecordProblem] = useState<Record<string, string>>({});
  // the private-research context of this tab (entered with Private Research, left with a confirmed Exit to Workspace)
  const [inResearch, setInResearch] = useState(requestContext() === 'research');
  const [leaving, setLeaving] = useState(false);
  const [epoch, setEpoch] = useState(0);                    // a confirmed exit starts a fresh public Workspace
  const exiting = useRef(false);
  const asked = useRef(new Set<string>());
  // one-shot request from Help: consumed by the workspace once, so returning to the workspace never reopens the tour
  const [tourRequest, setTourRequest] = useState(0);
  const loadRecords = useCallback(() => call<{ campaigns: Json[] }>('/campaigns', { headers: ANY_CONTEXT })
    .then((r) => setRecordProblem(Object.fromEntries(r.campaigns.map((c) => [c.campaign_id, c.problem_id])))).catch(() => { /* the context then follows the tab's own state */ }), []);
  useEffect(() => {
    call('/info', { headers: ANY_CONTEXT }).then(async (i) => {
      setVersion(i.version);
      const rs = (i.problems ?? []).filter((p: { restricted?: boolean }) => p.restricted);
      if (rs.length) await loadRecords();
      setRestricted(rs);
    }).catch(() => setRestricted([]));
  }, [loadRecords]);
  // the account's default language applies unless a language was chosen in this session
  useEffect(() => { if (!languageChosen()) fetch('/api/lab/state', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((s) => { const l = s?.preferences?.language; if (l === 'fr' || l === 'en') setLanguage(l, false); }).catch(() => { /* optional */ }); }, []);
  // the scenario wizard opens over the workspace only: the old Data › Generate address leads there
  useEffect(() => {
    if (route.section === 'data' && route.arg === 'generate') { try { sessionStorage.setItem(OPEN_WIZARD, '1'); } catch { /* */ } go('workspace', '', true); }
  }, [route, go]);
  const open = (s: Section, arg = '') => { setErr(null); go(s, arg); };
  const full = route.section === 'workspace' || route.section === 'compare' || route.section === 'methods';
  const supervises = user.role === 'researcher' && !!user.can_supervise;
  // the context follows what is shown: a record of a restricted problem is only ever shown in the research context, a
  // public record only in the public one; an address without a record keeps the context of the tab
  const restrictedIds = (restricted ?? []).map((p) => p.problem_id);
  const shownRecord = full ? route.arg.split('|')[0] : '';
  const { research, known } = contextOf({ section: route.section, record: shownRecord, recordProblem, restrictedIds, inResearch });
  if (restricted !== null) setRequestContext(research ? 'research' : 'public');     // before any child sends a request
  useEffect(() => {
    if (restricted === null) return;
    const entering = route.section === 'research' || known === 'private';
    setInResearch((prev) => nextInResearch(prev, { section: route.section, known, exiting: exiting.current, hasRestricted: restrictedIds.length > 0 }));
    if (!entering) exiting.current = false;
  }, [route, known, restricted]);                                           // eslint-disable-line react-hooks/exhaustive-deps
  // a record made in this session (a run, an import) is not in the list yet: read the list again, once per record
  useEffect(() => {
    if (!restrictedIds.length || !shownRecord || shownRecord === NEW || shownRecord in recordProblem || asked.current.has(shownRecord)) return;
    asked.current.add(shownRecord); loadRecords();
  }, [shownRecord, recordProblem, loadRecords]);                             // eslint-disable-line react-hooks/exhaustive-deps
  // Private Research opens the saved study of the restricted problem on its featured scenario (else the overview)
  const enterResearch = async () => {
    setErr(null);
    try {
      const { studies } = await call<{ studies: Study[] }>('/lab/studies', { headers: ANY_CONTEXT });
      const first = studies.find((x) => restrictedIds.includes(x.problem_id ?? '') && x.members.length)?.members[0]?.campaign_id;
      await loadRecords();
      go(first ? 'workspace' : 'research', first ?? '');
    } catch { go('research'); }
  };
  // a confirmed exit: the public Workspace starts again on a public experiment (the demonstration when there is one);
  // nothing private is kept on screen, nothing is deleted or changed
  const exitResearch = async () => {
    setLeaving(false);
    let target = '';
    try {
      const { experiments } = await call<{ experiments: ExpItem[] }>('/lab/experiments', { headers: { 'X-Move-Context': 'public' } });
      const pick = experiments.find((x) => x.demo && x.kind === 'baseline' && !x.hidden) ?? experiments.filter((x) => !x.hidden).at(-1) ?? experiments.at(-1);
      if (pick) { target = pick.campaign_id; setRecordProblem((m) => ({ ...m, [pick.campaign_id]: pick.problem_id })); }
    } catch { /* the Workspace then opens on its own default */ }
    exiting.current = true; setInResearch(false); setEpoch((k) => k + 1); setErr(null);
    go('workspace', target);
  };
  const toWorkspace = () => (research ? setLeaving(true) : open('workspace'));
  useEffect(() => {
    if (!leaving) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setLeaving(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [leaving]);
  return <div className={`app ${full ? 'app-lab' : ''}`}>
    <Header user={user} section={route.section} go={open} theme={theme} setTheme={setTheme} research={restrictedIds.length > 0}
      inResearch={research} onWorkspace={toWorkspace} onResearch={enterResearch}
      onTour={() => { if (route.section !== 'workspace') go('workspace'); setTourRequest((k) => k + 1); }} />
    {research && <div className="ctx-bar" role="status" aria-label={tr('Private Research context')}>
      <LockKeyhole size={14} /><b>{tr('Private Research')}</b><span className="small ctx-note">{tr('restricted records, shown to your account only')}</span><span className="grow" />
      {route.section !== 'research' && <button className="btn link small" onClick={() => go('research')}>{tr('Studies and history')}</button>}
      <button className="btn sm" onClick={() => setLeaving(true)}>{tr('Exit to Workspace')}</button></div>}
    {restricted !== null && <ErrorBoundary resetKey={`${route.section}/${route.arg}`}>
    {route.section === 'workspace' && <Lab key={research ? 'lab-research' : `lab-${epoch}`} cid={route.arg} go={go} tourRequest={tourRequest} onTourShown={() => setTourRequest(0)}
      research={research} restrictedIds={restrictedIds} />}
    {route.section === 'methods' && <CompareMethods key={route.arg.split('|')[0]} arg={route.arg} go={(r) => go('methods', r, true)} back={() => go('workspace', route.arg.split('|')[0])} onExperiments={(id) => go('compare', id)} />}
    {route.section === 'compare' && <CompareAB key={route.arg} arg={route.arg} go={(r) => go('compare', r)} back={() => go('workspace', route.arg.split('|')[0])} onMethods={(id) => go('methods', id)} />}
    {!full && <main className={route.section === 'experiments' ? 'page' : 'content page'}>
      <div className="page-head row gap"><button className="btn ghost sm" onClick={() => go('workspace')}><ChevronLeft size={14} />{research ? tr('Private Research workspace') : t('nav.workspace')}</button>
        <h1 className="grow">{titles()[route.section] ?? ''}</h1></div>
      {route.section !== 'experiments' && <ErrorNote text={err} />}
      {route.section === 'data' && route.arg !== 'generate' && <GeoWorkbench initialView={route.arg} onView={(v) => go('data', v)} setErr={setErr}
        onOpenWorkspace={() => go('workspace')} onRun={(cid) => go('workspace', cid)} />}
      {route.section === 'experiments' && <ExperimentsSection view={route.arg} go={(v) => open('experiments', v)} preset={null} clearPreset={() => { /* scenarios from the Library open in the workspace */ }} />}
      {route.section === 'jobs' && <JobsPage setErr={setErr} />}
      {route.section === 'students' && supervises && <AdminPage me={user.username} supervisorMode setErr={setErr} />}
      {route.section === 'admin' && user.role === 'admin' && <AdminPage me={user.username} setErr={setErr} />}
      {(route.section === 'admin' && user.role !== 'admin') || (route.section === 'students' && !supervises) ? <p className="muted">{tr('This page is not available for your account.')}</p> : null}
      {route.section === 'account' && <AccountPage user={user} theme={theme} setTheme={setTheme} />}
      {route.section === 'hidden' && <HiddenPage setErr={setErr} />}
      {route.section === 'benchmarks' && <BenchmarksPage go={go} />}
      {route.section === 'research' && <ResearchPage go={go} setErr={setErr} />}
    </main>}
    </ErrorBoundary>}
    {leaving && <div className="overlay center" role="dialog" aria-modal="true" aria-label={tr('Exit Private Research')} onClick={() => setLeaving(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Exit Private Research and return to the public Workspace?')}</h2>
        <p className="small muted">{tr('The public Workspace opens on a public experiment. Private selections, map layers and results leave the screen; nothing is deleted or changed.')}</p>
        <div className="row gap"><span className="grow" /><button className="btn" onClick={() => setLeaving(false)}>{tr('Cancel')}</button>
          <button className="btn primary" autoFocus onClick={exitResearch}>{tr('Exit to Workspace')}</button></div></div></div>}
    {!full && <footer className="foot small muted">{APP_NAME} · {version || t('build.dev')} · {tr('developed by {name}', { name: DEVELOPER })}</footer>}
  </div>;
}
