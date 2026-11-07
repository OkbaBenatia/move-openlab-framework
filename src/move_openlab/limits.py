"""Fair-use limits for downloads from external public services (Overpass, data.gouv.fr).

* :class:`DailyQuota` — at most N requests per user per rolling 24 hours (in memory: reset on restart).
* :data:`SERIAL` — one lock per service, so the installation sends one download at a time to each service; jobs wait
  for their turn (their trace shows the wait) instead of running in parallel.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class QuotaExceeded(RuntimeError):
    pass


class DailyQuota:
    def __init__(self, per_day: int):
        self.per_day = per_day
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def take(self, user: str) -> None:
        now = time.time()
        with self._lock:
            q = self._hits[user]
            while q and now - q[0] > 86400:
                q.popleft()
            if len(q) >= self.per_day:
                raise QuotaExceeded(f"daily limit of {self.per_day} downloads reached for this service; "
                                    "reuse a stored resource or try tomorrow")
            q.append(now)


SERIAL = {"overpass": threading.Lock(), "data.gouv.fr": threading.Lock()}
