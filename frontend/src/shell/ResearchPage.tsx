import { useEffect, useState } from 'react';
import { FlaskConical, GitCompareArrows, History, LockKeyhole, MapPinned } from 'lucide-react';
import { api, call, type Json, type Problem } from '../api/client';
import { errText } from '../components/common';
import { tr } from '../i18n';
import { lab, type ExpItem, type Study } from '../lab/api';
import type { Section } from '../router';

/** Private research: the restricted problems granted to this account on this installation, with their saved studies
 *  (the default scientific presentation) and, apart, the history of every other record. The section exists only where
 *  a restricted package is installed and granted; everything here goes through the same Workspace and Compare pages. */
export function ResearchPage({ go, setErr }: { go: (s: Section, arg?: string) => void; setErr: (s: string | null) => void }) {
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [exps, setExps] = useState<ExpItem[]>([]);
  const [records, setRecords] = useState<Json[]>([]);            // every record, also those of an earlier validator version
  useEffect(() => {
    Promise.all([api.problems(), lab.studies(), lab.experiments(), call('/campaigns')])
      .then(([p, s, e, c]) => { setProblems(p.problems.filter((x) => x.restricted)); setStudies(s.studies); setExps(e.experiments); setRecords(c.campaigns); })
      .catch((e) => setErr(errText(e)));
  }, [setErr]);
  if (!problems) return <p className="small muted">{tr('Loading…')}</p>;
  if (!problems.length) return <p className="muted">{tr('No restricted research extension is granted to your account on this installation.')}</p>;
  return <div className="research">
    <p className="note small"><LockKeyhole size={13} /> {tr('Shown to your account only. These problems come from restricted extensions installed locally and granted to you by an administrator of this installation; they are not part of the public framework, and other accounts cannot list or open their records.')}</p>
    {problems.map((p) => { const id = p.spec.problem_id;
      const sts = studies.filter((s) => s.problem_id === id); const inStudy = new Set(sts.flatMap((s) => s.members.map((m) => m.campaign_id)));
      const history = records.filter((x) => x.problem_id === id && !inStudy.has(x.campaign_id));
      const item = (cid: string) => exps.find((x) => x.campaign_id === cid);
      return <section key={id} className="card pad research-problem" aria-label={p.title}>
        <div className="row gap"><FlaskConical size={18} /><h2 className="grow">{p.title}</h2><span className="badge warn">{tr('Restricted')}</span></div>
        <p className="small muted">{p.description}</p>
        {sts.map((s) => { const first = s.members[0]?.campaign_id ?? '';
          return <div key={s.study_id} className="study-card" aria-label={s.title}>
            <div className="row gap wrap"><h3 className="grow">{s.title}</h3>
              <button className="btn primary" onClick={() => go('workspace', first)}><MapPinned size={14} /> {tr('Open on the map')}</button>
              <button className="btn" onClick={() => go('methods', first)}><GitCompareArrows size={14} /> {tr('Compare the methods')}</button></div>
            {s.description && <p className="small">{s.description}</p>}
            <table className="compact" aria-label={`${tr('methods of')} ${s.title}`}><thead><tr><th>{tr('Method')}</th><th>{tr('Source experiment')}</th><th>{tr('Results')}</th></tr></thead>
              <tbody>{s.members.map((m) => <tr key={`${m.campaign_id}:${m.method_id}`}><td><b>{m.name ?? m.label ?? m.method_id}</b>{m.note && <span className="badge outline">{m.note}</span>}</td>
                <td className="small"><button className="btn link" onClick={() => go('workspace', m.campaign_id)}>{m.experiment}</button></td>
                <td className="small">{m.runs != null ? `${m.runs} ${tr('runs')} · ` : ''}{m.imported_results ? tr('imported results, re-validated here') : tr('validated by the independent validator')}{m.locked ? ` · ${tr('locked')}` : ''}</td></tr>)}</tbody></table>
            <p className="tiny muted">{tr('{n} scenarios · the methods are shown together because they were evaluated on the same scenarios; each keeps its own immutable record.', { n: s.scenarios ?? '—' })}</p></div>; })}
        {!sts.length && <p className="small muted">{tr('No saved study yet for this problem. Open one of its experiments below.')}</p>}
        <details className="history"><summary className="row gap"><History size={14} /> {tr('History and advanced records ({n})', { n: history.length })}</summary>
          <p className="tiny muted">{tr('Earlier pilots, superseded policies, settings versions, extensions and drafts. Nothing is deleted; these records are kept for audit and are not part of the default presentation.')}</p>
          <table className="compact" aria-label={tr('history records')}><thead><tr><th>{tr('Experiment')}</th><th>{tr('Type')}</th><th>{tr('Status')}</th><th className="n">{tr('Validated')}</th><th /></tr></thead>
            <tbody>{history.map((x) => { const it = item(x.campaign_id);
              return <tr key={x.campaign_id}><td>{x.title}{it?.hidden && <span className="badge">{tr('hidden from default lists')}</span>}{!it && <span className="badge" title={tr('Recorded with an earlier specification or validator version: kept and readable as a record, not shown in the Workspace')}>{tr('earlier version')}</span>}</td>
                <td className="small">{x.kind}</td><td className="small">{x.checksum ? tr('locked') : tr(x.status)}</td>
                <td className="n small">{it ? `${it.validation.accepted}/${it.validation.runs}` : `${x.runs} ${tr('runs')}`}</td>
                <td><button className="btn sm" onClick={() => (it ? go('workspace', x.campaign_id) : go('experiments', `c:${x.campaign_id}`))}>{it ? tr('Open') : tr('Open the record')}</button></td></tr>; })}</tbody></table></details>
      </section>; })}
  </div>;
}
