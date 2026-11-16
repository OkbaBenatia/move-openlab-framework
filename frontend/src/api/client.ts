/** Thin typed client for the MOVE OpenLab API (same origin, cookie session). */
// API replies are untyped JSON read field by field; `any` is confined to this one alias (the only exception to the lint rule).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
export interface User { username: string; display: string; role: string; must_change_password: boolean; expires_at: number; can_supervise?: boolean }
export interface Metric { id: string; label: string; unit: string; definition: string; better: string | null; category?: string | null; note?: string | null }
export interface Level { metric: string; sense: 'max' | 'min' }
export interface Field { id: string; label: string; type: string; choices?: { id: string; label: string }[]; min?: number; max?: number; help?: string }
export interface Problem {
  spec: { problem_id: string; problem_spec_version: string; objective_spec_id: string; constraint_spec_id: string; instance_schema: string };
  title: string; description: string; synthetic: boolean; restricted?: boolean; validator_version: string; objective: Level[]; metrics: Metric[];
  reference_method: [string, string] | null; decision_description: string;
  scenario_parameters: { fields: Field[]; defaults: Json };
  variants: { id: string; description: string; instance_level: boolean }[];
  scorers: { id: string; label: string; description: string; learned: boolean }[]; candidate_scoring: boolean;
}
export interface MethodRef { source: string; method_id: string; version: string; name: string; kind: string; author: string; code_sha256?: string; settings?: MethodSettings;
  /** Kept for earlier records only (a pilot or superseded version): listed under History. */
  archived?: boolean }
/** A setting a researcher may choose per experiment (the method's `config_schema`); null keeps the solver's default. */
export interface SettingSpec { type: 'number' | 'integer' | 'boolean' | 'string'; label: string; unit?: string; min?: number; max?: number; nullable?: boolean; help?: string }
export interface MethodSettings { default_config: Record<string, unknown>; config_schema: Record<string, SettingSpec> }

const BASE = '/api';

export function toLogin(expired = true) {
  const next = window.location.pathname + window.location.search;
  window.location.replace(`/login?${expired ? 'expired=1&' : ''}next=${encodeURIComponent(next)}`);
}

export async function call<T = Json>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const r = await fetch(BASE + path, { credentials: 'same-origin', ...init, headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(init?.headers as Record<string, string> | undefined) } });
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

/** Save a server file through the browser. Returns its size and, for bundles, the SHA-256 the server announced. */
export async function download(path: string, filename: string): Promise<{ bytes: number; sha256: string | null } | undefined> {
  const r = await fetch(BASE + path, { credentials: 'same-origin' });
  if (r.status === 401) { toLogin(); return; }
  if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).detail ?? m; } catch { /* */ } throw new Error(m); }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return { bytes: blob.size, sha256: r.headers.get('X-Bundle-SHA256') };
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
