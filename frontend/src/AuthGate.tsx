import { useEffect, useState, type ReactNode } from 'react';
import { api, toLogin, type User } from './api/client';
import { UserContext } from './context';

/** Nothing renders before the server confirms a signed-in user. No session -> sign-in page; a temporary password ->
 *  change-password page (both server-rendered). The session is re-checked when the browser restores the page. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => api.me().then((m) => {
      if (!alive) return;
      if (!m.user) { toLogin(false); return; }
      if (m.user.must_change_password) { window.location.replace('/change-password'); return; }
      setUser(m.user);
    }).catch(() => { /* 401: the client already replaced the page with /login */ });
    check();
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { setUser(null); check(); } };
    window.addEventListener('pageshow', onShow);
    return () => { alive = false; window.removeEventListener('pageshow', onShow); };
  }, []);
  return user ? <UserContext.Provider value={user}>{children}</UserContext.Provider> : null;
}
