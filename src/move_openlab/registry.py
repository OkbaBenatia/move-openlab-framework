"""Problem registry. Problems come from installed distributions only (entry-point group ``move_openlab.problems``),
so adding a problem is a packaging decision of the installation, never a side effect of importing data.

No module search path is modified: a problem package must be *installed* (``pip install ...``) to be discovered.
"""
from __future__ import annotations

import threading
from importlib.metadata import entry_points

from .problem import Problem

GROUP = "move_openlab.problems"
_lock = threading.Lock()
_problems: dict[str, Problem] | None = None
_errors: dict[str, str] = {}


class UnknownProblem(KeyError):
    pass


def _load() -> dict[str, Problem]:
    global _problems
    with _lock:
        if _problems is None:
            found: dict[str, Problem] = {}
            for ep in entry_points(group=GROUP):
                try:
                    obj = ep.load()
                    p = obj() if callable(obj) and not isinstance(obj, Problem) else obj
                    if not isinstance(p, Problem):
                        raise TypeError(f"{ep.value} does not provide a Problem")
                    if p.problem_id in found:
                        raise ValueError(f"duplicate problem id {p.problem_id!r}")
                    found[p.problem_id] = p
                except Exception as e:                       # reported by problems_status(), never hidden
                    _errors[ep.name] = f"{type(e).__name__}: {e}"
            _problems = found
        return _problems


def register(problem: Problem) -> None:
    """Explicit registration (tests, embedding applications)."""
    probs = _load()
    with _lock:
        if problem.problem_id in probs and probs[problem.problem_id] is not problem:
            raise ValueError(f"duplicate problem id {problem.problem_id!r}")
        probs[problem.problem_id] = problem


def get(problem_id: str) -> Problem:
    try:
        return _load()[problem_id]
    except KeyError:
        raise UnknownProblem(f"problem {problem_id!r} is not installed here") from None


def all_problems() -> list[Problem]:
    return sorted(_load().values(), key=lambda p: p.problem_id)


def load_errors() -> dict[str, str]:
    _load()
    return dict(_errors)
