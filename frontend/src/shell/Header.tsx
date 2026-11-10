import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ChevronDown, CircleHelp, Compass, Database, EyeOff, FlaskConical, GraduationCap, KeyRound, Layers, LayoutGrid, ListChecks,
  LogOut, MapPin, Moon, Route, Shield, Sigma, Sun, UserRound } from 'lucide-react';
import { api, call, type Json, type User } from '../api/client';
import { t } from '../i18n';
import type { Section } from '../router';

export type Theme = 'light' | 'dark';

/** Appearance: light unless the user chose dark (stored per user on the server and in this browser for first paint). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'));
  const apply = useCallback((n: Theme) => {
    document.documentElement.setAttribute('data-theme', n);
    try { localStorage.setItem('move-openlab-theme', n); } catch { /* storage unavailable */ }
    set(n);
  }, []);
  useEffect(() => {                         // the server preference wins over this browser's copy
    call('/lab/state').then((s) => { if (s.preferences?.theme === 'dark' || s.preferences?.theme === 'light') apply(s.preferences.theme); }).catch(() => { /* optional */ });
  }, [apply]);
  const choose = useCallback((n: Theme) => { apply(n); call('/lab/preferences', { method: 'PUT', body: JSON.stringify({ theme: n }) }).catch(() => { /* preference only */ }); }, [apply]);
  return [theme, choose];
}

