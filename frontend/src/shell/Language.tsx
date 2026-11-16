import { useSyncExternalStore } from 'react';
import { call } from '../api/client';
import { getLanguage, setLanguage, tr, useLanguage, type Lang } from '../i18n';

/** After a switch, the account is asked once whether the new language becomes its default. The question lives outside
 *  the application tree (which is rendered again when the language changes). */
let pending: Lang | null = null;
const subs = new Set<() => void>();
const ask = (l: Lang | null) => { pending = l; subs.forEach((fn) => fn()); };
const usePending = () => useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn); }; }, () => pending);

/** EN | FR in the header. English is the default; the choice applies at once, for this session. */
export function LanguageSwitch() {
  const lang = useLanguage();
  const choose = (l: Lang) => { if (l === getLanguage()) return; setLanguage(l); ask(l); };
  return <div className="seg lang-seg" role="group" aria-label={tr('language')}>
    {(['en', 'fr'] as Lang[]).map((l) => <button key={l} className={lang === l ? 'on' : ''} aria-pressed={lang === l} lang={l} title={l === 'en' ? 'English' : 'Français'} onClick={() => choose(l)}>{l.toUpperCase()}</button>)}</div>;
}

/** "Make this my default language? Yes / No" — Yes keeps it for the account (applied at every sign-in); No keeps it for
 *  the current session only. */
export function LanguagePrompt() {
  const l = usePending();
  useLanguage();
  if (!l) return null;
  const yes = () => { call('/lab/preferences', { method: 'PUT', body: JSON.stringify({ language: l }) }).catch(() => { /* preference only */ }); ask(null); };
  return <div className="lang-prompt" role="dialog" aria-label={tr('default language')}>
    <span>{tr('Make this my default language?')} <b>{l === 'fr' ? 'Français' : 'English'}</b></span>
    <button className="btn sm primary" onClick={yes}>{tr('Yes')}</button>
    <button className="btn sm" onClick={() => ask(null)} title={tr('Keep it for this session only')}>{tr('No')}</button>
  </div>;
}
