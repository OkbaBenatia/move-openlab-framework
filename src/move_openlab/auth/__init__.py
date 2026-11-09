"""Server-side authentication for MOVE OpenLab.

* Passwords: scrypt (Python standard library), stored as ``scrypt$<n>$<r>$<p>$<salt_b64>$<hash_b64>``.
* Sessions: HMAC-SHA256-signed token in an HttpOnly cookie carrying the user's ``session_version``; a password change
  or a deactivation bumps the version and invalidates every older session, even across restarts. Logout also revokes
  the token in memory.
* Fail closed: without a usable signing key nobody can sign in. Production requires ``SESSION_SECRET``; development
  falls back to an ephemeral per-process key.
* Throttling: 10 failures per username or client within 15 minutes block further attempts.
* Roles: ``admin`` and ``researcher``. Each signed-in user works in their own workspace.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Optional

from ..settings import Settings
from .store import ROLE_LABELS, ROLES, User, UserStore

COOKIE_NAME = "move_openlab_session"
SCRYPT_N, SCRYPT_R, SCRYPT_P, DKLEN = 2 ** 15, 8, 1, 32
MAX_FAILURES, FAILURE_WINDOW_S = 10, 15 * 60
MIN_SECRET_LEN = 32
MIN_PASSWORD_LEN = 12
STRONG_PASSWORD_LEN = 16
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")
_CLASSES = (re.compile(r"[a-z]"), re.compile(r"[A-Z]"), re.compile(r"[0-9]"), re.compile(r"[^A-Za-z0-9]"))


def password_policy(password: str, username: str = "", display_name: str = "") -> dict:
    """The server's password policy (authoritative; the sign-in pages mirror it for live feedback).

    ``level``: ``weak`` (refused), ``acceptable`` (meets the policy) or ``strong``. Refused when shorter than
    ``MIN_PASSWORD_LEN``, when it uses fewer than three of the four character classes (lower, upper, digit, other),
    when it is a single repeated character, or when it contains the username or a word of the display name."""
    pw = password or ""
    problems = []
    if len(pw) < MIN_PASSWORD_LEN:
        problems.append(f"at least {MIN_PASSWORD_LEN} characters")
    classes = sum(1 for c in _CLASSES if c.search(pw))
    if classes < 3:
        problems.append("three kinds of characters among lower case, upper case, digits and symbols")
    if pw and len(set(pw)) < 4:
        problems.append("more varied characters")
    low = pw.casefold()
    words = [w for w in [username.casefold()] + display_name.casefold().split() if len(w) >= 3]
    if any(w in low for w in words):
        problems.append("nothing taken from your username or name")
    if problems:
        return dict(level="weak", ok=False, problems=problems)
    strong = len(pw) >= STRONG_PASSWORD_LEN and classes == 4
    return dict(level="strong" if strong else "acceptable", ok=True, problems=[])


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hash_password(password: str, *, n: int = SCRYPT_N, r: int = SCRYPT_R, p: int = SCRYPT_P) -> str:
    if not password:
        raise ValueError("empty password")
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=DKLEN, maxmem=256 * 1024 * 1024)
    return f"scrypt${n}${r}${p}${_b64e(salt)}${_b64e(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        want = _b64d(dk)
        got = hashlib.scrypt(password.encode(), salt=_b64d(salt), n=int(n), r=int(r), p=int(p), dklen=len(want),
                             maxmem=256 * 1024 * 1024)
        return hmac.compare_digest(got, want)
    except Exception:
        return False


def new_temporary_password() -> str:
    return secrets.token_urlsafe(12)


@dataclass(frozen=True)
class Session:
    username: str
    display: str
    sid: str
    exp: float
    version: int
    must_change_password: bool
    role: str = "researcher"
    can_supervise: bool = False

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_supervisor(self) -> bool:
        return self.role == "researcher" and self.can_supervise


class Auth:
    def __init__(self, settings: Settings, store: Optional[UserStore] = None):
        self.settings = settings
        self.store = store or UserStore(settings.auth_db)
        s = settings.session_secret
        if len(s) >= MIN_SECRET_LEN:
            self._secret: Optional[bytes] = s.encode()
        else:
            self._secret = None if settings.production else secrets.token_bytes(32)
        self._revoked: dict[str, float] = {}
        self._failures: dict[str, list[float]] = {}
        self._lock = threading.Lock()
        self._dummy = hash_password(secrets.token_urlsafe(16))

    # ------------------------------------------------------------------ status
    def sign_in_possible(self) -> bool:
        return self._secret is not None and self.store.count() > 0

    # ------------------------------------------------------------------ sessions
    def issue(self, user: User, now: Optional[float] = None) -> tuple[str, Session]:
        if self._secret is None:
            raise RuntimeError("SESSION_SECRET not configured")
        now = time.time() if now is None else now
        ses = Session(user.username, user.display_name, secrets.token_urlsafe(12), now + self.settings.session_ttl_s,
                      user.session_version, user.must_change_password, user.role, user.can_supervise)
        payload = _b64e(json.dumps(dict(u=ses.username, sid=ses.sid, v=ses.version, iat=int(now), exp=int(ses.exp)),
                                   separators=(",", ":")).encode())
        sig = _b64e(hmac.new(self._secret, payload.encode(), hashlib.sha256).digest())
        return f"{payload}.{sig}", ses

    def read(self, token: Optional[str], now: Optional[float] = None) -> Optional[Session]:
        """A valid, unexpired, unrevoked session of an existing, active user whose session_version still matches."""
        if not token or self._secret is None or "." not in token:
            return None
        payload, sig = token.rsplit(".", 1)
        want = _b64e(hmac.new(self._secret, payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, want):
            return None
        try:
            d = json.loads(_b64d(payload))
        except Exception:
            return None
        now = time.time() if now is None else now
        if float(d.get("exp", 0)) <= now:
            return None
        with self._lock:
            if d.get("sid") in self._revoked:
                return None
        user = self.store.get(str(d.get("u", "")))
        if user is None or not user.active or int(d.get("v", -1)) != user.session_version:
            return None
        return Session(user.username, user.display_name, d["sid"], float(d["exp"]), user.session_version,
                       user.must_change_password, user.role, user.can_supervise)

    def revoke(self, ses: Session) -> None:
        with self._lock:
            now = time.time()
            for sid in [s for s, e in self._revoked.items() if e <= now]:
                del self._revoked[sid]
            self._revoked[ses.sid] = ses.exp

    # ------------------------------------------------------------------ credentials
    def authenticate(self, username: str, password: str, client: str = "") -> tuple[Optional[User], str]:
        """(account, "") or (None, reason) with reason in {"invalid", "throttled", "unconfigured"}."""
        if not self.sign_in_possible():
            return None, "unconfigured"
        uname = (username or "").strip().lower()
        keys = [f"u:{uname}", f"c:{client}"]
        now = time.time()
        with self._lock:
            for k in keys:
                self._failures[k] = [t for t in self._failures.get(k, []) if now - t < FAILURE_WINDOW_S]
            if any(len(self._failures[k]) >= MAX_FAILURES for k in keys):
                return None, "throttled"
        acc = self.store.get(uname)
        ok = verify_password(password or "", acc.password_hash if acc else self._dummy)
        if acc is not None and ok and acc.active:          # deactivated: same generic error as a wrong password
            with self._lock:
                self._failures.pop(f"u:{uname}", None)
            self.store.touch_login(acc.username)
            return acc, ""
        with self._lock:
            for k in keys:
                self._failures.setdefault(k, []).append(now)
        return None, "invalid"

    def change_password(self, ses: Session, current: str, new: str, confirm: str, client: str = "") -> tuple[Optional[User], str]:
        acc, why = self.authenticate(ses.username, current, client)
        if acc is None:
            return None, "Too many attempts. Try again later." if why == "throttled" else "The current password is incorrect."
        pol = password_policy(new or "", acc.username, acc.display_name)
        if not pol["ok"]:
            return None, "The new password needs " + "; ".join(pol["problems"]) + "."
        if new != confirm:
            return None, "The new password and its confirmation do not match."
        if hmac.compare_digest(new.encode(), (current or "").encode()):
            return None, "The new password must differ from the current password."
        self.store.set_password(acc.username, hash_password(new), must_change=False)
        return self.store.get(acc.username), ""

    # ------------------------------------------------------------------ administration
    @staticmethod
    def public_user(u: User) -> dict:
        """What an administrator may see about an account: never a hash or a password."""
        return dict(username=u.username, display=u.display_name, role=u.role, role_label=ROLE_LABELS.get(u.role, u.role),
                    active=u.active, must_change_password=u.must_change_password, created_at=int(u.created_at),
                    last_login_at=int(u.last_login_at) if u.last_login_at else None, created_by=u.created_by or None,
                    supervisor=u.supervisor, can_supervise=u.can_supervise)

    def reset_password(self, username: str) -> tuple[User, str]:
        """New temporary password (returned once), forced change at next sign-in, every older session invalidated."""
        u = self.store.get(username)
        if u is None:
            raise KeyError("unknown user")
        temp = new_temporary_password()
        self.store.set_password(u.username, hash_password(temp), must_change=True)
        with self._lock:
            self._failures.pop(f"u:{u.username}", None)
        return self.store.get(u.username), temp

    def set_active(self, actor: str, username: str, active: bool) -> User:
        u = self.store.get(username)
        if u is None:
            raise KeyError("unknown user")
        if not active and u.username == actor:
            raise ValueError("you cannot deactivate your own account")
        if not active and u.is_admin and u.active and sum(1 for x in self.store.list() if x.is_admin and x.active) <= 1:
            raise ValueError("the last active administrator cannot be deactivated")
        self.store.set_active(u.username, active)            # bumps the session version: open sessions end
        return self.store.get(u.username)

    def create_user(self, username: str, display_name: str, role: str = "researcher", created_by: str = "operator",
                    password: Optional[str] = None, supervisor: Optional[str] = None) -> tuple[User, str]:
        """Creates an account with a temporary password (returned once) or the given password; the user must change
        it at first sign-in either way. A student carries the username of the researcher who owns the account."""
        username = (username or "").strip().lower()
        display_name = " ".join((display_name or "").split())
        if not USERNAME_RE.match(username):
            raise ValueError("username: 2 to 32 characters, lowercase letters, digits, '.', '_' or '-'")
        if not 2 <= len(display_name) <= 80:
            raise ValueError("display name: 2 to 80 characters")
        if role not in ROLES:
            raise ValueError(f"role must be one of {ROLES}")
        if role == "student":
            sup = self.store.get(supervisor or "")
            if sup is None or not (sup.is_supervisor or sup.is_admin) or not sup.active:
                raise ValueError("a student needs an active supervising researcher (or an administrator) as supervisor")
            supervisor = sup.username
        elif supervisor:
            raise ValueError("only students have a supervisor")
        temp = password or new_temporary_password()
        if password is not None and not password_policy(password, username, display_name)["ok"]:
            raise ValueError("password: " + "; ".join(password_policy(password, username, display_name)["problems"]))
        if not self.store.create(username, display_name, hash_password(temp), role, must_change=True, created_by=created_by,
                                 supervisor=supervisor):
            raise ValueError("this username already exists")
        return self.store.get(username), temp

    # ------------------------------------------------------------------ supervision
    def set_supervision(self, username: str, can_supervise: bool) -> User:
        u = self.store.get(username)
        if u is None:
            raise KeyError("unknown user")
        if u.role != "researcher":
            raise ValueError("only researchers can supervise students")
        self.store.set_supervision(u.username, can_supervise)
        return self.store.get(u.username)

    def set_supervisor(self, username: str, supervisor: Optional[str]) -> User:
        u = self.store.get(username)
        if u is None:
            raise KeyError("unknown user")
        if u.role != "student":
            raise ValueError("only students have a supervisor")
        if supervisor:
            sup = self.store.get(supervisor)
            if sup is None or not (sup.is_supervisor or sup.is_admin):
                raise ValueError("the supervisor must be a supervising researcher or an administrator")
            supervisor = sup.username
        self.store.set_supervisor(u.username, supervisor)
        return self.store.get(u.username)

    def own_student(self, supervisor: str, username: str) -> User:
        """The student ``username`` if, and only if, it belongs to ``supervisor`` (KeyError otherwise: the existence
        of other accounts is not revealed)."""
        u = self.store.get(username)
        if u is None or u.role != "student" or u.supervisor != supervisor:
            raise KeyError("unknown student")
        return u
