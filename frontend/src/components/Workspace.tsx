import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { HiddenFilter } from './HiddenFilter';
import type { Json } from '../api/client';
import { lab, type ExpItem } from '../lab/api';
import { kindLabel } from './common';

/** Campaign list of the Experiments section: category badges and the non-destructive Hide / Show hidden filter. */
export function Workspace({ list, onOpen }: { list: Json[]; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Record<string, ExpItem>>({});
  const [hidden, setHidden] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const load = () => { lab.experiments().then((r) => setItems(Object.fromEntries(r.experiments.map((x) => [x.campaign_id, x])))).catch(() => { /* badges only */ }); lab.state().then((s) => setHidden(s.preferences.hidden_ids ?? [])).catch(() => { /* */ }); };
  useEffect(load, []);
  const toggle = (id: string) => { const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]; setHidden(next); lab.prefs({ hidden_ids: next }).catch(() => { /* preference only */ }); };
  const shown = list.filter((c) => showHidden || !hidden.includes(c.campaign_id));
  if (list.length === 0) return <p className="muted">This workspace has no campaign for this problem yet. Create one or import a bundle.</p>;
  return <div>
    <div className="row"><span className="grow" /><HiddenFilter n={hidden.filter((h) => list.some((c) => c.campaign_id === h)).length} on={showHidden} setOn={setShowHidden} /></div>
    <div className="table-scroll"><table aria-label="campaigns">
      <thead><tr><th>Campaign</th><th>Category</th><th>Type</th><th>Status</th><th>Researcher</th><th>Methods</th><th>Scenarios</th><th>Runs</th><th>Parent</th><th /></tr></thead>
      <tbody>{shown.map((c) => <tr key={c.campaign_id} className={hidden.includes(c.campaign_id) ? 'dim' : ''}>
        <td><b title={c.campaign_id}>{c.title}</b></td>
        <td>{items[c.campaign_id] && <span className="badge">{items[c.campaign_id].category}</span>}</td>
        <td><span className={`badge ${c.imported ? 'warn' : ''}`}>{kindLabel(c)}</span></td><td>{c.status}</td><td>{c.owner_display}</td>
        <td className="mono small">{c.methods.join(', ')}</td><td>{c.scenarios}</td><td>{c.runs}</td>
        <td className="small">{c.parent ? c.parent.relation : '—'}</td>
        <td><div className="row gap"><button className="btn sm" onClick={() => onOpen(c.campaign_id)}>Open</button>
          <button className="btn icon" aria-label={hidden.includes(c.campaign_id) ? `show ${c.title}` : `hide ${c.title}`} title={hidden.includes(c.campaign_id) ? 'Show in lists' : 'Hide from lists'} onClick={() => toggle(c.campaign_id)}>{hidden.includes(c.campaign_id) ? <Eye size={12} /> : <EyeOff size={12} />}</button></div></td></tr>)}</tbody>
    </table></div>
  </div>;
}
