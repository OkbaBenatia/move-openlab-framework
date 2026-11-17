"""Local credential store (SQLite file, or in-process memory for tests). Only scrypt hashes are stored.

Accounts are created by an operator with ``move-openlab users add`` and always start with ``must_change_password``;
nothing in the web API can create the first account. Accounts are deactivated, never deleted, by the application.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .. import privatefiles

ROLES = ("admin", "researcher", "student")
ROLE_LABELS = {"admin": "Administrator", "researcher": "Researcher", "student": "Student"}
SCHEMA_VERSION = 2
# target version -> SQL that upgrades from the previous version (columns added only when missing, so a database
# created from the current SCHEMA and an older database both end at the same shape); one transaction each
MIGRATIONS: dict[int, list[tuple[str, str]]] = {
    2: [("supervisor", "ALTER TABLE users ADD COLUMN supervisor TEXT"),           # username of the owning researcher
        ("can_supervise", "ALTER TABLE users ADD COLUMN can_supervise INTEGER NOT NULL DEFAULT 0")],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'researcher',
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  updated_at REAL,
  password_changed_at REAL,
  last_login_at REAL,
  created_by TEXT NOT NULL DEFAULT '',
  supervisor TEXT,
  can_supervise INTEGER NOT NULL DEFAULT 0
);
"""


def _norm(username: str) -> str:
    return (username or "").strip().lower()


@dataclass(frozen=True)
class User:
    username: str
    display_name: str
    password_hash: str
    role: str
    active: bool
    must_change_password: bool
    session_version: int
    created_at: float
    last_login_at: Optional[float]
    created_by: str
    supervisor: Optional[str] = None            # students: the researcher who owns the account
    can_supervise: bool = False                 # researchers: may create and manage their own students

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_supervisor(self) -> bool:
        return self.role == "researcher" and self.can_supervise


