/** Participant and vehicle authoring: the logic of the Randomize dialog and of the participant editor that needs no
 *  interface (no imports: unit-tested on its own). The server generates and validates; these functions keep the form
 *  consistent and say early what the server would refuse. Messages are English texts with `{placeholders}`, translated
 *  where they are shown. */

export type Group = 'combustion' | 'hybrid' | 'electric';
export const GROUPS: Group[] = ['combustion', 'hybrid', 'electric'];
export const GROUP_LABEL: Record<Group, string> = { combustion: 'Combustion', hybrid: 'Hybrid', electric: 'Electric' };
/** The vehicle type of a powertrain code (the server groups them the same way; custom counts as combustion). */
export const groupOf = (powertrain: string | null | undefined): Group => (powertrain === 'BEV' ? 'electric' : powertrain === 'HEV' || powertrain === 'PHEV' ? 'hybrid' : 'combustion');

export interface Message { text: string; vars?: Record<string, string | number> }
export type Shares = Record<Group, number>;

/** What the server's generator takes (`authoring` of a composition). Times in seconds since midnight. */
export interface AuthoringParams {
  n_drivers: number; n_riders: number; seed: number; bbox: [number, number, number, number] | null; departure: [number, number];
  driver_window_s: number; rider_window_s: number; max_detour_s: number; max_detour_ratio: number; min_trip_m: number;
  capacity?: number | null; shares?: Partial<Shares> | null; profiles?: unknown[]; vehicles?: Partial<Record<Group, string>>;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------- counts and the driver-to-rider ratio
/** Drivers per rider, to two decimals (10 drivers for 15 riders: 0.67). */
export const ratioOf = (drivers: number, riders: number): number => Math.round((drivers / Math.max(1, riders)) * 100) / 100;
/** The number of drivers a ratio gives for these riders (the riders stay); null when the ratio is not a positive number. */
export const driversForRatio = (riders: number, ratio: number, max = 100): number | null =>
  (!Number.isFinite(ratio) || ratio <= 0 ? null : clamp(Math.round(riders * ratio), 1, max));

// ---------------------------------------------------------------- vehicle-type shares
export const sharesTotal = (s: Shares): number => Math.round(GROUPS.reduce((n, g) => n + (Number(s[g]) || 0), 0) * 100) / 100;
const NO_VEHICLE: Record<Group, string> = {
  combustion: 'No combustion vehicle is available: set its share to 0 % or add one with Manage.',
  hybrid: 'No hybrid vehicle is available: set its share to 0 % or add one with Manage.',
  electric: 'No electric vehicle is available: set its share to 0 % or add one with Manage.',
};
/** Why these shares cannot be used, or null: each between 0 and 100, 100 in total, and a profile for every used type. */
export function sharesError(s: Shares, available: Record<Group, boolean>): Message | null {
  for (const g of GROUPS) {
    const v = Number(s[g]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return { text: 'Each vehicle share is a percentage between 0 and 100.' };
  }
  const total = sharesTotal(s);
  if (Math.abs(total - 100) > 0.01) return { text: 'The vehicle shares add up to {n} %, not 100 %.', vars: { n: total } };
  for (const g of GROUPS) if (s[g] > 0 && !available[g]) return { text: NO_VEHICLE[g] };
  return null;
}
/** `n` drivers split by shares (largest remainder, ties to the earlier share) — the split the server applies. */
export function splitCounts(n: number, shares: number[]): number[] {
  const total = shares.reduce((a, b) => a + b, 0);
  if (n <= 0 || total <= 0) return shares.map(() => 0);
  const exact = shares.map((s) => (n * s) / total), out = exact.map(Math.floor);
  const order = shares.map((_, i) => i).sort((a, b) => (exact[b] - out[b]) - (exact[a] - out[a]) || a - b);
  for (const i of order.slice(0, n - out.reduce((a, b) => a + b, 0))) out[i] += 1;
  return out;
}
/** Shares that give 100 % to one type (the starting point of the dialog). */
export const allTo = (g: Group): Shares => ({ combustion: 0, hybrid: 0, electric: 0, [g]: 100 } as Shares);

// ---------------------------------------------------------------- the whole dialog
export interface RandomizeForm {
  drivers: number; riders: number; seed: number; shares: Shares; capacity: number; start: number; end: number;
  driverWindowMin: number; riderWindowMin: number; detourMin: number; detourRatio: number; minTripKm: number;
}
/** The first thing to change before the server is asked, or null. `start`/`end` are seconds (NaN when not HH:MM). */
export function randomizeError(f: RandomizeForm, available: Record<Group, boolean>, fleet: boolean): Message | null {
  const whole = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!whole(f.drivers, 1, 100) || !whole(f.riders, 1, 100)) return { text: 'Drivers and riders are whole numbers between 1 and 100.' };
  if (fleet) {
    const e = sharesError(f.shares, available);
    if (e) return e;
    if (!Number.isInteger(f.capacity) || f.capacity < 1) return { text: 'The vehicle capacity must be at least 1 seat.' };
    if (f.capacity > 60) return { text: 'The vehicle capacity is at most 60 seats.' };
  }
  if (Number.isNaN(f.start) || Number.isNaN(f.end)) return { text: 'Times are written HH:MM, for example 07:30.' };
  if (f.end < f.start) return { text: 'The departure interval ends before it starts.' };
  for (const w of [f.driverWindowMin, f.riderWindowMin]) if (!Number.isFinite(w) || w < 0 || w > 240) return { text: 'A time window lasts between 0 and 240 minutes.' };
  if (!Number.isFinite(f.detourMin) || f.detourMin < 0 || f.detourMin > 120) return { text: 'The maximum detour is between 0 and 120 minutes.' };
  if (!Number.isFinite(f.detourRatio) || f.detourRatio < 0 || f.detourRatio > 5) return { text: 'The maximum detour ratio is between 0 and 5.' };
  if (!Number.isFinite(f.minTripKm) || f.minTripKm < 0.2 || f.minTripKm > 50) return { text: 'The minimum trip length is between 0.2 and 50 km.' };
  if (!whole(f.seed, 0, 1_000_000)) return { text: 'The seed is a whole number between 0 and 1000000.' };
  return null;
}

/** A rectangle inside another: the middle half of the area, the starting point of a generation rectangle. */
export const innerBox = (b: [number, number, number, number], share = 0.5): [number, number, number, number] => {
  const dl = ((b[2] - b[0]) * (1 - share)) / 2, dn = ((b[3] - b[1]) * (1 - share)) / 2;
  return [b[0] + dl, b[1] + dn, b[2] - dl, b[3] - dn].map((x) => Number(x.toFixed(5))) as [number, number, number, number];
};
/** A rectangle kept inside the area (a generation rectangle never leaves the working area). */
export const clipBox = (b: [number, number, number, number], area: [number, number, number, number]): [number, number, number, number] =>
  [Math.max(b[0], area[0]), Math.max(b[1], area[1]), Math.min(b[2], area[2]), Math.min(b[3], area[3])];
export const insideBox = (lat: number, lon: number, b: [number, number, number, number]) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];

