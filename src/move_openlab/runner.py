"""Controlled execution of one method on one instance in a separate process, followed by independent validation.

Timing definitions (stored with every run):

``solver_time_s``  time reported by the method's optimisation solver (``metadata.solver_time_s``); for methods without
                   an external solver it equals ``method_time_s``
``method_time_s``  wall time of the ``solve()`` call inside the isolated worker (includes model building)
``total_time_s``   wall time measured by the platform for the whole isolated execution (process start, input
                   serialisation, solve, reply); validation is excluded
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import __version__
from .methods import ContractError, check_output
from .problem import Problem
from .sandbox import PLUGIN_MOUNT, SandboxSpec, SandboxUnavailable, command as sandbox_command, verify as sandbox_verify

DEFAULT_MEMORY_MB = int(os.environ.get("MOVE_OPENLAB_WORKER_MEMORY_MB", "4096") or 0)


def _cpu_model() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or ""


def environment(problem: Problem, installation_id: str = "") -> dict:
    """Computational environment of an execution. The CPU model is stored as a short digest only, so records can be
    shared without hardware identifiers while still revealing whether two runs used the same processor model."""
    return dict(installation_id=installation_id, python=platform.python_version(),
                implementation=platform.python_implementation(), os=platform.system(), os_release=platform.release(),
                machine=platform.machine(), cpu_model_sha256=hashlib.sha256(_cpu_model().encode()).hexdigest()[:16],
                cpu_count=os.cpu_count(), framework_version=__version__, **problem.environment())


def _worker_env() -> dict:
    """Minimal environment: nothing inherited except PATH (no secrets, no tokens, no database URLs)."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1",
            "OMP_NUM_THREADS": "1", "LANG": "C.UTF-8"}


class Cancelled(RuntimeError):
    """The run was cancelled by the user; the worker process (group) was killed."""


def _kill(p: subprocess.Popen) -> None:
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, AttributeError):
        p.kill()
    p.communicate()


def execute_isolated(request: dict, timeout_s: float, python: str | None = None,
                     sandbox: SandboxSpec | None = None, cancel=None) -> tuple[dict, float]:
    """Run the worker in a separate process; with ``sandbox``, inside the verified bubblewrap sandbox (the plugin file
    is mounted read-only at a fixed path and nothing else of the installation's data is visible). ``cancel`` is an
    optional ``threading.Event``: when it is set, the worker process group is killed and :class:`Cancelled` raised."""
    if sandbox is not None:
        argv = sandbox_command(sandbox, request["method"].get("plugin_file"), python)
        if request["method"].get("plugin_file"):
            request = dict(request, method=dict(request["method"], plugin_file=PLUGIN_MOUNT))
    else:
        argv = [python or sys.executable, "-I", "-m", "move_openlab.worker"]
    req = json.dumps(request)
    with tempfile.TemporaryDirectory(prefix="move-openlab-run-") as cwd:
        t0 = time.perf_counter()
        p = subprocess.Popen(argv, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=_worker_env(), cwd=cwd,
                             start_new_session=True)
        deadline, first, out, err = t0 + timeout_s, True, None, None
        while out is None:
            if cancel is not None and cancel.is_set():
                _kill(p)
                raise Cancelled("run cancelled")
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                _kill(p)
                return dict(ok=False, error=f"timeout after {timeout_s} s"), time.perf_counter() - t0
            try:
                out, err = p.communicate(req if first else None, timeout=min(remaining, 0.25))
            except subprocess.TimeoutExpired:
                first = False
        total = time.perf_counter() - t0
    if not out.strip():
        return dict(ok=False, error=f"worker exit {p.returncode}: {err[-500:]}"), total
    try:
        reply = json.loads(out)
    except ValueError as e:
        reply = dict(ok=False, error=f"unreadable worker reply: {e}")
    return reply, total


class IsolationRefused(ContractError):
    """A plugin run was refused because the required isolation is not available (fail closed)."""