class UserStore:
    def __init__(self, path: Optional[Path]):
        self.persistent = path is not None
        self._lock = threading.Lock()
        if path is not None:
            # owner-only from the start (0600), and an existing wider file is tightened: it holds password hashes
            privatefiles.ensure(path)
            for side in ("-journal", "-wal", "-shm"):
                privatefiles.tighten(f"{path}{side}")
            self._uri, self._is_uri, self._keeper = str(path), False, None
        else:                                       # shared in-process DB kept alive by one open connection
            self._uri, self._is_uri = f"file:move_openlab_auth_{id(self)}?mode=memory&cache=shared", True
            self._keeper = sqlite3.connect(self._uri, uri=True, check_same_thread=False)
        with self._conn() as c:
            c.executescript(SCHEMA)
            self._migrate(c)

    @staticmethod
    def _migrate(c: sqlite3.Connection) -> None:
        """``PRAGMA user_version`` records the schema version; version 0 is the original schema (baseline)."""
        v = int(c.execute("PRAGMA user_version").fetchone()[0])
        if v > SCHEMA_VERSION:
            raise RuntimeError(f"credential store schema {v} is newer than this version of MOVE OpenLab ({SCHEMA_VERSION})")
        for target in range(max(v, 0) + 1, SCHEMA_VERSION + 1):
            cols = {r[1] for r in c.execute("PRAGMA table_info(users)")}
            for col, sql in MIGRATIONS.get(target, []):
                if col not in cols:
                    c.execute(sql)
            c.execute(f"PRAGMA user_version = {target}")
        c.commit()

    @contextmanager
    def _conn(self):
        """One connection per operation: committed on success, rolled back on error, always closed."""
        c = sqlite3.connect(self._uri, uri=self._is_uri, timeout=10, check_same_thread=False)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()

    @staticmethod
    def _row(r) -> Optional[User]:
        if r is None:
            return None
        keys = r.keys()
        return User(r["username"], r["display_name"], r["password_hash"], r["role"], bool(r["active"]),
                    bool(r["must_change_password"]), int(r["session_version"]), float(r["created_at"]),
                    r["last_login_at"], r["created_by"], r["supervisor"] if "supervisor" in keys else None,
                    bool(r["can_supervise"]) if "can_supervise" in keys else False)

    def get(self, username: str) -> Optional[User]:
        with self._conn() as c:
            return self._row(c.execute("SELECT * FROM users WHERE username = ?",
                                       (_norm(username),)).fetchone())

    def list(self, supervisor: Optional[str] = None) -> list[User]:
        """Every account, or only the students owned by ``supervisor``."""
        with self._conn() as c:
            if supervisor is not None:
                rows = c.execute("SELECT * FROM users WHERE supervisor = ? AND role = 'student' ORDER BY created_at, username",
                                 (_norm(supervisor),))
            else:
                rows = c.execute("SELECT * FROM users ORDER BY created_at, username")
            return [self._row(r) for r in rows]

    def count(self) -> int:
        with self._conn() as c:
            return int(c.execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def create(self, username: str, display_name: str, password_hash: str, role: str = "researcher",
               must_change: bool = True, created_by: str = "", supervisor: Optional[str] = None) -> bool:
        if role not in ROLES:
            raise ValueError(f"unknown role {role!r}")
        now = time.time()
        with self._lock, self._conn() as c:
            cur = c.execute("INSERT OR IGNORE INTO users (username, display_name, password_hash, role, active, "
                            "must_change_password, session_version, created_at, updated_at, created_by, supervisor) "
                            "VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?)",
                            (_norm(username), display_name, password_hash, role, int(must_change), now, now,
                             created_by, _norm(supervisor) if supervisor else None))
            return cur.rowcount == 1

    def create_first(self, username: str, display_name: str, password_hash: str, created_by: str) -> bool:
        """Create the first account, an administrator, only if the store is still empty — one transaction holding the
        write lock (``BEGIN IMMEDIATE``), so two concurrent first-run requests (threads or processes) cannot both win."""
        now = time.time()
        with self._lock, self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            if int(c.execute("SELECT COUNT(*) FROM users").fetchone()[0]):
                return False
            c.execute("INSERT INTO users (username, display_name, password_hash, role, active, must_change_password, "
                      "session_version, created_at, updated_at, created_by, supervisor) VALUES (?, ?, ?, 'admin', 1, 0, 1, ?, ?, ?, NULL)",
                      (_norm(username), display_name, password_hash, now, now, created_by))
            return True

    def set_supervision(self, username: str, can_supervise: bool) -> None:
        with self._lock, self._conn() as c:
            c.execute("UPDATE users SET can_supervise = ?, updated_at = ? WHERE username = ?",
                      (int(can_supervise), time.time(), _norm(username)))

    def set_supervisor(self, username: str, supervisor: Optional[str]) -> None:
        with self._lock, self._conn() as c:
            c.execute("UPDATE users SET supervisor = ?, updated_at = ? WHERE username = ?",
                      (_norm(supervisor) if supervisor else None, time.time(), _norm(username)))

    def set_password(self, username: str, password_hash: str, must_change: bool) -> None:
        now = time.time()
        with self._lock, self._conn() as c:
            c.execute("UPDATE users SET password_hash = ?, must_change_password = ?, session_version = session_version + 1, "
                      "password_changed_at = ?, updated_at = ? WHERE username = ?",
                      (password_hash, int(must_change), now, now, _norm(username)))

    def set_active(self, username: str, active: bool) -> None:
        with self._lock, self._conn() as c:
            c.execute("UPDATE users SET active = ?, session_version = session_version + 1, updated_at = ? WHERE username = ?",
                      (int(active), time.time(), _norm(username)))

    def touch_login(self, username: str) -> None:
        with self._lock, self._conn() as c:
            c.execute("UPDATE users SET last_login_at = ? WHERE username = ?", (time.time(), _norm(username)))
