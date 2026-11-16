"""Authentication endpoints, the access guard, security headers and single-origin frontend serving.

    /login, /change-password   server-rendered pages (work without JavaScript)
    /api/auth/*                login / logout / me / change-password
    /api/health                public health check
    /api/*                     protected API -> 401 JSON without a valid session
    /assets/*, /*              protected built frontend -> redirect to /login without a session
"""
from __future__ import annotations

import html
import json
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.staticfiles import StaticFiles

from .. import auth as A
from ..auth import password_policy
from ..version import APP_NAME, APP_SUBTITLE, DEVELOPER, display_version

PUBLIC_PATHS = {"/login", "/api/health", "/api/auth/login", "/api/auth/logout", "/favicon.svg", "/favicon.ico", "/auth.js", "/theme.js"}
PASSWORD_CHANGE_PATHS = {"/change-password", "/api/auth/change-password", "/api/auth/me", "/api/auth/logout",
                         "/api/auth/password-policy", "/favicon.svg", "/favicon.ico", "/auth.js", "/theme.js"}
BRAND_PREFIX = "/brand/"                     # approved logo assets, needed by the sign-in pages
FONT_PREFIX = "/fonts/"                      # the self-hosted Inter typeface (SIL Open Font Licence), same reason
CSP_TEMPLATE = ("default-src 'self'; img-src 'self' data: {tiles}; style-src 'self' 'unsafe-inline'; script-src 'self'; "
                "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
CSP = CSP_TEMPLATE.format(tiles="").replace(" ;", ";")


def csp_for(tile_url: str) -> str:
    """CSP allowing map tiles from the configured tile server's origin only (images, nothing else)."""
    from urllib.parse import urlsplit
    u = urlsplit(tile_url.replace("{s}", "a"))
    origin = f"{u.scheme}://{u.netloc}" if u.scheme in ("https", "http") and u.netloc else ""
    return CSP_TEMPLATE.format(tiles=origin).replace(" ;", ";")
router = APIRouter()


def _auth(request: Request) -> A.Auth:
    return request.app.state.auth


def _safe_next(nxt: str | None) -> str:
    return nxt if nxt and nxt.startswith("/") and not nxt.startswith("//") and not nxt.startswith("/login") else "/"


def _client(request: Request) -> str:
    return request.client.host if request.client else ""


def _set_cookie(request: Request, resp: Response, token: str) -> None:
    s = _auth(request).settings
    resp.set_cookie(A.COOKIE_NAME, token, max_age=s.session_ttl_s, httponly=True, secure=s.cookie_secure,
                    samesite="lax", path="/")


def _clear_cookie(request: Request, resp: Response) -> None:
    resp.delete_cookie(A.COOKIE_NAME, path="/", httponly=True, secure=_auth(request).settings.cookie_secure,
                       samesite="lax")


def _is_form(request: Request) -> bool:
    ct = request.headers.get("content-type", "")
    return "application/x-www-form-urlencoded" in ct or "multipart/form-data" in ct


async def _body(request: Request) -> dict:
    if _is_form(request):
        return dict(await request.form())
    try:
        d = await request.json()
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


@router.get("/api/health")
def health():
    return {"status": "ok", "app": APP_NAME, "version": display_version()}


@router.post("/api/auth/login")
async def login(request: Request):
    form, data = _is_form(request), await _body(request)
    nxt = _safe_next(str(data.get("next", "")) or None)
    acc, why = _auth(request).authenticate(str(data.get("username", "")), str(data.get("password", "")), _client(request))
    if acc is None:
        msg = {"throttled": "Too many attempts. Try again later.",
               "unconfigured": "Sign-in is not configured on this server."}.get(why, "Invalid username or password.")
        code = 429 if why == "throttled" else 503 if why == "unconfigured" else 401
        if form:
            return RedirectResponse(f"/login?error={why}&next={quote(nxt)}", status_code=303)
        return JSONResponse({"detail": msg}, status_code=code)
    token, ses = _auth(request).issue(acc)
    target = "/change-password" if ses.must_change_password else nxt
    resp = RedirectResponse(target, status_code=303) if form else JSONResponse(
        {"user": dict(username=ses.username, display=ses.display, role=ses.role),
         "must_change_password": ses.must_change_password, "expires_at": int(ses.exp)})
    _set_cookie(request, resp, token)
    return resp


@router.post("/api/auth/logout")
async def logout(request: Request):
    ses = _auth(request).read(request.cookies.get(A.COOKIE_NAME))
    if ses is not None:
        _auth(request).revoke(ses)
    resp = RedirectResponse("/login", status_code=303) if _is_form(request) else JSONResponse({"ok": True})
    _clear_cookie(request, resp)
    return resp


@router.get("/api/auth/me")
def me(request: Request):
    ses = request.state.session
    return {"user": dict(username=ses.username, display=ses.display, role=ses.role, can_supervise=ses.can_supervise,
                         expires_at=int(ses.exp), must_change_password=ses.must_change_password) if ses else None}


@router.post("/api/auth/password-policy")
async def check_password_policy(request: Request):
    """Live feedback for the password form: level (weak / acceptable / strong) and what is missing. The same rule
    is applied when the password is saved; nothing is stored or logged here."""
    data = await _body(request)
    ses = request.state.session
    return JSONResponse(password_policy(str(data.get("password", "")), ses.username if ses else "", ses.display if ses else ""),
                        headers={"Cache-Control": "no-store"})


@router.post("/api/auth/change-password")
async def change_password(request: Request):
    ses, form, data = request.state.session, _is_form(request), await _body(request)
    user, why = _auth(request).change_password(ses, str(data.get("current_password", "")), str(data.get("new_password", "")),
                                               str(data.get("confirm_password", "")), _client(request))
    if user is None:
        if form:
            return RedirectResponse(f"/change-password?error={quote(why)}", status_code=303)
        return JSONResponse({"detail": why}, status_code=400)
    token, new = _auth(request).issue(user)
    resp = RedirectResponse("/", status_code=303) if form else JSONResponse(
        {"ok": True, "user": dict(username=new.username, display=new.display)})
    _set_cookie(request, resp, token)
    return resp


# ------------------------------------------------------------------ server-rendered pages
STYLE = """@font-face{font-family:Inter;font-style:normal;font-weight:400 700;font-display:swap;src:url(/fonts/inter/inter-latin.woff2) format('woff2')}
:root{--bg:#f4f6f9;--panel:#fff;--border:#e3e8ef;--strong:#cdd5df;--text:#0f1b2d;--muted:#66758a;--accent:#0a6cc2;--bad:#b42318;--warn:#9a5b00;--ok:#157a3c;color-scheme:light}
:root[data-theme=dark]{--bg:#0c1118;--panel:#141a23;--border:#273140;--strong:#344052;--text:#e8edf3;--muted:#8e9aab;--accent:#4d9ef0;--bad:#f0625a;--warn:#e2a93b;--ok:#4cc27a;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh}
body{font:14.5px/1.45 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;color:var(--text);display:flex;align-items:center;justify-content:center;padding:24px 16px;
background:radial-gradient(1100px 600px at 18% 8%,rgba(0,136,216,.10),transparent 60%),radial-gradient(900px 600px at 88% 92%,rgba(0,136,127,.10),transparent 60%),var(--bg)}
main{width:100%;max-width:460px;background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:32px 36px 26px;box-shadow:0 2px 6px rgba(15,27,45,.08),0 18px 48px rgba(15,27,45,.14)}
h1{font-size:19px;margin:0}.sub{margin:3px 0 18px;color:var(--muted);font-size:13px}
label{display:block;font-size:12.5px;font-weight:600;margin:0 0 5px}
input{width:100%;font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--strong);border-radius:8px;padding:10px 12px;margin:0 0 14px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;font:inherit;font-weight:650;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:11px;cursor:pointer;margin-top:4px}
:root[data-theme=dark] button{color:#06111d}
.err{color:var(--bad);font-size:13px;margin:-6px 0 14px}.alt{display:block;text-align:center;margin-top:12px;font-size:13px;color:var(--accent)}
.linkbtn{background:none;color:var(--muted);font-weight:500;padding:6px}footer{margin-top:18px;color:var(--muted);font-size:11.5px;text-align:center}
.plate{display:grid;place-items:center;margin:0 0 22px;border-radius:14px}
:root[data-theme=dark] .plate{background:#fff;padding:16px 14px 12px}
.logo{display:block;width:100%;max-width:340px;height:auto}
.meter{height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin:-8px 0 6px}
.meter span{display:block;height:100%;width:0;background:var(--bad);transition:width .2s}.hint{font-size:12px;color:var(--muted);margin:0 0 12px}
.hint.weak{color:var(--bad)}.hint.acceptable{color:var(--warn)}.hint.strong{color:var(--ok)}.hint.ok{color:var(--ok)}
.legend{display:flex;gap:12px;font-size:11.5px;color:var(--muted);margin:10px 0 0}.legend i{display:inline-block;width:10px;height:5px;border-radius:2px;margin-right:5px;vertical-align:2px}
main{position:relative}.lang{position:absolute;top:12px;right:14px;display:flex;gap:4px}
.lang button{width:auto;margin:0;padding:3px 9px;font-size:12px;font-weight:600;letter-spacing:.03em;background:var(--panel);color:var(--muted);border:1px solid var(--strong)}
:root[data-theme=dark] .lang button{color:var(--muted)}.lang button.on,:root[data-theme=dark] .lang button.on{color:var(--text);border-color:var(--accent)}"""

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · {app}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><script src="/theme.js"></script><style>{style}</style></head>
<body><main>{body}<footer>{app} · developed by {dev} · {version}</footer></main><script src="/auth.js" defer></script></body></html>"""

LOGIN_BODY = """<div class="plate"><img class="logo" src="/brand/move-openlab-logo-1024w-transparent.png" alt="{app}" width="340" height="98"></div><h1>Sign in</h1><p class="sub">Use the account your administrator created for you.</p>
<form method="post" action="/api/auth/login" autocomplete="on">{error}
<input type="hidden" name="next" value="{next}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>"""

CHANGE_BODY = """<div class="plate"><img class="logo" src="/brand/move-openlab-logo-1024w-transparent.png" alt="MOVE OpenLab" width="260" height="75" style="max-width:260px"></div><h1>Choose your password</h1><p class="sub">{intro} Signed in as <b>{user}</b>.</p>
<form method="post" action="/api/auth/change-password" autocomplete="off">{error}
<label for="c">Current password</label><input id="c" name="current_password" type="password" autocomplete="current-password" required autofocus>
<label for="n">New password</label><input id="n" name="new_password" type="password" autocomplete="new-password" minlength="12" required aria-describedby="strength">
<div class="meter" aria-hidden="true"><span id="bar"></span></div><p id="strength" class="hint" role="status">At least 12 characters with three kinds of characters (lower case, upper case, digits, symbols).</p>
<label for="r">Repeat password</label><input id="r" name="confirm_password" type="password" autocomplete="new-password" minlength="12" required aria-describedby="match">
<p id="match" class="hint" role="status"></p>
<button type="submit">Save and continue</button></form>
<p class="legend"><span><i style="background:var(--bad)"></i>Weak</span><span><i style="background:#d4a72c"></i>Acceptable</span><span><i style="background:var(--ok)"></i>Strong</span><span style="margin-left:auto">Checked again by the server</span></p>{cancel}
<form method="post" action="/api/auth/logout"><button class="linkbtn" type="submit">Log out</button></form>"""

AUTH_JS = """(function () {
  // Interface language of these two pages: English by default, French on request. The choice is the same session
  // value the application reads (EN | FR in its header), so it carries over after sign-in.
  var FR = {
    'Sign in': 'Se connecter', 'Use the account your administrator created for you.': 'Utilisez le compte que votre administrateur a créé pour vous.',
    'Username': 'Identifiant', 'Password': 'Mot de passe', 'Choose your password': 'Choisissez votre mot de passe',
    'Your password is temporary: choose a personal password to continue. Signed in as': 'Votre mot de passe est temporaire : choisissez un mot de passe personnel pour continuer. Connecté en tant que',
    'Choose a new personal password. Signed in as': 'Choisissez un nouveau mot de passe personnel. Connecté en tant que',
    'Current password': 'Mot de passe actuel', 'New password': 'Nouveau mot de passe', 'Repeat password': 'Répétez le mot de passe',
    'At least 12 characters with three kinds of characters (lower case, upper case, digits, symbols).': 'Au moins 12 caractères avec trois types de caractères (minuscules, majuscules, chiffres, symboles).',
    'Save and continue': 'Enregistrer et continuer', 'Weak': 'Faible', 'Acceptable': 'Acceptable', 'Strong': 'Fort',
    'Checked again by the server': 'Vérifié à nouveau par le serveur', 'Log out': 'Se déconnecter', 'Back to MOVE OpenLab': 'Retour à MOVE OpenLab',
    'Invalid username or password.': 'Identifiant ou mot de passe incorrect.', 'Too many attempts. Try again later.': 'Trop de tentatives. Réessayez plus tard.',
    'Sign-in is not configured on this server.': 'La connexion n’est pas configurée sur ce serveur.',
    'Your session has expired. Please sign in again.': 'Votre session a expiré. Veuillez vous reconnecter.',
    'Request failed.': 'La requête a échoué.', 'Weak: needs ': 'Faible : il manque ', 'Passwords match.': 'Les mots de passe correspondent.',
    'Passwords do not match.': 'Les mots de passe ne correspondent pas.', 'Change password': 'Changer le mot de passe', 'developed by': 'développé par'
  };
  var lang = 'en';
  try { lang = sessionStorage.getItem('move-openlab-lang') === 'fr' ? 'fr' : 'en'; } catch (e) { /* storage unavailable */ }
  function tr(s) { return lang === 'fr' && FR[s] ? FR[s] : s; }
  (function localise() {
    var main = document.querySelector('main');
    if (!main) return;
    document.documentElement.setAttribute('lang', lang);
    if (lang === 'fr') {
      var w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT), nodes = [], x;
      while ((x = w.nextNode())) nodes.push(x);
      nodes.forEach(function (t) {
        var raw = t.nodeValue, key = raw.replace(/\\s+/g, ' ').trim();
        if (FR[key]) t.nodeValue = raw.replace(raw.trim(), FR[key]);
        else if (key.indexOf(' · developed by ') > 0) t.nodeValue = raw.replace('developed by', FR['developed by']);
      });
      document.title = document.title.replace('Sign in', FR['Sign in']).replace('Change password', FR['Change password']);
    }
    var box = document.createElement('div'); box.className = 'lang'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'language');
    ['en', 'fr'].forEach(function (l) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = l.toUpperCase(); b.lang = l; b.title = l === 'en' ? 'English' : 'Français';
      if (l === lang) b.className = 'on';
      b.setAttribute('aria-pressed', String(l === lang));
      b.addEventListener('click', function () { if (l === lang) return; try { sessionStorage.setItem('move-openlab-lang', l); } catch (e) { /* */ } location.reload(); });
      box.appendChild(b);
    });
    main.insertBefore(box, main.firstChild);
  })();
  var params = new URLSearchParams(location.search);
  function safeNext(n) { return n && n.charAt(0) === '/' && n.charAt(1) !== '/' && n.indexOf('/login') !== 0 ? n : '/'; }
  var next = safeNext(params.get('next'));
  function go(url) { location.replace(url); }
  function showError(form, msg) {
    var p = form.querySelector('.err');
    if (!p) { p = document.createElement('p'); p.className = 'err'; p.setAttribute('role', 'alert'); form.insertBefore(p, form.firstChild); }
    p.textContent = tr(msg);
  }
  function intercept(form, url, body, done) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
      fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) { if (x.ok) { done(x.d); } else { showError(form, x.d.detail || 'Request failed.'); if (btn) btn.disabled = false; } })
        .catch(function () { form.submit(); });
    });
  }
  var login = document.querySelector('form[action="/api/auth/login"]');
  if (login) intercept(login, '/api/auth/login', function () { return { username: login.username.value, password: login.password.value, next: next }; },
    function (d) { go(d.must_change_password ? '/change-password' : next); });
  var change = document.querySelector('form[action="/api/auth/change-password"]');
  if (change) intercept(change, '/api/auth/change-password', function () {
    return { current_password: change.current_password.value, new_password: change.new_password.value, confirm_password: change.confirm_password.value };
  }, function () { go('/'); });
  if (change) {
    var n = change.new_password, r = change.confirm_password, bar = document.getElementById('bar'),
        st = document.getElementById('strength'), mt = document.getElementById('match'), timer = null;
    var LEVEL = { weak: [tr('Weak: needs '), 33, 'var(--bad)'], acceptable: [tr('Acceptable'), 66, '#d4a72c'], strong: [tr('Strong'), 100, '#1a7f37'] };
    function paint(pol) {
      var l = LEVEL[pol.level] || LEVEL.weak;
      bar.style.width = n.value ? l[1] + '%' : '0'; bar.style.background = l[2];
      st.className = 'hint ' + pol.level; st.textContent = n.value ? (pol.level === 'weak' ? l[0] + pol.problems.join('; ') + '.' : l[0] + '.') : st.getAttribute('data-default');
    }
    function match() {
      if (!r.value) { mt.textContent = ''; mt.className = 'hint'; return; }
      var ok = r.value === n.value; mt.textContent = tr(ok ? 'Passwords match.' : 'Passwords do not match.'); mt.className = 'hint ' + (ok ? 'ok' : 'weak');
    }
    st.setAttribute('data-default', st.textContent);
    function check() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        fetch('/api/auth/password-policy', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: n.value }) })
          .then(function (x) { return x.json(); }).then(paint).catch(function () { /* the server decides on submit */ });
      }, 150);
      match();
    }
    n.addEventListener('input', check); r.addEventListener('input', match);
  }
})();
"""

LOGIN_ERRORS = {"invalid": "Invalid username or password.", "throttled": "Too many attempts. Try again later.",
                "unconfigured": "Sign-in is not configured on this server.",
                "expired": "Your session has expired. Please sign in again."}


def _page(title: str, body: str) -> str:
    return PAGE.format(title=html.escape(title), app=html.escape(APP_NAME), style=STYLE, body=body,
                       dev=html.escape(DEVELOPER), version=html.escape(display_version()))


@router.get("/auth.js", include_in_schema=False)
def auth_js():
    return Response(AUTH_JS, media_type="text/javascript", headers={"Cache-Control": "no-store"})


@router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, error: str | None = None, next: str | None = None, expired: str | None = None):
    if _auth(request).read(request.cookies.get(A.COOKIE_NAME)):
        return RedirectResponse(_safe_next(next), status_code=303)
    msg = LOGIN_ERRORS.get(error or ("expired" if expired else ""), "")
    body = LOGIN_BODY.format(app=html.escape(APP_NAME), subtitle=html.escape(APP_SUBTITLE),
                             error=f'<p class="err" role="alert">{html.escape(msg)}</p>' if msg else "",
                             next=html.escape(_safe_next(next), quote=True))
    return HTMLResponse(_page("Sign in", body))


