import type { Json } from '../api/client';
import { kindLabel } from './common';

export function Workspace({ list, onOpen }: { list: Json[]; onOpen: (id: string) => void }) {
  if (list.length === 0) return <p className="muted">This workspace has no campaign for this problem yet. Create one or import a bundle.</p>;
  return <div className="table-scroll"><table aria-label="campaigns">
    <thead><tr><th>Campaign</th><th>Type</th><th>Status</th><th>Researcher</th><th>Methods</th><th>Scenarios</th><th>Runs</th><th>Parent</th><th /></tr></thead>
    <tbody>{list.map((c) => <tr key={c.campaign_id}>
      <td><b title={c.campaign_id}>{c.title}</b></td>
      <td><span className={`badge ${c.imported ? 'warn' : ''}`}>{kindLabel(c)}</span></td><td>{c.status}</td><td>{c.owner_display}</td>
      <td className="mono small">{c.methods.join(', ')}</td><td>{c.scenarios}</td><td>{c.runs}</td>
      <td className="small">{c.parent ? c.parent.relation : '—'}</td><td><button className="btn sm" onClick={() => onOpen(c.campaign_id)}>Open</button></td></tr>)}</tbody>
  </table></div>;
}
