import en, { type Key } from './en';

/** Interface strings by key. English is the only catalogue for now; the structure is ready for a French one
 *  (`fr.ts` with the same keys, chosen from the user's preference) without changing any component. */
const catalogue: Record<Key, string> = en;

export function t(key: Key, vars?: Record<string, string | number>): string {
  let s: string = catalogue[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export type { Key };
