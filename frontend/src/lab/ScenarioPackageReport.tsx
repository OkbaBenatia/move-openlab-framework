import { CheckCircle2, Info, XCircle } from 'lucide-react';
import type { Json } from '../api/client';
import { tr } from '../i18n';
import { compositionState, scenarioChecks, shortSha, type CheckRow } from './samplePackages';

/** What the verification of a scenario package established, line by line (shared by Import and Try a sample). Every
 *  value comes from the server's report; a limitation (road network not installed here) is said as such. */
export function ScenarioPackageChecks({ rep }: { rep: Json }) {
  const s = rep.scenario ?? {};
  const label = (r: CheckRow): [string, string] => {
    switch (r.id) {
      case 'archive': return [tr('Archive and manifest'), tr('manifest digest matches · {n} files, each checksum matches', { n: r.n ?? 0 })];
      case 'problem': return [tr('Problem and validator'), tr('same specification and validator as this installation')];
      case 'instance': return [tr('Frozen instance'), tr("passes the problem's integrity checks · content hash recomputed: {hash}", { hash: shortSha(s.instance_hash) })];
      case 'geometry': return [tr('Replay geometry'), r.info ? tr('not included: routes replay where the road network is installed')
        : tr('{n} route legs belong to the instance', { n: r.n ?? 0 })];
      case 'composition': return [tr('Editable composition'), r.ok ? tr('rebuilt here on the installed road network and identical')
        : tr("consistent with the instance (participants, time windows, parameters, vehicles); not rebuilt: the area's road network is not installed here")];
      default: return [tr('No executable code'), tr('records only: instance, composition and route geometry')];
    }
  };
  return <ul className="checks pkg-checks" aria-label={tr('verification of the scenario package')}>{scenarioChecks(rep).map((r) => {
    const [b, txt] = label(r);
    return <li key={r.id} data-check={r.id} className={r.info ? 'info' : r.ok ? 'ok' : 'bad'}>
      {r.info ? <Info size={15} className="muted" /> : r.ok ? <CheckCircle2 size={15} className="ok-text" /> : <XCircle size={15} className="bad-text" />} <b>{b}</b><span>{txt}</span></li>;
  })}</ul>;
}

/** The scenario, its counts, provenance and licences as recorded in the package. */
export function ScenarioPackageFacts({ rep }: { rep: Json }) {
  const s = rep.scenario ?? {};
  const prov = rep.provenance ?? {};
  return <dl className="facts">
    <dt>{tr('Scenario')}</dt><dd><b>{s.name}</b> · {tr('{n} drivers', { n: s.drivers ?? 0 })} · {tr('{n} riders', { n: s.riders ?? 0 })}{s.pairs != null ? ` · ${tr('{n} compatible pairs', { n: s.pairs })}` : ''}</dd>
    <dt>{tr('Format')}</dt><dd>{rep.format}{rep.bytes ? ` · ${(rep.bytes / 1e3).toFixed(1)} kB` : ''} · SHA-256 <span className="mono" title={rep.package_sha256}>{shortSha(rep.package_sha256, 16)}</span></dd>
    <dt>{tr('Exported by')}</dt><dd>{rep.exported_by}{rep.created_at ? ` · ${new Date(rep.created_at).toLocaleDateString()}` : ''}</dd>
    <dt>{tr('Problem')}</dt><dd>{rep.problem_title ?? rep.problem_id}</dd>
    {prov.description && <><dt>{tr('Provenance')}</dt><dd className="small">{prov.description}</dd></>}
    <dt>{tr('Licences')}</dt><dd><ul className="pkg-licences">{(rep.licences ?? []).map((l: Json) => <li key={l.subject} className="small">
      <b>{tr(String(l.subject))}</b>: {l.statement}{l.licence?.url ? <> · <a href={l.licence.url} target="_blank" rel="noreferrer">{l.licence.name ?? l.licence.id}</a></> : ''}</li>)}</ul></dd>
  </dl>;
}

/** The plain statement of what can be done with the imported scenario here. */
export function ScenarioPackageNote({ rep }: { rep: Json }) {
  const cs = compositionState(rep);
  if (cs === 'rebuilt-identical') return <p className="note ok small">{tr('Rebuilt here and identical: you can view it, run methods on it, and edit its participants as a new scenario version.')}</p>;
  if (cs === 'network-missing') return <p className="note small pkg-limit">{tr("Viewing and running work with the frozen instance and its route geometry. Editing the participants needs the area's road network, prepared once from Data setup.")}</p>;
  return null;
}