// ---------------------------------------------------------------- participants
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** The next free identifier with this prefix: D1, D2 … (the highest number in use plus one). */
export const nextId = (prefix: string, ids: string[]): string => `${prefix}${ids.reduce((m, id) => Math.max(m, id.startsWith(prefix) ? Number(id.slice(prefix.length)) || 0 : 0), 0) + 1}`;
/** Why an identifier cannot be used, or null. `others` are the identifiers of every other participant. */
export function idError(id: string, others: string[]): Message | null {
  if (!ID.test(id)) return { text: 'An identifier starts with a letter, then letters, digits, - or _ (at most 32 characters).' };
  if (others.includes(id)) return { text: 'Another participant already has the identifier {id}.', vars: { id } };
  return null;
}

// ---------------------------------------------------------------- vehicles: another capacity is another profile
export interface ProfileLike { id: string; name: string; passenger_capacity: number; provenance?: Record<string, unknown> | null; version?: number; updated_at?: string }
/** The profile with another passenger capacity, as a new profile that names the one it comes from (the same rule as
 *  the server's generator). `label` is the shown name of the source profile and `seats` the wording of "{n} seats". */
export function withCapacity<P extends ProfileLike>(p: P, capacity: number, label?: string, seats = '{n} seats'): P {
  if (p.passenger_capacity === capacity) return p;
  const derived = p.provenance?.change === 'passenger_capacity' && typeof p.provenance?.derived_from === 'string';
  const baseId = derived ? String(p.provenance!.derived_from) : p.id;
  const baseName = (derived ? p.name.split(' · ')[0] : label ?? p.name).slice(0, 60);
  const { version: _v, updated_at: _u, ...rest } = p;
  void _v; void _u;
  return { ...rest, id: `${baseId.slice(0, 35)}-${capacity}p`, name: `${baseName} · ${seats.replace('{n}', String(capacity))}`, passenger_capacity: capacity,
    provenance: { kind: 'researcher', derived_from: baseId, change: 'passenger_capacity' } } as unknown as P;
}

// ---------------------------------------------------------------- undo
/** The undo stack with one more state (the oldest are dropped beyond `limit`). */
export const pushUndo = <T>(stack: T[], state: T, limit = 50): T[] => [...stack, state].slice(-limit);
/** The last state taken off the stack (null when there is nothing to undo). */
export const popUndo = <T>(stack: T[]): { stack: T[]; state: T | null } => (stack.length ? { stack: stack.slice(0, -1), state: stack[stack.length - 1] } : { stack, state: null });
