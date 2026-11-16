/** The state of "Choose metrics", as plain functions (no interface code): which metrics are shown by default, what a
 *  saved choice means for the metrics an experiment really has, and the dialog's bulk actions. One choice per problem is
 *  shared by the Workspace results, Compare › Methods, Compare › Experiments, the charts and the exported tables. */
export interface Choosable { id: string; group: string; byDefault: boolean; compact?: boolean }

/** The default selection: every metric marked as shown by default, or — for a narrow results table — the compact set. */
export const defaultIds = (defs: Choosable[], compact = false): string[] => defs.filter((d) => (compact ? !!d.compact : d.byDefault)).map((d) => d.id);

/** The metric ids shown: the saved choice restricted to the metrics that exist here, else the defaults. A saved choice
 *  that names none of the available metrics (another problem's, or empty) falls back to the defaults. */
export function chosenIds(defs: Choosable[], saved: string[] | undefined | null, compact = false): Set<string> {
  const known = new Set(defs.map((d) => d.id));
  const kept = (saved ?? []).filter((id) => known.has(id));
  return new Set(kept.length ? kept : defaultIds(defs, compact));
}

export const toggleId = (sel: Set<string>, id: string): Set<string> => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); return n; };
export const selectAll = (defs: Choosable[]): Set<string> => new Set(defs.map((d) => d.id));
export const selectNone = (): Set<string> => new Set();
/** Tick or untick one whole group, leaving the others as they are. */
export const setGroup = (sel: Set<string>, defs: Choosable[], group: string, on: boolean): Set<string> => {
  const ids = defs.filter((d) => d.group === group).map((d) => d.id);
  return on ? new Set([...sel, ...ids]) : new Set([...sel].filter((id) => !ids.includes(id)));
};
/** The selection in the order of the definitions (the order of the tables and charts), as it is saved. */
export const ordered = (defs: Choosable[], sel: Set<string>): string[] => defs.filter((d) => sel.has(d.id)).map((d) => d.id);
/** Whether a selection equals the default one (then nothing needs to be kept for the account). */
export const isDefault = (defs: Choosable[], sel: Set<string>, compact = false): boolean => {
  const d = defaultIds(defs, compact); return d.length === sel.size && d.every((id) => sel.has(id));
};
