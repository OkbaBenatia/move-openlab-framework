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
from .store import ROLES, User, UserStore

COOKIE_NAME = "move_openlab_session"
SCRYPT_N, SCRYPT_R, SCRYPT_P, DKLEN = 2 ** 15, 8, 1, 32
MAX_FAILURES, FAILURE_WINDOW_S = 10, 15 * 60
MIN_SECRET_LEN = 32
MIN_PASSWORD_LEN = 12
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")


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

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


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
                      user.session_version, user.must_change_password, user.role)
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
                       user.must_change_password, user.role)

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
        if len(new or "") < MIN_PASSWORD_LEN:
            return None, f"The new password must contain at least {MIN_PASSWORD_LEN} characters."
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
        return dict(username=u.username, display=u.display_name, role=u.role, active=u.active,
                    must_change_password=u.must_change_password, created_at=int(u.created_at),
                    last_login_at=int(u.last_login_at) if u.last_login_at else None, created_by=u.created_by or None)

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
                    password: Optional[str] = None) -> tuple[User, str]:
        """Operator command: creates an account with a temporary password (returned once) or the given password;
        the user must change it at first sign-in either way."""
        username = (username or "").strip().lower()
        display_name = " ".join((display_name or "").split())
        if not USERNAME_RE.match(username):
            raise ValueError("username: 2 to 32 characters, lowercase letters, digits, '.', '_' or '-'")
        if not 2 <= len(display_name) <= 80:
            raise ValueError("display name: 2 to 80 characters")
        if role not in ROLES:
            raise ValueError(f"role must be one of {ROLES}")
        temp = password or new_temporary_password()
        if password is not None and len(password) < MIN_PASSWORD_LEN:
            raise ValueError(f"password must contain at least {MIN_PASSWORD_LEN} characters")
        if not self.store.create(username, display_name, hash_password(temp), role, must_change=True, created_by=created_by):
            raise ValueError("this username already exists")
        return self.store.get(username), temp
