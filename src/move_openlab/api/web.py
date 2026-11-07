"""Authentication endpoints, the access guard, security headers and single-origin frontend serving.

    /login, /change-password   server-rendered pages (work without JavaScript)
    /api/auth/*                login / logout / me / change-password
    /api/health                public health check
    /api/*                     protected API -> 401 JSON without a valid session
    /assets/*, /*              protected built frontend -> redirect to /login without a session
"""
from __future__ import annotations

import html
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.staticfiles import StaticFiles

from .. import auth as A
from ..version import APP_NAME, APP_SUBTITLE, DEVELOPER, app_version

PUBLIC_PATHS = {"/login", "/api/health", "/api/auth/login", "/api/auth/logout", "/favicon.svg", "/auth.js"}
PASSWORD_CHANGE_PATHS = {"/change-password", "/api/auth/change-password", "/api/auth/me", "/api/auth/logout",
                         "/favicon.svg", "/auth.js"}
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
    return {"status": "ok", "app": APP_NAME, "version": app_version()}


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
    return {"user": dict(username=ses.username, display=ses.display, role=ses.role, expires_at=int(ses.exp),
                         must_change_password=ses.must_change_password) if ses else None}


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
STYLE = """:root{--bg:#f6f7f9;--panel:#fff;--border:#dde2e8;--text:#161a20;--muted:#5b6573;--accent:#1f5fd1;--bad:#c62828;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--panel:#171c23;--border:#2b3440;--text:#e7ebf0;--muted:#a0aab6;--accent:#6ea2ff;--bad:#f0554f;color-scheme:dark}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px 24px}
h1{font-size:21px;margin:0}.sub{margin:4px 0 20px;color:var(--muted);font-size:13px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 5px}
input{width:100%;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0 0 14px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;font:inherit;font-weight:700;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:11px;cursor:pointer;margin-top:4px}
.err{color:var(--bad);font-size:13px;margin:-6px 0 14px}.alt{display:block;text-align:center;margin-top:12px;font-size:13px;color:var(--accent)}
.linkbtn{background:none;color:var(--muted);font-weight:500;padding:6px}footer{margin-top:18px;color:var(--muted);font-size:11.5px;text-align:center}"""

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · {app}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>{style}</style></head>
<body><main>{body}<footer>{app} · developed by {dev} · v{version}</footer></main><script src="/auth.js" defer></script></body></html>"""

LOGIN_BODY = """<h1>{app}</h1><p class="sub">{subtitle}</p>
<form method="post" action="/api/auth/login" autocomplete="on">{error}
<input type="hidden" name="next" value="{next}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>"""

CHANGE_BODY = """<h1>Change password</h1><p class="sub">{intro} Signed in as <b>{user}</b>.</p>
<form method="post" action="/api/auth/change-password" autocomplete="off">{error}
<label for="c">Current password</label><input id="c" name="current_password" type="password" autocomplete="current-password" required autofocus>
<label for="n">New password (at least 12 characters)</label><input id="n" name="new_password" type="password" autocomplete="new-password" minlength="12" required>
<label for="r">Confirm new password</label><input id="r" name="confirm_password" type="password" autocomplete="new-password" minlength="12" required>
<button type="submit">Save new password</button></form>{cancel}
<form method="post" action="/api/auth/logout"><button class="linkbtn" type="submit">Log out</button></form>"""

AUTH_JS = """(function () {
  var params = new URLSearchParams(location.search);
  function safeNext(n) { return n && n.charAt(0) === '/' && n.charAt(1) !== '/' && n.indexOf('/login') !== 0 ? n : '/'; }
  var next = safeNext(params.get('next'));
  function go(url) { location.replace(url); }
  function showError(form, msg) {
    var p = form.querySelector('.err');
    if (!p) { p = document.createElement('p'); p.className = 'err'; p.setAttribute('role', 'alert'); form.insertBefore(p, form.firstChild); }
    p.textContent = msg;
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
})();
"""

LOGIN_ERRORS = {"invalid": "Invalid username or password.", "throttled": "Too many attempts. Try again later.",
                "unconfigured": "Sign-in is not configured on this server.",
                "expired": "Your session has expired. Please sign in again."}


def _page(title: str, body: str) -> str:
    return PAGE.format(title=html.escape(title), app=html.escape(APP_NAME), style=STYLE, body=body,
                       dev=html.escape(DEVELOPER), version=html.escape(app_version()))


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


# ------------------------------------------------------------------ guard + headers
class AuthGuard(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        auth: A.Auth = request.app.state.auth
        request.state.session = None
        if path not in PUBLIC_PATHS:
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