/** A small accessible menu: a button that opens a list; Escape or a click outside closes it. */
function Menu({ label, button, children, align = 'left', wide }: { label: string; button: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="menu-wrap" ref={ref}>
    <button className="navbtn" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>{button}</button>
    {open && <div className={`menu ${align} ${wide ? 'wide' : ''}`} role="menu" aria-label={label}>{children(() => setOpen(false))}</div>}
  </div>;
}

function Item({ icon, children, onClick, active, hint, tip }: { icon: ReactNode; children: ReactNode; onClick: () => void; active?: boolean; hint?: string; tip?: string }) {
  return <button role="menuitem" className={`mi ${active ? 'on' : ''}`} onClick={onClick} title={tip}>{icon}<span className="grow">{children}</span>{hint && <span className="hint">{hint}</span>}</button>;
}

const initials = (s: string) => s.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?';

/** Running and recent background jobs, one click away from any screen. */
function Jobs({ go }: { go: (s: Section, arg?: string) => void }) {
  const [jobs, setJobs] = useState<Json[]>([]);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const tick = () => call('/jobs?limit=6').then((r) => { if (!alive) return; setJobs(r.jobs); timer = setTimeout(tick, r.jobs.some((j: Json) => j.state === 'running') ? 2500 : 15000); })
      .catch(() => { if (alive) timer = setTimeout(tick, 20000); });
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  const running = jobs.filter((j) => j.state === 'running').length;
  return <Menu label={t('nav.jobs')} align="right" wide button={<><Activity size={17} />{running > 0 && <span className="count" aria-label={`${running} running`}>{running}</span>}</>}>
    {(close) => <>
      <div className="mh">{running ? `${running} running` : t('jobs.none')}</div>
      {jobs.length > 0 && <div className="mh">{t('jobs.recent')}</div>}
      {jobs.map((j) => <div key={j.job_id} className="job-line"><span className={`dot ${j.state}`} /><span className="grow ellipsis">{j.title || j.kind}</span>
        <span className="hint">{j.state === 'running' ? (j.total ? `${j.done}/${j.total}` : j.stage) : j.state}</span></div>)}
      <div className="msep" />
      <Item icon={<ListChecks size={15} />} onClick={() => { close(); go('jobs'); }}>{t('jobs.all')}</Item>
    </>}
  </Menu>;
}

/** Header: the approved full logo lockup, the Workspace, a compact Library for advanced management, jobs, help and the
 *  profile menu (account, students when allowed, administration for administrators, appearance, sign out). */
export function Header({ user, section, go, onTour, theme, setTheme }: {
  user: User; section: Section; go: (s: Section, arg?: string) => void; onTour: () => void; theme: Theme; setTheme: (t: Theme) => void;
}) {
  const role = user.role === 'admin' ? t('role.admin') : user.role === 'student' ? t('role.student') : t('role.researcher');
  const lib: [string, ReactNode, Section, string, string][] = [
    [t('lib.areas'), <MapPin size={15} />, 'data', 'areas', t('lib.areas.tip')], [t('lib.networks'), <Route size={15} />, 'data', 'areas', t('lib.networks.tip')],
    [t('lib.datasets'), <Database size={15} />, 'data', 'datasets', t('lib.datasets.tip')], [t('lib.scenarios'), <Layers size={15} />, 'data', 'library', t('lib.scenarios.tip')],
    [t('lib.experiments'), <FlaskConical size={15} />, 'experiments', '', t('lib.experiments.tip')], [t('lib.benchmarks'), <Sigma size={15} />, 'benchmarks', '', t('lib.benchmarks.tip')],
    [t('lib.jobs'), <ListChecks size={15} />, 'jobs', '', t('lib.jobs.tip')], [t('lib.hidden'), <EyeOff size={15} />, 'hidden', '', t('lib.hidden.tip')]];
  const inLibrary = ['data', 'experiments', 'benchmarks', 'jobs', 'hidden'].includes(section);
  return <header className="hdr">
    <a className="brand" href="#/workspace" onClick={(e) => { e.preventDefault(); go('workspace'); }} aria-label="MOVE OpenLab — workspace">
      <img className="lockup" src="/brand/move-openlab-logo-1024w-transparent.png" alt="MOVE OpenLab" width={139} height={40} /></a>
    <span className="hsep" />
    <button className={`navbtn ${section === 'workspace' || section === 'compare' ? 'on' : ''}`} onClick={() => go('workspace')}><LayoutGrid size={16} />{t('nav.workspace')}</button>
    <Menu label={t('nav.library')} button={<span className={`navlabel ${inLibrary ? 'on' : ''}`}><Database size={16} />{t('nav.library')}<ChevronDown size={14} /></span>}>
      {(close) => <><div className="mtip">{t('lib.intro')}</div>
        {lib.map(([label, icon, s, arg, tip]) => <Item key={label} icon={icon} tip={tip} onClick={() => { close(); go(s, arg); }}>{label}</Item>)}</>}
    </Menu>
    <span className="grow" />
    <Jobs go={go} />
    <Menu label={t('nav.help')} align="right" wide button={<CircleHelp size={17} />}>
      {(close) => <>
        <Item icon={<Compass size={15} />} hint={t('help.tourHint')} onClick={() => { close(); onTour(); }}>{t('help.tour')}</Item>
        <div className="msep" />
        <div className="mh">{t('help.terms')}</div>
        <dl className="gloss">{(['gloss.area', 'gloss.data', 'gloss.scenario', 'gloss.library', 'gloss.hidden'] as const).map((k) => {
          const [term, def] = t(k).split(' — ');
          return <div key={k}><dt>{term}</dt><dd>{def}</dd></div>; })}</dl>
      </>}
    </Menu>
    <Menu label="profile" align="right" button={<span className="userbtn"><span className="avatar">{initials(user.display || user.username)}</span>
      <span className="who"><b>{user.display}</b><span>{role}</span></span><ChevronDown size={14} /></span>}>
      {(close) => <>
        <div className="row gap menu-user"><span className="avatar lg">{initials(user.display || user.username)}</span><div><b>{user.display}</b><div className="small muted">{role}{user.can_supervise ? ' · can supervise students' : ''}</div></div></div>
        <div className="msep" />
        <Item icon={<UserRound size={15} />} active={section === 'account'} onClick={() => { close(); go('account'); }}>{t('menu.account')}</Item>
        {user.role === 'researcher' && user.can_supervise && <Item icon={<GraduationCap size={15} />} active={section === 'students'} onClick={() => { close(); go('students'); }}>{t('menu.students')}</Item>}
        {user.role === 'admin' && <Item icon={<Shield size={15} />} active={section === 'admin'} onClick={() => { close(); go('admin'); }}>{t('menu.admin')}</Item>}
        <div className="msep" />
        <div className="mh">{t('menu.appearance')}</div>
        <div className="seg menu-seg" role="group" aria-label={t('menu.appearance')}>
          <button className={theme === 'light' ? 'on' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun size={14} />{t('menu.light')}</button>
          <button className={theme === 'dark' ? 'on' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={14} />{t('menu.dark')}</button></div>
        <div className="msep" />
        <Item icon={<KeyRound size={15} />} onClick={() => { close(); window.location.assign('/change-password'); }}>Change password</Item>
        <Item icon={<LogOut size={15} />} onClick={() => { close(); api.logout().finally(() => window.location.replace('/login')); }}>{t('menu.signout')}</Item>
      </>}
    </Menu>
  </header>;
}
