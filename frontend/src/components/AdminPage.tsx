import { useCallback, useEffect, useState } from 'react';
import { Ban, CheckCircle2, Copy, Eye, EyeOff, FlaskConical, GraduationCap, KeyRound, RotateCcw, Search, Shield, UserPlus, X } from 'lucide-react';
import { call, post, type Json } from '../api/client';
import { errText } from './common';

const ROLE: Record<string, [string, React.ReactNode, string]> = {
  admin: ['Administrator', <Shield size={12} />, ''], researcher: ['Researcher', <FlaskConical size={12} />, 'info'], student: ['Student', <GraduationCap size={12} />, 'warn'],
};
const ROLE_HELP: Record<string, string> = {
  researcher: 'Own workspace · runs, imports and compares experiments', student: 'Own isolated workspace · followed by one supervising researcher',
  admin: 'Manages accounts · cannot open other workspaces',
};
const initials = (s: string) => s.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?';
const when = (t: number | null | undefined) => (t ? new Date(t * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** Accounts of the installation (administrators) or the students of a supervising researcher. Roles and supervision are
 *  explicit; a new account gets a temporary password shown once (the person must choose their own at first sign-in);
 *  reset / deactivate / reactivate act on one row; every action is recorded in the audit log. */
export function AdminPage({ me, supervisorMode = false, setErr }: { me: string; supervisorMode?: boolean; setErr: (s: string | null) => void }) {
  const base = supervisorMode ? '/supervision/students' : '/admin/users';
  const [users, setUsers] = useState<Json[]>([]);
  const [f, setF] = useState({ username: '', display_name: '', role: supervisorMode ? 'student' : 'researcher', supervisor: '', can_supervise: false });
  const [secret, setSecret] = useState<{ user: string; password: string; reset: boolean } | null>(null);
  const [show, setShow] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState<'accounts' | 'audit'>('accounts');
  const [filter, setFilter] = useState<'all' | 'researcher' | 'student' | 'admin'>('all');
  const [q, setQ] = useState('');
  const [audit, setAudit] = useState<Json[] | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => { call(base).then((r) => setUsers(r.users ?? r.students)).catch((e) => setErr(errText(e))); }, [base, setErr]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!drawer) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [drawer]);
  useEffect(() => { if (tab === 'audit' && !audit) call('/admin/audit').then((r) => setAudit(r.entries)).catch((x) => setErr(errText(x))); }, [tab, audit, setErr]);
  const act = async (fn: () => Promise<Json>, reset = false) => {
    setErr(null);
    try { const r = await fn(); if (r.temporary_password) { setSecret({ user: r.user.username, password: r.temporary_password, reset }); setShow(false); setDrawer(true); } load(); }
    catch (e) { setErr(errText(e)); }
  };
  const supervisors = users.filter((u) => (u.role === 'researcher' && u.can_supervise) || u.role === 'admin');
  const create = () => act(() => post(base, supervisorMode ? { username: f.username, display_name: f.display_name }
    : { username: f.username, display_name: f.display_name, role: f.role, supervisor: f.role === 'student' ? f.supervisor || undefined : undefined, can_supervise: f.role === 'researcher' && f.can_supervise }))
    .then(() => setF({ username: '', display_name: '', role: supervisorMode ? 'student' : 'researcher', supervisor: '', can_supervise: false }));
  const shown = users.filter((u) => (filter === 'all' || u.role === filter) && (!q || `${u.display} ${u.username}`.toLowerCase().includes(q.toLowerCase())));
  const copy = () => { if (secret) navigator.clipboard?.writeText(secret.password).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => { /* clipboard unavailable */ }); };
  return <div className="admin">
    <div className="row gap admin-bar">
      {!supervisorMode && <nav className="tabs" aria-label="administration"><button className={tab === 'accounts' ? 'on' : ''} onClick={() => setTab('accounts')}>Accounts <span className="badge">{users.length}</span></button>
        <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit log</button></nav>}
      <span className="grow" /><button className="btn primary" onClick={() => { setSecret(null); setDrawer(true); }}><UserPlus size={15} /> {supervisorMode ? 'New student' : 'New account'}</button></div>
    {tab === 'accounts' && <>
      <div className="row gap wrap"><label className="search-in"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts" aria-label="search accounts" /></label>
        {!supervisorMode && <div className="seg" role="group" aria-label="role filter">{(['all', 'researcher', 'student', 'admin'] as const).map((r) => <button key={r} className={filter === r ? 'on' : ''} onClick={() => setFilter(r)}>{r === 'all' ? 'All' : `${ROLE[r][0]}s`}</button>)}</div>}</div>
      <div className="card table-card"><table className="accounts" aria-label={supervisorMode ? 'students' : 'accounts'}><thead><tr><th>Account</th><th>Role</th><th>Supervision</th><th>Status</th><th>Last sign-in</th><th className="n">Experiments</th><th /></tr></thead>
        <tbody>{shown.map((u) => <tr key={u.username}>
          <td className="nowrap"><span className="row gap"><span className="avatar sm">{initials(u.display)}</span><span><b>{u.display}</b><span className="block tiny muted mono">{u.username}</span></span></span></td>
          <td><span className={`badge ${ROLE[u.role]?.[2] ?? ''}`}>{ROLE[u.role]?.[1]}{ROLE[u.role]?.[0] ?? u.role}</span></td>
          <td className="small nowrap">{u.role === 'researcher' && !supervisorMode ? <label className="row small switch"><input type="checkbox" role="switch" checked={!!u.can_supervise} disabled={u.username === me}
            onChange={(e) => act(() => call(`/admin/users/${u.username}/supervision`, { method: 'PUT', body: JSON.stringify({ can_supervise: e.target.checked }) }))} />{u.can_supervise ? 'Can supervise students' : 'Cannot supervise'}</label>
            : u.role === 'student' ? (supervisorMode ? <span>Supervised by you</span> : <label className="row small gap">Supervisor <select aria-label={`supervisor of ${u.username}`} value={u.supervisor ?? ''} onChange={(e) => act(() => call(`/admin/users/${u.username}/supervisor`, { method: 'PUT', body: JSON.stringify({ supervisor: e.target.value || null }) }))}>
              <option value="">— none —</option>{supervisors.map((s) => <option key={s.username} value={s.username}>{s.display}</option>)}</select></label>) : <span className="muted">—</span>}
            {u.role === 'student' && !supervisorMode && !u.supervisor && <span className="tiny warn-text block">needs a supervisor</span>}</td>
          <td className="nowrap">{u.active ? <span className="badge ok">Active</span> : <span className="badge">Deactivated</span>}{u.must_change_password && u.active && <span className="badge warn"><KeyRound size={11} />Temporary password</span>}</td>
          <td className="small nowrap">{when(u.last_login_at)}</td><td className="n">{u.campaigns}</td>
          <td className="nowrap right-cell">{u.username !== me && <>
            <button className="btn sm" title="new temporary password; the person chooses their own at next sign-in" onClick={() => act(() => post(`${base}/${u.username}/reset-password`), true)}><KeyRound size={12} /> Reset password</button>
            {u.active ? <button className="btn sm danger" onClick={() => { if (window.confirm(`Deactivate ${u.display}? They can no longer sign in; nothing is deleted.`)) act(() => post(`${base}/${u.username}/deactivate`)); }}><Ban size={12} /> Deactivate</button>
              : <button className="btn sm" onClick={() => act(() => post(`${base}/${u.username}/reactivate`))}><RotateCcw size={12} /> Reactivate</button>}</>}</td></tr>)}</tbody></table></div>
      <p className="small muted">{supervisorMode ? 'Students work in their own isolated workspace; you can reset their password or deactivate them. Every action is recorded in the audit log.'
        : 'Administrators manage accounts but never open other workspaces. Every action is recorded in the audit log.'}</p></>}
    {tab === 'audit' && (audit == null ? <p className="small muted">Loading…</p> : audit.length === 0 ? <p className="small muted">No entry yet.</p> :
      <div className="card table-card"><table className="compact" aria-label="audit log"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>{audit.slice().reverse().map((e, i) => <tr key={i}><td className="small nowrap">{new Date(e.t * 1000).toLocaleString()}</td><td className="mono small">{e.actor}</td><td>{String(e.action).replace(/_/g, ' ')}</td><td className="mono small">{e.target}</td></tr>)}</tbody></table></div>)}
    {drawer && <div className="overlay" role="dialog" aria-label={supervisorMode ? 'new student' : 'new account'} onClick={() => setDrawer(false)}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="row gap drawer-head"><div className="grow"><h2>{secret?.reset ? 'Password reset' : supervisorMode ? 'New student' : 'New account'}</h2><div className="small muted">{secret?.reset ? 'The person chooses a new password at the next sign-in' : 'The person chooses their own password at first sign-in'}</div></div>
          <button className="btn icon ghost" aria-label="close" onClick={() => setDrawer(false)}><X size={16} /></button></div>
        {secret ? <div className="secret note ok" role="status"><div className="row gap"><CheckCircle2 size={17} /><b className="grow">{secret.reset ? `New temporary password for ${secret.user}` : `Account created: ${secret.user}`}</b></div>
          <p className="small">Temporary password — shown once. Give it to the person directly; they must replace it at first sign-in.</p>
          <div className="row gap"><code className="mono grow pw">{show ? secret.password : '•••• •••• •••• ••••'}</code>
            <button className="btn icon" onClick={() => setShow(!show)} aria-label={show ? 'hide password' : 'show password'}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <button className="btn" onClick={copy}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button></div>
          <div className="row gap"><span className="grow" /><button className="btn" onClick={() => { setSecret(null); }}>Create another</button><button className="btn primary" onClick={() => { setSecret(null); setDrawer(false); }}>Done</button></div></div>
          : <div className="form-col">
            <label className="field">Full name <input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} aria-label="new display name" /></label>
            <label className="field">Username <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} aria-label="new username" autoCapitalize="none" spellCheck={false} /></label>
            {!supervisorMode && <div className="field">Role<div className="col gap-s">{(['researcher', 'student', 'admin'] as const).map((r) => <label key={r} className={`choice row-choice ${f.role === r ? 'on' : ''}`}>
              <input type="radio" name="role" checked={f.role === r} onChange={() => setF({ ...f, role: r })} aria-label={ROLE[r][0]} /><span className="choice-ico">{ROLE[r][1]}</span><span><b>{ROLE[r][0]}</b><span>{ROLE_HELP[r]}</span></span></label>)}</div></div>}
            {!supervisorMode && f.role === 'student' && <label className="field">Supervisor <select value={f.supervisor} onChange={(e) => setF({ ...f, supervisor: e.target.value })} aria-label="new supervisor">
              <option value="">— choose —</option>{supervisors.map((s) => <option key={s.username} value={s.username}>{s.display}</option>)}</select></label>}
            {!supervisorMode && f.role === 'researcher' && <label className="row small"><input type="checkbox" checked={f.can_supervise} onChange={(e) => setF({ ...f, can_supervise: e.target.checked })} /> Can supervise students</label>}
            {supervisorMode && <p className="small muted">The student gets an isolated workspace and appears in your list; you can reset their password or deactivate them.</p>}
            <div className="row gap"><span className="grow" /><button className="btn" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="btn primary" disabled={f.username.length < 2 || f.display_name.length < 2 || (!supervisorMode && f.role === 'student' && !f.supervisor)} onClick={create}><UserPlus size={14} /> Create</button></div></div>}
      </div></div>}
  </div>;
}
