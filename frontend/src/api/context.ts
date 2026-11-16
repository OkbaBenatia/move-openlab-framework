/** The request context of this browser tab.
 *
 *  The public Workspace and a restricted-research context are two explicit contexts of ONE application. While the tab is
 *  in the public context, every request to the API carries `X-Move-Context: public`: the server then leaves restricted
 *  problems and their records out of every answer, even for an account that is granted them — so nothing private can
 *  reach the public Workspace through a list, a search, a map, an export or a cached view. The header only narrows an
 *  answer; what an account may ever see is decided by the grants on the server, never here. */
const HEADER = 'X-Move-Context';
const KEY = 'move-openlab-context';
export type Context = 'public' | 'research';

let current: Context = (() => { try { return sessionStorage.getItem(KEY) === 'research' ? 'research' : 'public'; } catch { return 'public'; } })();

export const requestContext = (): Context => current;
export function setRequestContext(c: Context) {
  current = c;
  try { if (c === 'research') sessionStorage.setItem(KEY, c); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

/** Headers of a request that must see every record the account is granted (the context itself is decided from it). */
export const ANY_CONTEXT: Record<string, string> = { [HEADER]: 'all' };

/** The header a same-origin API request gets in the given context (none in the research context). */
export function contextHeader(url: string, context: Context, given?: HeadersInit, origin: string = window.location.origin): Record<string, string> {
  let path = url;
  try { const u = new URL(url, origin); if (u.origin !== origin) return {}; path = u.pathname; } catch { return {}; }
  if (!path.startsWith('/api/') || context !== 'public') return {};
  const has = given instanceof Headers ? given.has(HEADER) : Array.isArray(given) ? given.some(([k]) => k.toLowerCase() === HEADER.toLowerCase())
    : !!given && Object.keys(given).some((k) => k.toLowerCase() === HEADER.toLowerCase());
  return has ? {} : { [HEADER]: 'public' };
}

/** Every `fetch` of the page goes through here once (installed at start-up), so no component can forget the context. */
export function installContextHeader() {
  const w = window as typeof window & { __moveContextFetch?: boolean };
  if (w.__moveContextFetch) return;
  w.__moveContextFetch = true;
  const native = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const extra = contextHeader(url, current, init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!Object.keys(extra).length) return native(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return native(input, { ...init, headers });
  };
}

/** Which context an address belongs to. The context follows what is shown: a record of a restricted problem is only
 *  ever shown in the research context and a public record only in the public one; the research overview is research;
 *  any other address (a list, a new experiment, a record made a moment ago) keeps the context the tab is in. An account
 *  without a granted restricted problem is always in the public context. */
export function contextOf(o: { section: string; record: string; recordProblem: Record<string, string>; restrictedIds: string[]; inResearch: boolean }): { research: boolean; known: 'private' | 'public' | null } {
  const known = o.record && o.record in o.recordProblem ? (o.restrictedIds.includes(o.recordProblem[o.record]) ? 'private' : 'public') : null;
  const research = o.restrictedIds.length > 0 && (o.section === 'research' || known === 'private' || (known === null && o.inResearch));
  return { research, known };
}

/** The tab's context after an address is shown: entered by a research address, left by a public record or by a
 *  confirmed exit (`exiting`: the address still shows the private record for a moment and must not re-enter). */
export function nextInResearch(prev: boolean, o: { section: string; known: 'private' | 'public' | null; exiting: boolean; hasRestricted: boolean }): boolean {
  if (!o.hasRestricted) return false;
  if (o.section === 'research' || o.known === 'private') return o.exiting ? prev : true;
  return o.known === 'public' ? false : prev;
}