@router.get("/change-password", response_class=HTMLResponse)
def change_password_page(request: Request, error: str | None = None):
    ses = request.state.session
    forced = ses.must_change_password
    body = CHANGE_BODY.format(intro="Your password is temporary: choose a personal password to continue." if forced
                              else "Choose a new personal password.", user=html.escape(ses.display),
                              error=f'<p class="err" role="alert">{html.escape(error)}</p>' if error else "",
                              cancel="" if forced else f'<a class="alt" href="/">Back to {html.escape(APP_NAME)}</a>')
    return HTMLResponse(_page("Change password", body))


# ------------------------------------------------------------------ request size
class BodyTooLarge(Exception):
    pass


class BodyLimit:
    """Pure ASGI middleware: refuses request bodies above a per-route limit before they are read or spooled to disk.
    The declared Content-Length is checked first, then the streamed byte count (a client can lie or omit it)."""

    def __init__(self, app, limits: list[tuple[str, int]], default: int):
        self.app, self.limits, self.default = app, limits, default

    def _limit(self, path: str) -> int:
        return next((n for prefix, n in self.limits if path.startswith(prefix)), self.default)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        limit = self._limit(scope["path"])
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            return await self._refuse(send, limit)
        seen = 0

        async def counted():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise BodyTooLarge
            return msg
        try:
            await self.app(scope, counted, send)
        except BodyTooLarge:
            await self._refuse(send, limit)

    @staticmethod
    async def _refuse(send, limit: int):
        body = json.dumps({"detail": f"request body larger than {limit // 2**20} MB"}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


# ------------------------------------------------------------------ guard + headers
class AuthGuard(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        auth: A.Auth = request.app.state.auth
        request.state.session = None
        if path not in PUBLIC_PATHS and not path.startswith((BRAND_PREFIX, FONT_PREFIX)):
            ses = auth.read(request.cookies.get(A.COOKIE_NAME))
            if ses is None:
                had_cookie = A.COOKIE_NAME in request.cookies
                if path.startswith("/api/"):
                    resp = JSONResponse({"detail": "authentication required"}, status_code=401)
                else:
                    target = "/login" + (f"?next={quote(path)}" if path not in ("/", "") else "")
                    if had_cookie:
                        target += ("&" if "?" in target else "?") + "expired=1"
                    resp = RedirectResponse(target, status_code=303)
                if had_cookie:
                    resp.delete_cookie(A.COOKIE_NAME, path="/")
                return _secure(resp, path, auth)
            request.state.session = ses
            if ses.must_change_password and path not in PASSWORD_CHANGE_PATHS:
                resp = (JSONResponse({"detail": "password change required", "code": "password_change_required"},
                                     status_code=403) if path.startswith("/api/")
                        else RedirectResponse("/change-password", status_code=303))
                return _secure(resp, path, auth)
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not _same_origin(request):
            return _secure(JSONResponse({"detail": "cross-origin request refused"}, status_code=403), path, auth)
        return _secure(await call_next(request), path, auth)


def _same_origin(request: Request) -> bool:
    """CSRF defence in depth (SameSite=Lax already blocks cross-site cookie POSTs): a browser Origin header, when
    present, must name this host."""
    origin = request.headers.get("origin")
    if not origin:
        return True
    return origin.split("://", 1)[-1].rstrip("/") == request.headers.get("host", "")


def _secure(resp: Response, path: str, auth: A.Auth) -> Response:
    h = resp.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
    h.setdefault("Content-Security-Policy", csp_for(auth.settings.tile_url) if hasattr(auth.settings, "tile_url") else CSP)
    if auth.settings.production:
        h.setdefault("Strict-Transport-Security", "max-age=31536000")
    if path.startswith("/api/") or path in ("/login", "/change-password"):
        h.setdefault("Cache-Control", "no-store")
    return resp


def mount_frontend(app, dist) -> bool:
    """Serve the built frontend when it exists (production). Development uses the Vite dev server."""
    index = dist / "index.html"
    if not index.exists():
        return False
    if (dist / "assets").exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    root = dist.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/") or full_path == "api":
            return JSONResponse({"detail": "not found"}, status_code=404)
        f = (root / full_path).resolve()
        if full_path and f.is_file() and root in f.parents:
            return FileResponse(f)
        return FileResponse(index, headers={"Cache-Control": "no-store"})
    return True
