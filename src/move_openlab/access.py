"""Per-account access to restricted problems.

A problem package may declare itself *restricted* (``Problem.restricted = True``): unpublished research, licensed
data, anything an installation must not show to every account. A restricted problem is visible only to the accounts
an administrator granted it to. The grant is installation data (``<data>/problem-grants.json``, owner-only), never
code, and no role implies it: an administrator who is not listed sees the package in the extension registry (identifier
and title only) and nothing else. Problems that are not restricted — every problem shipped with the framework — are
open to all accounts of the installation, and an installation without restricted packages has nothing to grant.

Enforcement is on the server, at the workspace: a problem an account is not granted behaves exactly like a problem that
is not installed (listings omit it; lookups, experiments, scenarios, imports and exports answer "not found").
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from .problem import Problem

GRANTS = "problem-grants.json"
USERNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_lock = threading.Lock()


class Access:
    def __init__(self, data_dir: Path):
        self.file = Path(data_dir) / GRANTS

    def grants(self) -> dict[str, list[str]]:
        """``{problem_id: [username, ...]}``; a missing or unreadable file grants nothing (fail closed)."""
        try:
            raw = json.loads(self.file.read_text())
        except (OSError, ValueError):
            return {}
        if not isinstance(raw, dict):
            return {}
        return {str(k): sorted({u for u in v if isinstance(u, str) and USERNAME.match(u)})
                for k, v in raw.items() if isinstance(v, list)}

    def granted(self, problem_id: str) -> list[str]:
        return self.grants().get(problem_id, [])

    def allows(self, problem: Problem, username: str) -> bool:
        return not getattr(problem, "restricted", False) or username in self.granted(problem.problem_id)

    def set(self, problem_id: str, usernames: list[str]) -> list[str]:
        """Replace the accounts granted a restricted problem; returns the stored list."""
        users = sorted({u for u in usernames if isinstance(u, str) and USERNAME.match(u)})
        if len(users) != len(set(usernames)):
            raise ValueError("invalid account name in the grant")
        with _lock:
            cur = self.grants()
            if users:
                cur[problem_id] = users
            else:
                cur.pop(problem_id, None)
            tmp = self.file.with_name(self.file.name + ".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(cur, f, indent=1, sort_keys=True)
            os.replace(tmp, self.file)
        return users
