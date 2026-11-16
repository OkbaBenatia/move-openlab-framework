import { useSyncExternalStore } from 'react';
import en, { type Key } from './en';
import fr from './fr';
import frText from './fr-text';

/** Interface language. English is the default; French is chosen with the EN | FR switch in the header. The choice
 *  applies to the current browser session; the account's saved default (asked when switching) is applied at sign-in.
 *  Two catalogues share one mechanism: `t(key)` for keyed strings (en.ts / fr.ts) and `tr(text)` for strings written in
 *  English in the components (fr-text.ts maps the English text to French; a missing entry stays English). */
export type Lang = 'en' | 'fr';
const STORE = 'move-openlab-lang';
const read = (): Lang | null => { try { const v = sessionStorage.getItem(STORE); return v === 'fr' || v === 'en' ? v : null; } catch { return null; } };
let lang: Lang = read() ?? 'en';
const listeners = new Set<() => void>();

export const getLanguage = (): Lang => lang;
/** Whether the language was chosen in this browser session (then the account's default does not override it). */
export const languageChosen = (): boolean => read() !== null;
export function setLanguage(next: Lang, remember = true): void {
  if (remember) { try { sessionStorage.setItem(STORE, next); } catch { /* storage unavailable */ } }
  if (next === lang) return;
  lang = next;
  document.documentElement.setAttribute('lang', next);
  listeners.forEach((fn) => fn());
}
export function useLanguage(): Lang {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getLanguage);
}

const fill = (s: string, vars?: Record<string, string | number>) => {
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
};

export function t(key: Key, vars?: Record<string, string | number>): string {
  return fill((lang === 'fr' ? (fr as Partial<Record<Key, string>>)[key] : undefined) ?? en[key] ?? key, vars);
}

/** A string written in English in a component, in the current language. Placeholders are written `{name}`. */
export function tr(text: string, vars?: Record<string, string | number>): string {
  return fill(lang === 'fr' ? frText[text] ?? text : text, vars);
}

/** Numbers and dates follow the language (decimal comma and thin spaces in French). */
export const locale = (): string => (lang === 'fr' ? 'fr-FR' : 'en');

export type { Key };