def run_once(problem: Problem, method_ref: dict, instance: dict, config: dict, timeout_s: float = 120.0,
             python: str | None = None, sandbox: SandboxSpec | None = None, cancel=None,
             experiment_config: dict | None = None) -> dict:
    """Execute one method on one instance. Built-in methods run in an isolated process. A plugin must carry an explicit
    ``isolation``: ``"sandbox"`` (requires ``sandbox`` and a successful isolation verification, otherwise the run is
    refused) or ``"process"`` (trusted-process mode, decided by the installation's administrator).
    ``experiment_config`` (the campaign configuration) reaches only the problem's domain metrics, never the method."""
    trace, t_stage = [], time.perf_counter()

    def stage(name: str, detail: str = "") -> None:
        nonlocal t_stage
        now_ = time.perf_counter()
        trace.append(dict(stage=name, duration_s=round(now_ - t_stage, 6), detail=detail))
        t_stage = now_
    errs = problem.check_instance(instance)
    if errs:
        raise ValueError(f"instance failed integrity checks: {errs}")
    isolation, spec = "process", None
    if method_ref["source"] == "plugin":
        isolation = method_ref.get("isolation")
        if isolation == "sandbox":
            if sandbox is None:
                raise IsolationRefused("plugin run refused: no sandbox specification")
            try:
                sandbox_verify(sandbox)
            except SandboxUnavailable as e:
                raise IsolationRefused(f"plugin run refused: {e}") from None
            spec = sandbox
        elif isolation != "process":
            raise IsolationRefused("plugin run refused: no isolation mode was decided for this plugin")
    limits = dict(memory_mb=DEFAULT_MEMORY_MB or None, cpu_s=int(math.ceil(timeout_s)) + 5)
    worker_ref = {k: v for k, v in method_ref.items() if k != "isolation"}
    stage("prepare", "instance integrity verified" + ("; sandbox isolation verified" if spec else ""))
    reply, total = execute_isolated(dict(problem_id=problem.problem_id, method=worker_ref, instance=instance,
                                         config=config, limits=limits), timeout_s, python, spec, cancel)
    stage("execute", f"{isolation} worker" + ("" if reply.get("ok") else f"; failed: {str(reply.get('error'))[:120]}"))
    rec = dict(method_id=method_ref["method_id"], version=method_ref["version"], source=method_ref["source"],
               instance_hash=instance["instance_hash"], instance_id=instance["instance_id"], total_time_s=round(total, 6),
               isolation=isolation, trace=trace)
    if not reply.get("ok"):
        rec.update(accepted=False, status_declared="ERROR", error=reply.get("error"), decisions=[],
                   output_errors=["execution failed"],
                   validation=dict(feasible=False, metrics={m.id: 0 for m in problem.metrics},
                                   errors=[reply.get("error", "execution failed")]),
                   method_time_s=None, solver_time_s=None)
        return rec
    out = reply["output"]
    oerr = check_output(out, problem)
    decisions = out.get("decisions") if isinstance(out, dict) and isinstance(out.get("decisions"), list) else []
    val = problem.validate(instance, decisions if not oerr else [])   # independent recomputation, never the report
    if oerr:
        val = dict(val, feasible=False, errors=["output contract violated"] + val["errors"])
    md = (out.get("metadata") if isinstance(out, dict) else None) or {}
    declared = (out.get("declared") if isinstance(out, dict) else None) or {}
    mismatch = sorted(k for k, v in declared.items() if k in val["metrics"] and v != val["metrics"][k]) \
        if isinstance(declared, dict) else []
    solver_t = md.get("solver_time_s") if isinstance(md.get("solver_time_s"), (int, float)) else reply.get("method_time_s")
    rec.update(accepted=not oerr and val["feasible"], status_declared=out.get("status") if isinstance(out, dict) else None,
               decisions=problem.canonical_decisions(decisions) if not oerr else [], output_errors=oerr, validation=val,
               declared=declared if isinstance(declared, dict) else {}, declared_mismatch=mismatch,
               method_time_s=reply.get("method_time_s"), solver_time_s=solver_t,
               effective_config=reply.get("effective_config"), method_metadata=md,
               diagnostics=(out.get("diagnostics") if isinstance(out, dict) else None) or {})
    stage("validate", "independent validation: " + ("feasible" if val["feasible"] else f"{len(val['errors'])} error(s)"))
    dom = problem.domain_metrics(instance, rec["decisions"], experiment_config) if rec["accepted"] else None
    if dom is not None:                                        # domain figures from validated decisions only
        rec["domain"] = dom
        stage("domain", "domain metrics " + ("computed" if dom.get("complete") else "incomplete: " + ", ".join(dom.get("missing", [])[:3])))
    return rec
