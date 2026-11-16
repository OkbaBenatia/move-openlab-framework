/** The experiments a comparison shows — exactly the ones the researcher ticked, in the order they were ticked, with
 *  one of them as the reference for every delta. Nothing is ever added on the researcher's behalf.
 *  Route form: `#/compare/<reference>|<other1>,<other2>…` (the reference first; columns A, B, C… in that order). */
export interface Selection { ids: string[]; reference: string }

const uniq = (xs: string[]) => xs.filter((x, i) => !!x && xs.indexOf(x) === i);

/** The starting selection of the comparison dialog: the current experiment, ticked and used as reference, plus
 *  whatever an open comparison already shows (when the dialog edits it). */
export function initialSelection(current: string, already: string[] = []): Selection {
  const ids = uniq([current, ...already]);
  return { ids, reference: ids[0] ?? '' };
}

/** Tick or untick one experiment. Unticking the reference passes the role to the first remaining experiment. */
export function toggle(sel: Selection, id: string): Selection {
  if (sel.ids.includes(id)) {
    const ids = sel.ids.filter((x) => x !== id);
    return { ids, reference: sel.reference === id ? (ids[0] ?? '') : sel.reference };
  }
  const ids = [...sel.ids, id];
  return { ids, reference: sel.reference || id };
}

/** Choose the reference among the ticked experiments (an unticked one cannot be the reference). */
export function setReference(sel: Selection, id: string): Selection {
  return sel.ids.includes(id) ? { ...sel, reference: id } : sel;
}

/** A comparison needs at least two experiments. */
export const canCompare = (sel: Selection) => sel.ids.length >= 2 && sel.ids.includes(sel.reference);

/** The experiments in column order: the reference first (A), the others in the order they were ticked (B, C…). */
export function ordered(sel: Selection): string[] {
  return sel.ids.includes(sel.reference) ? [sel.reference, ...sel.ids.filter((x) => x !== sel.reference)] : [...sel.ids];
}

export function toRoute(sel: Selection): string {
  const [ref, ...rest] = ordered(sel);
  return `${ref}|${rest.join(',')}`;
}

/** Parse a comparison route; duplicates (including the reference repeated among the others) are dropped, nothing added. */
export function fromRoute(arg: string): Selection {
  const [ref = '', rest = ''] = arg.split('|');
  const ids = uniq([ref, ...rest.split(',')]);
  return { ids, reference: ids[0] ?? '' };
}

/** Column letters: A for the reference, then B, C, … (AA, AB… beyond 26, never needed in practice). */
export function letter(i: number): string {
  let s = '', n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
