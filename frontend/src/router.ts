import { useCallback, useEffect, useState } from 'react';

/** Hash routes, so that the browser's Back and Forward buttons and bookmarks work:
 *  #/workspace[/<experiment>] · #/data[/<view>] · #/experiments[/<view>] · #/jobs · #/admin */
export type Section = 'workspace' | 'data' | 'experiments' | 'jobs' | 'admin';
export interface Route { section: Section; arg: string }

const SECTIONS: Section[] = ['workspace', 'data', 'experiments', 'jobs', 'admin'];

export function parse(hash: string): Route {
  const [s, ...rest] = hash.replace(/^#\/?/, '').split('/');
  const section = (SECTIONS as string[]).includes(s) ? (s as Section) : 'workspace';
  return { section, arg: decodeURIComponent(rest.join('/')) };
}

export const href = (section: Section, arg = '') => `#/${section}${arg ? `/${encodeURIComponent(arg)}` : ''}`;

export function useRoute(): [Route, (section: Section, arg?: string, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((section: Section, arg = '', replace = false) => {
    const h = href(section, arg);
    if (h === window.location.hash) return;
    if (replace) { window.history.replaceState(null, '', h); setRoute(parse(h)); } else window.location.hash = h;
  }, []);
  return [route, go];
}
