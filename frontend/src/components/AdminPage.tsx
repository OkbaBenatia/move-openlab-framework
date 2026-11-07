import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, UserPlus } from 'lucide-react';
import { call, post, type Json } from '../api/client';
import { errText } from './common';

/** Account administration (administrators only; enforced by the server on every request). Temporary passwords are
 *  shown once, masked by default, and never stored by this page. */
export function AdminPage({ me, setErr }: { me: string; setErr: (s: string | null) => void }) {
  const [users, setUsers] = useState<Json[]>([]);
  const [f, setF] = useState({ username: '', display_name: '', role: 'researcher' });
  const [secret, setSecret] = useState<{ user: string; password: string } | null>(null);
  const [show, setShow] = useState(false);
  const load = useCallback(() => { call('/admin/users').then((r) => setUsers(r.users)).catch((e) => setErr(errText(e))); }, [setErr]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<Json>) => { setErr(null); try { const r = await fn(); if (r.temporary_password) { setSecret({ user: r.user.username, password: r.temporary_password }); setShow(false); } load(); } catch (e) { setErr(errText(e)); } };
  return <div>
    {secret && <div className="note ok" role="status"><b>Temporary password for {secret.user}</b> (shown once; the user must change it at first sign-in):{' '}
      <span className="mono">{show ? secret.password : '•'.repeat(16)}</span>{' '}
      <button className="btn sm" onClick={() => setShow(!show)} aria-label={show ? 'hide password' : 'show password'}>{show ? <EyeOff size={12} /> : <Eye size={12} />}</button>{' '}
      <button className="btn sm" onClick={() => setSecret(null)}>Done</button></div>}
    <div className="table-scroll"><table aria-label="accounts"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Campaigns</th><th>Last sign-in</th><th>Created</th><th /></tr></thead>
      <tbody>{users.map((u) => <tr key={u.username}>
        <td><b>{u.display}</b><div className="mono small">{u.username}</div></td><td>{u.role}</td>
        <td>{u.active ? <span className="badge ok">active</span> : <span className="badge warn">deactivated</span>}{u.must_change_password && <span className="badge">temporary password</span>}</td>
        <td>{u.campaigns}</td><td className="small">{u.last_login_at ? new Date(u.last_login_at * 1000).toLocaleString() : '—'}</td>
        <td className="small">{new Date(u.created_at * 1000).toLocaleDateString()}{u.created_by && ` · ${u.created_by}`}</td>
        <td><div className="row gap">{u.username !== me && <button className="btn sm" onClick={() => act(() => post(`/admin/users/${u.username}/reset-password`))}><KeyRound size={12} /> Reset password</button>}
          {u.username !== me && (u.active ? <button className="btn sm" onClick={() => act(() => post(`/admin/users/${u.username}/deactivate`))}>Deactivate</button>
            : <button className="btn sm" onClick={() => act(() => post(`/admin/users/${u.username}/reactivate`))}>Reactivate</button>)}</div></td></tr>)}</tbody></table></div>
    <h3><UserPlus size={14} /> New account</h3>
    <div className="form row gap">
      <label>Username <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} aria-label="new username" /></label>
      <label>Display name <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} aria-label="new display name" /></label>
      <label>Role <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="new role"><option value="researcher">researcher</option><option value="admin">admin</option></select></label>
      <button className="btn primary" disabled={f.username.length < 2 || f.display_name.length < 2} onClick={() => act(() => post('/admin/users', f)).then(() => setF({ username: '', display_name: '', role: 'researcher' }))}>Create</button>
    </div>
    <p className="small muted">Administrators manage accounts; they cannot open other users' workspaces. Every action is recorded in the installation's audit log.</p>
  </div>;
}
