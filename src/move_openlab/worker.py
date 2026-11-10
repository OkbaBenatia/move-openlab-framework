"""Isolated method execution: ``python -I -m move_openlab.worker`` reads one JSON request on stdin and writes one
JSON reply on its original stdout.

Request::

    {"problem_id": str,
     "method": {"source": "builtin" | "plugin", "method_id", "version", "plugin_file"?, "code_sha256"?},
     "instance": {...}, "config": {...}, "limits": {"memory_mb"?: int, "cpu_s"?: int}}

or, for a registered custom metric (see :mod:`move_openlab.custom_metrics`)::

    {"kind": "metric", "metric": {"metric_id", "version", "plugin_file", "code_sha256"},
     "contexts": [{"metrics", "domain", "instance"} | null, ...], "limits": {...}}

  The reply carries one raw output per context (``null``, a number, a pair, or ``{"error"|"invalid": ...}``); the
  server validates them.

* ``-I`` (isolated mode): no ``PYTHON*`` environment variables, no user site directory, and neither the current
  directory nor the script directory is put on the module search path. The framework must be *installed*.
* A plugin is compiled from the exact bytes whose SHA-256 was verified (no time-of-check/time-of-use gap).
* Anything a method prints goes to stderr; only the reply is written to the reply channel.
* The instance and the configuration are passed as deep read-only views.
"""
from __future__ import annotations

import faulthandler
import hashlib
import json
import os
import sys
import threading
import time
import traceback
import types


class _Done(Exception):
    pass


def _usage() -> dict:
    """CPU time and peak memory of this worker process (POSIX), measured by the operating system."""
    try:
        import resource
    except ImportError:
        return {}
    u = resource.getrusage(resource.RUSAGE_SELF)
    return dict(cpu_user_s=round(u.ru_utime, 6), cpu_system_s=round(u.ru_stime, 6), max_rss_mb=round(u.ru_maxrss / 1024, 1),
                threads=threading.active_count())


def _apply_limits(limits: dict) -> None:
    try:
        import resource
    except ImportError:                                     # non-POSIX platform: only the timeout applies
        return
    mem = limits.get("memory_mb")
    if mem:
        b = int(mem) * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (b, b))
        except (ValueError, OSError):
            pass
    cpu = limits.get("cpu_s")
    if cpu:
        try:
            resource.setrlimit(resource.RLIMIT_CPU, (int(cpu), int(cpu) + 1))
        except (ValueError, OSError):
            pass


def load(problem, method: dict):
    from move_openlab.methods import builtin_registry, check_metadata
    if method["source"] == "builtin":
        return builtin_registry(problem).get(method["method_id"], method["version"])
    if method["source"] != "plugin":
        raise ValueError("unknown method source")
    with open(method["plugin_file"], "rb") as f:
        code = f.read()
    if hashlib.sha256(code).hexdigest() != method["code_sha256"]:
        raise PermissionError("plugin code does not match its registered SHA-256 (refusing to execute)")
    name = "move_openlab_plugin_" + method["method_id"].replace("-", "_")
    mod = types.ModuleType(name)
    mod.__file__ = method["plugin_file"]
    sys.modules[name] = mod                                 # this child process only (needed by e.g. dataclasses)
    exec(compile(code, method["plugin_file"], "exec"), mod.__dict__)   # the verified bytes, not a re-read file
    meta = check_metadata(mod.__dict__.get("METADATA") or {}, problem)
    if (meta.method_id, meta.version) != (method["method_id"], method["version"]):
        raise PermissionError("plugin metadata does not match its registration")
    solve = getattr(mod, "solve", None)
    if not callable(solve):
        raise AttributeError("plugin defines no solve(instance, config) function")
    return meta, solve


def load_metric(metric: dict):
    """A registered metric file, compiled from the exact bytes whose SHA-256 was verified; its literal METADATA must
    still match the registration."""
    from move_openlab.custom_metrics import metadata_of_source, spec_from_metadata
    with open(metric["plugin_file"], "rb") as f:
        code = f.read()
    if hashlib.sha256(code).hexdigest() != metric["code_sha256"]:
        raise PermissionError("metric code does not match its registered SHA-256 (refusing to execute)")
    spec = spec_from_metadata(metadata_of_source(code, metric["plugin_file"]))      # the verified bytes, not a re-read
    if (spec.id, spec.version) != (metric["metric_id"], metric["version"]):
        raise PermissionError("metric metadata does not match its registration")
    name = "move_openlab_metric_" + metric["metric_id"].replace("-", "_")
    mod = types.ModuleType(name)
    mod.__file__ = metric["plugin_file"]
    sys.modules[name] = mod
    exec(compile(code, metric["plugin_file"], "exec"), mod.__dict__)
    fn = getattr(mod, "compute", None)
    if not callable(fn):
        raise AttributeError("metric defines no compute(ctx) function")
    return fn


def run_metric(req: dict) -> dict:
    from move_openlab.custom_metrics import plain
    from move_openlab.methods import freeze
    fn = load_metric(req["metric"])
    outs = []
    t0 = time.perf_counter()
    for ctx in req["contexts"]:
        if ctx is None:
            outs.append(None)
            continue
        try:
            outs.append(plain(fn(freeze(ctx))))
        except Exception as e:                              # one scenario's failure is reported, the others go on
            outs.append({"error": type(e).__name__})
    return dict(ok=True, outputs=outs, metric_time_s=round(time.perf_counter() - t0, 6))


def main() -> int:
    reply_fd = os.dup(1)                                    # reply channel = the original stdout
    os.dup2(2, 1)                                           # everything printed by methods goes to stderr
    sys.stdout = sys.stderr
    reply: dict = dict(ok=False)
    try:
        req = json.loads(sys.stdin.read())
        _apply_limits(req.get("limits") or {})
        dump = (req.get("limits") or {}).get("dump_s")
        if dump:                                            # where the worker is, written to stderr just before the
            faulthandler.dump_traceback_later(float(dump), exit=False, file=sys.stderr)   # runner's deadline
        if req.get("kind") == "metric":
            reply = run_metric(req)
            raise _Done
        from move_openlab import registry
        from move_openlab.methods import freeze, thaw
        problem = registry.get(req["problem_id"])
        meta, fn = load(problem, req["method"])
        cfg = {**(meta.default_config or {}), **(req.get("config") or {})}
        view = freeze(req["instance"])
        t0 = time.perf_counter()
        out = fn(view, freeze(cfg))
        reply.update(ok=True, output=thaw(out), method_time_s=round(time.perf_counter() - t0, 6), effective_config=cfg,
                     method_metadata=meta.to_dict())
    except _Done:
        pass
    except BaseException as e:                              # reported, never hidden (MemoryError, SystemExit, ...)
        reply.update(error=f"{type(e).__name__}: {e}", traceback=traceback.format_exc()[-2000:])
    faulthandler.cancel_dump_traceback_later()
    reply["resources"] = _usage()
    try:
        data = json.dumps(reply)
    except (TypeError, ValueError) as e:
        data = json.dumps(dict(ok=False, error=f"output not JSON-serialisable: {e}"))
    with os.fdopen(reply_fd, "w") as f:
        f.write(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
