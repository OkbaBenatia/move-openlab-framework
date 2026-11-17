"""First-run setup: the person who installed MOVE OpenLab creates the first administrator in the browser.

An installation with no account yet is in *setup mode*. Creating the first administrator needs a **setup key**: 32
random bytes written, owner-only, to ``<data>/setup-key`` when the server starts in setup mode. Only the operating-system
account that runs MOVE OpenLab can read that file, so only it can open the setup link (``move-openlab open`` and the
desktop launcher put the key in the link's ``#fragment``, which browsers never send to a server or write to its log).
The request must also come from this computer (loopback address). Setup mode ends for good with the first account:
the key file is deleted and the setup endpoints answer 404. An installation that already has accounts never enters it.

Nothing here is printed or logged: neither the key nor the password.
"""
from __future__ import annotations

import hmac
import ipaddress
import secrets
import threading
from pathlib import Path
from typing import Optional

from .. import privatefiles

KEY_FILE = "setup-key"
_lock = threading.Lock()


def key_path(data_dir: Path) -> Path:
    return Path(data_dir) / KEY_FILE


def needed(auth) -> bool:
    """True while the installation has no account at all."""
    return auth.store.count() == 0


def ensure_key(data_dir: Path) -> Optional[str]:
    """The setup key of this installation, created (owner-only) if missing. Restarting during setup keeps the key."""
    p = key_path(data_dir)
    with _lock:
        try:
            k = p.read_text().strip()
            if len(k) >= 32:
                privatefiles.tighten(p)
                return k
        except OSError:
            pass
        k = secrets.token_urlsafe(32)
        privatefiles.write(p, k)
        return k


def read_key(data_dir: Path) -> Optional[str]:
    try:
        k = key_path(data_dir).read_text().strip()
    except OSError:
        return None
    return k if len(k) >= 32 else None


def discard_key(data_dir: Path) -> None:
    try:
        key_path(data_dir).unlink()
    except FileNotFoundError:
        pass


def key_matches(data_dir: Path, offered: str) -> bool:
    k = read_key(data_dir)
    return bool(k and offered) and hmac.compare_digest(k.encode(), offered.strip().encode())


def is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address((host or "").split("%")[0]).is_loopback
    except ValueError:
        return False


def create_admin(auth, data_dir: Path, *, key: str, username: str, display_name: str, password: str, confirm: str,
                 client: str) -> tuple[Optional[object], str, int]:
    """Create the first administrator. Returns (user, message, HTTP status). The password is checked by the same
    policy as every other password and stored only as its scrypt hash; the account needs no password change."""
    from . import USERNAME_RE, hash_password, password_policy
    if not needed(auth):
        return None, "setup is already complete", 404
    if not is_loopback(client):
        return None, "the first administrator can only be created on this computer", 403
    if not key_matches(data_dir, key):
        return None, "the setup link is missing or invalid: open MOVE OpenLab from its launcher or run 'move-openlab open'", 403
    username = (username or "").strip().lower()
    display_name = " ".join((display_name or "").split())
    if not USERNAME_RE.match(username):
        return None, "username: 2 to 32 characters, lowercase letters, digits, '.', '_' or '-'", 400
    if not 2 <= len(display_name) <= 80:
        return None, "display name: 2 to 80 characters", 400
    if password != confirm:
        return None, "the two passwords do not match", 400
    pol = password_policy(password, username, display_name)
    if not pol["ok"]:
        return None, "password: " + "; ".join(pol["problems"]), 400
    if not auth.store.create_first(username, display_name, hash_password(password), created_by="first-run setup"):
        return None, "setup is already complete", 404
    discard_key(data_dir)
    return auth.store.get(username), "", 200
