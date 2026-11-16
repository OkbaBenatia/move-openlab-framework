import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, LogOut, Moon, Play, Sigma, Sun } from 'lucide-react';
import { api, call, post, type Json, type User } from '../api/client';
import { bold, errText } from '../components/common';
import { geo } from '../geo/api';
import { t, tr } from '../i18n';
import { lab } from '../lab/api';
import type { Section } from '../router';
import type { Theme } from './Header';

/** My account: who I am here, my password, my appearance. */
export function AccountPage({ user, theme, setTheme }: { user: User; theme: Theme; setTheme: (t: Theme) => void }) {
  const role = user.role === 'admin' ? t('role.admin') : user.role === 'student' ? t('role.student') : t('role.researcher');
  return <div className="col-page">
    <section className="card pad"><dl className="facts">
      <dt>{tr('Name')}</dt><dd>{user.display}</dd><dt>{tr('Username')}</dt><dd className="mono">{user.username}</dd>
      <dt>{tr('Role')}</dt><dd>{role}{user.role === 'researcher' ? (user.can_supervise ? ` · ${tr('can supervise students')}` : '') : ''}</dd>
      <dt>{tr('Session')}</dt><dd>{tr('until {date}', { date: new Date(user.expires_at * 1000).toLocaleString() })}</dd></dl>
      <div className="row gap"><button className="btn" onClick={() => window.location.assign('/change-password')}><KeyRound size={14} /> {tr('Change password')}</button>
        <button className="btn" onClick={() => api.logout().finally(() => window.location.replace('/login'))}><LogOut size={14} /> {t('menu.signout')}</button></div></section>
    <section className="card pad"><h3>{t('menu.appearance')}</h3>
      <div className="seg" role="group" aria-label={t('menu.appearance')}>
        <button className={theme === 'light' ? 'on' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun size={14} />{t('menu.light')}</button>
        <button className={theme === 'dark' ? 'on' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={14} />{t('menu.dark')}</button></div>
      <p className="small muted">{tr('Light is the default; your choice is kept for your account.')}</p></section>
  </div>;
}

/** Hidden records: a non-destructive way to tidy lists. Hiding removes an item from the normal lists (and from counts
 *  and comparison candidates); nothing is deleted, and "Show again" restores it. Grouped by kind. */
export function HiddenPage({ setErr }: { setErr: (s: string | null) => void }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [names, setNames] = useState<Record<string, [string, string]>>({});
  const load = useCallback(() => {
    Promise.all([lab.state(), lab.experiments(), geo.areas(), geo.datasets(), geo.scenarios()]).then(([s, e, a, d, sc]) => {
      const n: Record<string, [string, string]> = {};
      // experiments with the same title (e.g. an earlier demonstration) are told apart by their creation date
      e.experiments.forEach((x) => { const name = `${x.title} · ${x.created_at.slice(0, 10)}`; n[x.campaign_id] = [t('lib.experiments'), x.imported ? tr('{name} · imported', { name }) : name]; });
      a.areas.forEach((x: Json) => { n[x.area_id] = [t('lib.areas'), x.name]; });
      [...d.shared, ...d.mine].forEach((x: Json) => { n[x.dataset_key] = [t('lib.datasets'), x.name]; });
      sc.scenarios.forEach((x: Json) => { n[x.scenario_id] = [t('lib.scenarios'), x.name]; });
      setNames(n); setIds(s.preferences.hidden_ids);
    }).catch((e) => setErr(errText(e)));
  }, [setErr]);
  useEffect(load, [load]);
  const save = (next: string[]) => lab.prefs({ hidden_ids: next }).then((s) => setIds(s.preferences.hidden_ids)).catch((e) => setErr(errText(e)));
  const kinds = [t('lib.experiments'), t('lib.areas'), t('lib.datasets'), t('lib.scenarios')];
  const present = (ids ?? []).filter((id) => names[id]);
  const gone = (ids ?? []).filter((id) => !names[id]);
  return <div className="col-page">
    <section className="card pad hidden-intro"><div className="row gap"><EyeOff size={18} className="muted" /><h3 className="grow">{t('hidden.purpose')}</h3></div>
      <p className="small muted">{tr('Use the eye button next to an experiment, area, mobility dataset or scenario to hide it. Hidden items are left out of the normal lists, of their counts and of the comparison candidates; their data, results and lineage stay untouched. Show again puts an item back.')}</p></section>
    {ids == null ? <p className="muted">{tr('Loading…')}</p> : !present.length && !gone.length ? <p className="muted">{tr('Nothing is hidden.')}</p> : <>
      {kinds.map((k) => { const xs = present.filter((id) => names[id][0] === k); return xs.length > 0 && <section key={k} className="card table-card">
        <div className="row gap card-head"><h3 className="grow">{k}</h3><span className="badge">{tr('{n} hidden', { n: xs.length })}</span></div>
        <table aria-label={tr('hidden {kind}', { kind: k.toLowerCase() })}><tbody>{xs.map((id) => <tr key={id}><td>{names[id][1]}</td>
          <td className="right-cell"><button className="btn sm" onClick={() => save((ids ?? []).filter((x) => x !== id))}><Eye size={12} /> {tr('Show again')}</button></td></tr>)}</tbody></table></section>; })}
      {gone.length > 0 && <section className="card pad"><p className="small muted">{gone.length === 1
        ? tr('{n} hidden entry refers to records that are no longer in this workspace (for example a replaced demonstration). Nothing else is affected.', { n: gone.length })
        : tr('{n} hidden entries refer to records that are no longer in this workspace (for example a replaced demonstration). Nothing else is affected.', { n: gone.length })}</p><button className="btn sm" onClick={() => save((ids ?? []).filter((x) => names[x]))}>{tr('Remove these entries from the list')}</button></section>}
    </>}
  </div>;
}

/** Benchmarks, kept apart from the geographic demonstration. The public synthetic benchmark (methodological, its own
 *  measured results) can be run here; every result is checked by the validator and, here, against an independent
 *  min-cost-flow oracle. */
export function BenchmarksPage({ go }: { go: (s: Section, arg?: string) => void }) {
  const [mine, setMine] = useState<Json[]>([]);
  const [pb, setPb] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { call('/lab/benchmark/public').then(setPb).catch((e) => setErr(errText(e))); }, []);
  useEffect(() => { load(); lab.experiments().then((r) => setMine(r.experiments.filter((x) => x.group === 'benchmark' && !x.hidden))).catch(() => { /* optional */ }); }, [load]);
  const d = pb?.definition;
  const run = async () => {
    if (!d || busy) return;
    setBusy(true); setErr(null);
    try {
      const c = await post<Json>('/campaigns', { problem_id: d.problem_id, title: d.title, scenario_params: d.scenario_params, methods: d.methods.map((m: Json) => [m.method_id, m.version]), repetitions: d.repetitions });
      await post(`/campaigns/${c.campaign_id}/execute`);
      go('workspace', c.campaign_id);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const sizes = d ? Object.entries(d.generator.sizes as Record<string, Json>).map(([k, v]) => `${k} ${v.drivers}×${v.passengers}`).join(' · ') : '';
  return <div className="col-page">
    {err && <p className="note warn" role="alert">{err}</p>}
    {d && <section className="card pad" aria-label={tr('public synthetic benchmark')}><div className="row gap"><Sigma size={18} /><h3 className="grow">{tr(d.title)}</h3><span className="badge ok">{tr('Available')}</span></div>
      <p className="small">{tr(d.description)}</p>
      <dl className="facts small">
        <dt>{tr('Inputs')}</dt><dd>{tr('generator {name} {version} · sizes {sizes} (drivers × passengers) · seeds {first}–{last} · {n} frozen scenarios', { name: d.generator.name, version: d.generator.version, sizes, first: d.generator.seeds[0], last: d.generator.seeds[d.generator.seeds.length - 1], n: d.generator.sizes ? Object.keys(d.generator.sizes).length * d.generator.seeds.length : '' })}</dd>
        <dt>{tr('Objective')}</dt><dd>{d.objective.map((o: Json) => `${o.sense} ${o.metric}`).join(tr(', then '))}</dd>
        <dt>{tr('Methods')}</dt><dd>{d.methods.map((m: Json) => m.name ?? m.method_id).join(' · ')} · {tr('{n} repetitions', { n: d.repetitions })} ({tr(d.optional_plugin.note)})</dd>
        <dt>{tr('Checks')}</dt><dd>{tr('independent validator {v}', { v: d.validator })} · {tr(d.oracle)}</dd>
        <dt>{tr('Reproduce')}</dt><dd><span className="mono">{d.command}</span> · {tr('or export a run (one ZIP) and import it in another workspace, then Run again')}</dd>
      </dl>
      <p className="tiny muted">{tr(d.scope)}</p>
      <div className="row gap"><button className="btn primary" onClick={run} disabled={busy}><Play size={14} /> {busy ? tr('Starting…') : tr('Run the public benchmark')}</button>
        <span className="small muted">{tr('about half a minute; opens in the Workspace with its progress')}</span></div>
      {pb.runs.length > 0 && <div className="table-scroll"><table className="compact" aria-label={tr('benchmark runs')}><thead><tr><th>{tr('Run')}</th><th>{tr('Method')}</th><th className="n">{tr('Validated')}</th><th className="n">{tr('Equal to the oracle optimum')}</th><th /></tr></thead>
        <tbody>{pb.runs.flatMap((r: Json) => r.methods.map((m: Json, i: number) => <tr key={r.campaign_id + m.method_id}>
          <td>{i === 0 ? <><b>{r.title}</b><span className="tiny muted block">{r.created_at.slice(0, 16).replace('T', ' ')} · {tr('{n} scenarios', { n: r.scenarios })}{r.locked ? ` · ${tr('locked')}` : ''}</span></> : ''}</td>
          <td>{m.method_id}</td><td className="n">{m.accepted}/{m.runs}</td><td className="n">{tr('{a}/{b} runs', { a: m.oracle_optimal, b: m.runs })}</td>
          <td>{i === 0 && <button className="btn sm" onClick={() => go('workspace', r.campaign_id)}>{tr('Open')}</button>}</td></tr>))}</tbody></table></div>}
    </section>}
    <section className="card pad"><h3>{tr('Compare or Benchmark?')}</h3>
      <p className="small">{bold(tr('*Compare* analyses the experiments and methods you select, on their matched scenarios. A *benchmark* is a repeatable, standardized evaluation: fixed scenarios, parameters, versions and aggregation, with an independent check — the same protocol for everyone who runs it.'))}</p></section>
    {mine.length > 0 && <section className="card pad"><h3>{tr('Your experiments on problems without geography')}</h3>
      <ul className="plain">{mine.map((x) => <li key={x.campaign_id}><button className="btn link" onClick={() => go('workspace', x.campaign_id)}>{x.title}</button> <span className="small muted">· {tr(x.problem)} · {tr('{a}/{b} validated', { a: x.validation.accepted, b: x.validation.runs })}</span></li>)}</ul></section>}
  </div>;
}
