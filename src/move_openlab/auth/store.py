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

ROLES = ("admin", "researcher")
SCHEMA_VERSION = 1
# target version -> SQL that upgrades from the previous version; applied in order, inside one transaction each
MIGRATIONS: dict[int, str] = {}

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
  created_by TEXT NOT NULL DEFAULT ''
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

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


class UserStore:
    def __init__(self, path: Optional[Path]):
        self.persistent = path is not None
        self._lock = threading.Lock()
        if path is not None:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
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
            if target in MIGRATIONS:
                c.executescript(MIGRATIONS[target])
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
        return User(r["username"], r["display_name"], r["password_hash"], r["role"], bool(r["active"]),
                    bool(r["must_change_password"]), int(r["session_version"]), float(r["created_at"]),
                    r["last_login_at"], r["created_by"])

    def get(self, username: str) -> Optional[User]:
        with self._conn() as c:
            return self._row(c.execute("SELECT * FROM users WHERE username = ?",
                                       (_norm(username),)).fetchone())

    def list(self) -> list[User]:
        with self._conn() as c:
            return [self._row(r) for r in c.execute("SELECT * FROM users ORDER BY created_at, username")]

    def count(self) -> int:
        with self._conn() as c:
            return int(c.execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def create(self, username: str, display_name: str, password_hash: str, role: str = "researcher",
               must_change: bool = True, created_by: str = "") -> bool:
        if role not in ROLES:
            raise ValueError(f"unknown role {role!r}")
        now = time.time()
        with self._lock, self._conn() as c:
            cur = c.execute("INSERT OR IGNORE INTO users (username, display_name, password_hash, role, active, "
                            "must_change_password, session_version, created_at, updated_at, created_by) "
                            "VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)",
                            (_norm(username), display_name, password_hash, role, int(must_change), now, now,
                             created_by))
            return cur.rowcount == 1

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
