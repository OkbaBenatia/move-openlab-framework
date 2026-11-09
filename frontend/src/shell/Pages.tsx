import { useCallback, useEffect, useState } from 'react';
import { Eye, KeyRound, LogOut, Moon, Sigma, Sun } from 'lucide-react';
import { api, type Json, type User } from '../api/client';
import { errText } from '../components/common';
import { geo } from '../geo/api';
import { t } from '../i18n';
import { lab } from '../lab/api';
import type { Section } from '../router';
import type { Theme } from './Header';

/** My account: who I am here, my password, my appearance. */
export function AccountPage({ user, theme, setTheme }: { user: User; theme: Theme; setTheme: (t: Theme) => void }) {
  const role = user.role === 'admin' ? t('role.admin') : user.role === 'student' ? t('role.student') : t('role.researcher');
  return <div className="col-page">
    <section className="card pad"><dl className="facts">
      <dt>Name</dt><dd>{user.display}</dd><dt>Username</dt><dd className="mono">{user.username}</dd>
      <dt>Role</dt><dd>{role}{user.role === 'researcher' ? (user.can_supervise ? ' · can supervise students' : '') : ''}</dd>
      <dt>Session</dt><dd>until {new Date(user.expires_at * 1000).toLocaleString()}</dd></dl>
      <div className="row gap"><button className="btn" onClick={() => window.location.assign('/change-password')}><KeyRound size={14} /> Change password</button>
        <button className="btn" onClick={() => api.logout().finally(() => window.location.replace('/login'))}><LogOut size={14} /> {t('menu.signout')}</button></div></section>
    <section className="card pad"><h3>{t('menu.appearance')}</h3>
      <div className="seg" role="group" aria-label={t('menu.appearance')}>
        <button className={theme === 'light' ? 'on' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun size={14} />{t('menu.light')}</button>
        <button className={theme === 'dark' ? 'on' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={14} />{t('menu.dark')}</button></div>
      <p className="small muted">Light is the default; your choice is kept for your account.</p></section>
  </div>;
}

/** Records hidden from the lists, by kind, each with "Show again". Nothing is ever deleted by hiding. */
export function HiddenPage({ setErr }: { setErr: (s: string | null) => void }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [names, setNames] = useState<Record<string, [string, string]>>({});
  const load = useCallback(() => {
    Promise.all([lab.state(), lab.experiments(), geo.areas(), geo.datasets(), geo.scenarios()]).then(([s, e, a, d, sc]) => {
      const n: Record<string, [string, string]> = {};
      e.experiments.forEach((x) => { n[x.campaign_id] = [t('lib.experiments'), x.title]; });
      a.areas.forEach((x: Json) => { n[x.area_id] = [t('lib.areas'), x.name]; });
      [...d.shared, ...d.mine].forEach((x: Json) => { n[x.dataset_key] = [t('lib.datasets'), x.name]; });
      sc.scenarios.forEach((x: Json) => { n[x.scenario_id] = [t('lib.scenarios'), x.name]; });
      setNames(n); setIds(s.preferences.hidden_ids);
    }).catch((e) => setErr(errText(e)));
  }, [setErr]);
  useEffect(load, [load]);
  const show = (id: string) => lab.prefs({ hidden_ids: (ids ?? []).filter((x) => x !== id) }).then((s) => setIds(s.preferences.hidden_ids)).catch((e) => setErr(errText(e)));
  if (!ids) return <p className="muted">Loading…</p>;
  if (!ids.length) return <p className="muted">Nothing is hidden.</p>;
  return <div className="table-scroll"><table aria-label="hidden records"><thead><tr><th>Kind</th><th>Name</th><th /></tr></thead><tbody>
    {ids.map((id) => <tr key={id}><td>{names[id]?.[0] ?? 'Record'}</td><td>{names[id]?.[1] ?? <span className="muted">no longer in this workspace</span>}</td>
      <td className="right"><button className="btn sm" onClick={() => show(id)}><Eye size={12} /> Show again</button></td></tr>)}</tbody></table>
    <p className="small muted">Hiding only removes a record from the lists; it is never deleted.</p></div>;
}

/** Benchmarks: kept apart from the geographic demonstration. The synthetic scientific benchmark stays "Planned" until a
 *  reproducible, publishable version is integrated; the framework's own synthetic problem remains usable for tests. */
export function BenchmarksPage({ go }: { go: (s: Section, arg?: string) => void }) {
  const [mine, setMine] = useState<Json[]>([]);
  useEffect(() => { lab.experiments().then((r) => setMine(r.experiments.filter((x) => x.group === 'benchmark' && !x.hidden))).catch(() => { /* optional */ }); }, []);
  return <div className="col-page">
    <section className="card pad planned"><div className="row gap"><Sigma size={18} /><h3 className="grow">Synthetic scientific benchmark</h3><span className="tag-planned">Planned</span></div>
      <p className="small">Not available yet. It will appear here once a reproducible, publishable version is integrated — separate from the geographic demonstration and never mixed with its results.</p></section>
    {mine.length > 0 && <section className="card pad"><h3>Your experiments on problems without geography</h3>
      <ul className="plain">{mine.map((x) => <li key={x.campaign_id}><button className="btn link" onClick={() => go('workspace', x.campaign_id)}>{x.title}</button> <span className="small muted">· {x.problem} · {x.validation.accepted}/{x.validation.runs} validated</span></li>)}</ul></section>}
  </div>;
}
