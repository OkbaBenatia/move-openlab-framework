/** Pure logic of "+ Add method": the plug-in catalogue (groups, states, what may be registered), the template form
 *  rules (mirroring the server's checks) and the CLI command equivalent to each step. No React, no i18n, no DOM. */

export type Origin = 'approved' | 'uploaded';
/** How the server presents a plug-in: shipped example, provided by the operator, or uploaded by this account. */
export type Catalog = 'example' | 'installation' | 'uploaded';
/** The plug-in's state for this account (decided by the server; see Workspace.available_plugins). */
export type PluginState = 'available' | 'registered' | 'incompatible' | 'changed' | 'taken';

export interface CatalogItem {
  plugin: string; origin: Origin; catalog: Catalog; state: PluginState; code_sha256: string; compatible?: boolean;
  incompatibility?: string; registered_code_sha256?: string;
  metadata?: { method_id?: string; name?: string; version?: string; kind?: string; author?: string; description?: string; problem_id?: string; objective_spec_id?: string };
}

export const GROUPS: Catalog[] = ['example', 'installation', 'uploaded'];
export const KINDS = ['heuristic', 'exact', 'learned', 'hybrid'] as const;
/** Same rule as the server (method_tools.NAME): the directory name, from which the method id is derived. */
export const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

export const itemKey = (p: Pick<CatalogItem, 'origin' | 'plugin'>) => `${p.origin}:${p.plugin}`;
export const displayName = (p: CatalogItem) => p.metadata?.name ?? p.plugin;

/** The catalogue in three groups, each sorted by display name; the uploaded group is always present (it holds the
 *  upload control), the others only when they have plug-ins. */
export function groupCatalog(items: CatalogItem[]): { catalog: Catalog; items: CatalogItem[] }[] {
  return GROUPS.map((catalog) => ({ catalog, items: items.filter((i) => (i.catalog ?? (i.origin === 'uploaded' ? 'uploaded' : 'installation')) === catalog)
    .sort((a, b) => displayName(a).localeCompare(displayName(b)) || (a.metadata?.version ?? '').localeCompare(b.metadata?.version ?? '')) }))
    .filter((g) => g.items.length > 0 || g.catalog === 'uploaded');
}

/** Why a plug-in cannot be registered now, as a reason code (null: it can). */
export type Block = 'off' | 'not-allowed' | 'registered' | 'changed' | 'taken' | 'incompatible' | null;
export function registerBlock(p: CatalogItem, enabled: boolean, canRegister: boolean): Block {
  if (!enabled) return 'off';
  if (p.state === 'registered') return 'registered';
  if (p.state === 'changed') return 'changed';
  if (p.state === 'taken') return 'taken';
  if (p.state === 'incompatible') return 'incompatible';
  return canRegister ? null : 'not-allowed';
}

/** What is wrong with a method name typed in the template form (null: valid). */
export function nameProblem(name: string): 'empty' | 'length' | 'chars' | null {
  if (!name) return 'empty';
  if (name.length < 3 || name.length > 41) return 'length';
  return NAME_RE.test(name) ? null : 'chars';
}
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9_])/, 'm_$1').slice(0, 41) || 'my_method';
export const methodId = (name: string) => name.replace(/_/g, '-');

/** POSIX shell quoting for the commands shown to copy. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface TemplateForm { name: string; display_name: string; author: string; kind: string; description: string }
/** `move-openlab method new` with the same values as the form (the same template and rendering on the server). */
export function cliNew(f: TemplateForm, problemId: string, dir = 'plugins'): string {
  const parts = ['move-openlab method new', shq(f.name), '--problem', shq(problemId), '--dir', shq(dir)];
  if (f.author) parts.push('--author', shq(f.author));
  if (f.display_name) parts.push('--display-name', shq(f.display_name));
  if (f.kind && f.kind !== 'heuristic') parts.push('--kind', shq(f.kind));
  if (f.description) parts.push('--description', shq(f.description));
  return parts.join(' ');
}
export const cliTest = (name: string) => `python -m pytest ${shq(name)}/test_plugin.py`;
export const cliZip = (name: string) => `zip -r ${shq(name)}.zip ${shq(name)} -x '*__pycache__*'`;
/** Metadata check and the sandboxed self-test (what Register does); with a bundle, also a run on every frozen scenario
 *  of an exported experiment, validated independently and compared. */
export const cliCheck = (name: string, bundle?: string) => `move-openlab method check ${shq(name)}${bundle ? ` --bundle ${shq(bundle)}` : ''}`;
export const cliCopy = (name: string) => `cp -r ${shq(name)} "$MOVE_OPENLAB_PLUGIN_DIR"/`;

/** Which step of the upload pipeline a server refusal belongs to (the server prefixes its reasons). */
export function stepOfError(msg: string): 'archive' | 'metadata' | 'upload' {
  if (msg.startsWith('ZIP refused')) return 'archive';
  if (msg.startsWith('METADATA refused')) return 'metadata';
  return 'upload';
}
export const reasonOf = (msg: string) => msg.replace(/^(ZIP|METADATA) refused:\s*/, '');

/** A first check in the browser before sending (the server checks everything again). */
export function zipPrecheck(file: { name: string; size: number }, maxBytes: number): 'not-zip' | 'too-large' | 'empty' | null {
  if (!/\.zip$/i.test(file.name)) return 'not-zip';
  if (file.size === 0) return 'empty';
  return file.size > maxBytes ? 'too-large' : null;
}
