import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, ScrollText, UserPlus } from 'lucide-react';
import { call, post, type Json } from '../api/client';
import { errText } from './common';

const ROLE: Record<string, string> = { admin: 'Administrator', researcher: 'Researcher', student: 'Student' };

/** Account administration. Administrators manage every account (roles, supervision, passwords, activation, audit);
 *  a researcher with "Can supervise students" sees the same page limited to their own students. Temporary passwords
 *  are shown once, masked by default, and never stored by this page. */
export function AdminPage({ me, supervisorMode = false, setErr }: { me: string; supervisorMode?: boolean; setErr: (s: string | null) => void }) {
  const base = supervisorMode ? '/supervision/students' : '/admin/users';
  const [users, setUsers] = useState<Json[]>([]);
  const [f, setF] = useState({ username: '', display_name: '', role: supervisorMode ? 'student' : 'researcher', supervisor: '', can_supervise: false });
  const [secret, setSecret] = useState<{ user: string; password: string } | null>(null);
  const [show, setShow] = useState(false);
  const [audit, setAudit] = useState<Json[] | null>(null);
  const load = useCallback(() => { call(base).then((r) => setUsers(r.users ?? r.students)).catch((e) => setErr(errText(e))); }, [base, setErr]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<Json>) => { setErr(null); try { const r = await fn(); if (r.temporary_password) { setSecret({ user: r.user.username, password: r.temporary_password }); setShow(false); } load(); } catch (e) { setErr(errText(e)); } };
  const supervisors = users.filter((u) => (u.role === 'researcher' && u.can_supervise) || u.role === 'admin');
  const create = () => act(() => post(base, supervisorMode ? { username: f.username, display_name: f.display_name }
    : { username: f.username, display_name: f.display_name, role: f.role, supervisor: f.role === 'student' ? f.supervisor || undefined : undefined, can_supervise: f.role === 'researcher' && f.can_supervise }))
    .then(() => setF({ username: '', display_name: '', role: supervisorMode ? 'student' : 'researcher', supervisor: '', can_supervise: false }));
  return <div>
    {secret && <div className="note ok" role="status"><b>Temporary password for {secret.user}</b> (shown once; the user must change it at first sign-in):{' '}
      <span className="mono">{show ? secret.password : '•'.repeat(16)}</span>{' '}
      <button className="btn sm" onClick={() => setShow(!show)} aria-label={show ? 'hide password' : 'show password'}>{show ? <EyeOff size={12} /> : <Eye size={12} />}</button>{' '}
      <button className="btn sm" onClick={() => setSecret(null)}>Done</button></div>}
    <div className="table-scroll"><table aria-label={supervisorMode ? 'students' : 'accounts'}><thead><tr><th>Account</th><th>Role</th>{!supervisorMode && <th>Supervision</th>}<th>Status</th><th>Experiments</th><th>Last sign-in</th><th>Created</th><th /></tr></thead>
      <tbody>{users.map((u) => <tr key={u.username}>
        <td><b>{u.display}</b><div className="mono small">{u.username}</div></td><td>{ROLE[u.role] ?? u.role}</td>
        {!supervisorMode && <td className="small">{u.role === 'researcher' && <label className="row small"><input type="checkbox" checked={!!u.can_supervise} disabled={u.username === me}
          onChange={(e) => act(() => call(`/admin/users/${u.username}/supervision`, { method: 'PUT', body: JSON.stringify({ can_supervise: e.target.checked }) }))} /> Can supervise students</label>}
          {u.role === 'student' && <select aria-label={`supervisor of ${u.username}`} value={u.supervisor ?? ''} onChange={(e) => act(() => call(`/admin/users/${u.username}/supervisor`, { method: 'PUT', body: JSON.stringify({ supervisor: e.target.value || null }) }))}>
            <option value="">— no supervisor —</option>{supervisors.map((s) => <option key={s.username} value={s.username}>{s.display}</option>)}</select>}</td>}
        <td>{u.active ? <span className="badge ok">active</span> : <span className="badge warn">deactivated</span>}{u.must_change_password && <span className="badge">temporary password</span>}</td>
        <td>{u.campaigns}</td><td className="small">{u.last_login_at ? new Date(u.last_login_at * 1000).toLocaleString() : '—'}</td>
        <td className="small">{new Date(u.created_at * 1000).toLocaleDateString()}{u.created_by && ` · ${u.created_by}`}</td>
        <td><div className="row gap">{u.username !== me && <button className="btn sm" onClick={() => act(() => post(`${base}/${u.username}/reset-password`))}><KeyRound size={12} /> Reset password</button>}
          {u.username !== me && (u.active ? <button className="btn sm" onClick={() => act(() => post(`${base}/${u.username}/deactivate`))}>Deactivate</button>
            : <button className="btn sm" onClick={() => act(() => post(`${base}/${u.username}/reactivate`))}>Reactivate</button>)}</div></td></tr>)}</tbody></table></div>
    <h3><UserPlus size={14} /> {supervisorMode ? 'New student' : 'New account'}</h3>
    <div className="form row gap">
      <label>Username <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} aria-label="new username" /></label>
      <label>Display name <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} aria-label="new display name" /></label>
      {!supervisorMode && <label>Role <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="new role">
        <option value="researcher">Researcher</option><option value="student">Student</option><option value="admin">Administrator</option></select></label>}
      {!supervisorMode && f.role === 'student' && <label>Supervisor <select value={f.supervisor} onChange={(e) => setF({ ...f, supervisor: e.target.value })} aria-label="new supervisor">
        <option value="">—</option>{supervisors.map((s) => <option key={s.username} value={s.username}>{s.display}</option>)}</select></label>}
      {!supervisorMode && f.role === 'researcher' && <label className="row small"><input type="checkbox" checked={f.can_supervise} onChange={(e) => setF({ ...f, can_supervise: e.target.checked })} /> Can supervise students</label>}
      <button className="btn primary" disabled={f.username.length < 2 || f.display_name.length < 2 || (!supervisorMode && f.role === 'student' && !f.supervisor)} onClick={create}>Create</button>
    </div>
    <p className="small muted">{supervisorMode ? 'Students work in their own isolated workspace; you can reset their password or deactivate them. Every action is recorded in the installation\'s audit log.'
      : 'Administrators manage accounts; they cannot open other users\' workspaces. Every action is recorded in the installation\'s audit log.'}</p>
    {!supervisorMode && <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !audit) call('/admin/audit').then((r) => setAudit(r.entries)).catch((x) => setErr(errText(x))); }}>
      <summary><ScrollText size={13} /> Audit log</summary>
      {audit && (audit.length === 0 ? <p className="small muted">No entry yet.</p> : <div className="table-scroll tall"><table className="compact" aria-label="audit log"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>{audit.map((e, i) => <tr key={i}><td className="small">{new Date(e.t * 1000).toLocaleString()}</td><td className="mono small">{e.actor}</td><td>{e.action}</td><td className="mono small">{e.target}</td></tr>)}</tbody></table></div>)}
    </details>}
  </div>;
}
