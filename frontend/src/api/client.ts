/** Thin typed client for the MOVE OpenLab API (same origin, cookie session). */
export type Json = Record<string, any>;
export interface User { username: string; display: string; role: string; must_change_password: boolean; expires_at: number }
export interface Metric { id: string; label: string; unit: string; definition: string; better: string | null }
export interface Level { metric: string; sense: 'max' | 'min' }
export interface Field { id: string; label: string; type: string; choices?: { id: string; label: string }[]; min?: number; max?: number; help?: string }
export interface Problem {
  spec: { problem_id: string; problem_spec_version: string; objective_spec_id: string; constraint_spec_id: string; instance_schema: string };
  title: string; description: string; synthetic: boolean; validator_version: string; objective: Level[]; metrics: Metric[];
  reference_method: [string, string] | null; decision_description: string;
  scenario_parameters: { fields: Field[]; defaults: Json };
  variants: { id: string; description: string; instance_level: boolean }[];
  scorers: { id: string; label: string; description: string; learned: boolean }[]; candidate_scoring: boolean;
}
export interface MethodRef { source: string; method_id: string; version: string; name: string; kind: string; author: string; code_sha256?: string }

const BASE = '/api';

export function toLogin(expired = true) {
  const next = window.location.pathname + window.location.search;
  window.location.replace(`/login?${expired ? 'expired=1&' : ''}next=${encodeURIComponent(next)}`);
}

export async function call<T = Json>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const r = await fetch(BASE + path, { credentials: 'same-origin', headers: isForm ? undefined : { 'Content-Type': 'application/json' }, ...init });
  if (r.status === 401) { toLogin(); throw new Error('authentication required'); }
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const e = await r.json(); if (e?.detail) msg = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail); } catch { /* not JSON */ }
    if (r.status === 403 && msg === 'password change required') window.location.assign('/change-password');
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

export const post = <T = Json>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export async function download(path: string, filename: string) {
  const r = await fetch(BASE + path, { credentials: 'same-origin' });
  if (r.status === 401) { toLogin(); return; }
  if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).detail ?? m; } catch { /* */ } throw new Error(m); }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await r.blob()); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const api = {
  me: () => call<{ user: User | null }>('/auth/me'),
  logout: () => fetch(BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin' }),
  info: () => call('/info'),
  problems: () => call<{ problems: Problem[] }>('/problems'),
};

export async function runJob(cid: string, onProgress: (j: Json) => void): Promise<void> {
  let j = await post(`/campaigns/${cid}/execute`);
  onProgress(j);
  while (j.state === 'running') {
    await new Promise((r) => setTimeout(r, 600));
    j = await call(`/jobs/${j.job_id}`);
    onProgress(j);
  }
  if (j.state === 'error') throw new Error(j.error);
}
