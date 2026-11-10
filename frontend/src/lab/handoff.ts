/** Hand-offs from the Library to the workspace: a request stored for the next workspace visit of this browser tab
 *  (start Generate with an area and mobility data, or a new experiment with chosen scenarios). */
export const OPEN_WIZARD = 'move-openlab.open-wizard';   // '1', or JSON {area_id?, dataset_key?} from Library › Use
export const OPEN_NEW = 'move-openlab.open-new';         // JSON {hashes, label} from Library › Scenarios › Use

/** Hand-offs from the Library to the workspace (stored for the next workspace visit of this browser tab). */
export function handOff(key: typeof OPEN_WIZARD | typeof OPEN_NEW, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: the workspace opens normally */ }
}
export function takeHandOff<T>(key: string): T | null {
  try { const v = sessionStorage.getItem(key); if (v == null) return null; sessionStorage.removeItem(key); return (v === '1' ? {} : JSON.parse(v)) as T; } catch { return null; }
}
