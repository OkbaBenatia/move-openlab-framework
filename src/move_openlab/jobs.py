"""Background jobs: persistent status, stage progress, event log, cancellation and history.

Each job runs in one worker thread and belongs to one user, who alone can see or cancel it. Job records are written to
``<data>/jobs/<user>/<job_id>.json`` on every state change (progress at most every 0.5 s), so status and history survive
a restart. Jobs that were running when the server stopped are marked ``interrupted`` at the next start.

States: ``running`` → ``done`` | ``error`` | ``cancelled`` | ``interrupted``. Failures are kept and reported.
The event log is the execution trace of the job: timestamped stage events (bounded to the last 2000).
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Callable

MAX_EVENTS = 2000
MAX_KEPT_IN_MEMORY = 500
FINAL = ("done", "error", "cancelled", "interrupted")
SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class Monitor:
    """Handed to the work function. Callable as ``progress(done, total)`` (backwards compatible); ``event`` records a
    trace event; ``cancel`` is a ``threading.Event`` set when the user cancels."""

    def __init__(self, jobs: "Jobs", job: dict):
        self._jobs, self._job = jobs, job
        self.cancel = threading.Event()

    def __call__(self, done: int, total: int) -> None:
        self._job.update(done=done, total=total)
        self._jobs._save(self._job, throttle=True)

    def event(self, stage: str, message: str, **data) -> None:
        ev = dict(t=round(time.time() - self._job["started_at"], 3), stage=stage, message=message, **data)
        self._job["events"].append(ev)
        if len(self._job["events"]) > MAX_EVENTS:
            del self._job["events"][: len(self._job["events"]) - MAX_EVENTS]
        self._job["stage"] = stage
        self._jobs._save(self._job, throttle=True)


class Jobs:
    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root else None
        self._jobs: dict[str, dict] = {}
        self._monitors: dict[str, Monitor] = {}
        self._lock = threading.Lock()
        self._last_save: dict[str, float] = {}

    # ------------------------------------------------------------------ persistence
    def _path(self, owner: str, jid: str) -> Path | None:
        if not self.root or not SAFE.match(owner) or not SAFE.match(jid):
            return None
        return self.root / owner / f"{jid}.json"

    def _save(self, job: dict, throttle: bool = False) -> None:
        p = self._path(job["owner"], job["job_id"])
        if p is None:
            return
        now = time.time()
        if throttle and now - self._last_save.get(job["job_id"], 0) < 0.5:
            return
        self._last_save[job["job_id"]] = now
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(f".tmp{os.getpid()}.{threading.get_ident()}")
        tmp.write_text(json.dumps(job))
        os.replace(tmp, p)

    def recover(self) -> list[dict]:
        """Mark jobs left running by a previous process as interrupted. Returns them."""
        out = []
        if not self.root or not self.root.exists():
            return out
        for f in self.root.glob("*/*.json"):
            try:
                job = json.loads(f.read_text())
            except (OSError, ValueError):
                continue
            if job.get("state") not in FINAL:
                job.update(state="interrupted", finished_at=time.time(),
                           error="the server stopped while this job was running")
                job.setdefault("events", []).append(dict(t=round(time.time() - job["started_at"], 3), stage="interrupted",
                                                         message="server restarted"))
                self._save(job)
                out.append(job)
        return out

    # ------------------------------------------------------------------ lifecycle
    def start(self, owner: str, kind: str, subject: str, work: Callable[[Monitor], object], title: str = "") -> dict:
        jid = secrets.token_hex(8)
        job = dict(job_id=jid, owner=owner, kind=kind, subject=subject, title=title, state="running", stage="queued",
                   done=0, total=None, error=None, started_at=time.time(), finished_at=None, cancel_requested=False,
                   events=[])
        with self._lock:
            if any(j["state"] == "running" and j["subject"] == subject for j in self._jobs.values()):
                raise RuntimeError("a job is already running for this item; wait for it to finish")
            self._jobs[jid] = job
            mon = self._monitors[jid] = Monitor(self, job)
            if len(self._jobs) > MAX_KEPT_IN_MEMORY:
                for k in sorted((k for k, j in self._jobs.items() if j["state"] in FINAL),
                                key=lambda k: self._jobs[k]["started_at"])[: len(self._jobs) - MAX_KEPT_IN_MEMORY]:
                    self._jobs.pop(k, None); self._monitors.pop(k, None)
        mon.event("started", f"{kind} {subject}")
        self._save(job)

        def run() -> None:
            from .runner import Cancelled
            try:
                work(mon)
                job["state"] = "cancelled" if mon.cancel.is_set() else "done"
            except Cancelled:
                job["state"] = "cancelled"
            except Exception as e:                             # reported, never hidden
                job.update(state="cancelled" if mon.cancel.is_set() else "error", error=str(e))
            finally:
                job["finished_at"] = time.time()
                mon.event(job["state"], job["error"] or job["state"])
                self._save(job)
        threading.Thread(target=run, daemon=True, name=f"job-{jid}").start()
        return self.view(job)

    def cancel(self, owner: str, jid: str) -> dict | None:
        job = self._jobs.get(jid)
        if not job or job["owner"] != owner:
            return None
        if job["state"] == "running":
            job["cancel_requested"] = True
            self._monitors[jid].event("cancel", "cancellation requested")
            self._monitors[jid].cancel.set()
            self._save(job)
        return self.view(job)

    def get(self, owner: str, jid: str, events: bool = True) -> dict | None:
        job = self._jobs.get(jid)
        if job is None:
            p = self._path(owner, jid)
            if p is None or not p.exists():
                return None
            job = json.loads(p.read_text())
        if job["owner"] != owner:
            return None
        return self.view(job, events)

    def history(self, owner: str, limit: int = 50) -> list[dict]:
        """Most recent jobs of a user (persisted and in memory), without their event logs."""
        seen: dict[str, dict] = {j["job_id"]: j for j in self._jobs.values() if j["owner"] == owner}
        if self.root and SAFE.match(owner) and (self.root / owner).is_dir():
            for f in (self.root / owner).glob("*.json"):
                if f.stem not in seen:
                    try:
                        seen[f.stem] = json.loads(f.read_text())
                    except (OSError, ValueError):
                        continue
        jobs = sorted(seen.values(), key=lambda j: j["started_at"], reverse=True)[: max(1, min(limit, 500))]
        return [self.view(j, events=False) for j in jobs]

    @staticmethod
    def view(job: dict, events: bool = True) -> dict:
        out = {k: v for k, v in job.items() if k != "owner" and (events or k != "events")}
        if not events:
            out["event_count"] = len(job.get("events", []))
        if job.get("finished_at") and job.get("started_at"):
            out["duration_s"] = round(job["finished_at"] - job["started_at"], 3)
        return out
