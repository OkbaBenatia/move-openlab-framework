"""Isolated method execution: ``python -I -m move_openlab.worker`` reads one JSON request on stdin and writes one
JSON reply on its original stdout.

Request::

    {"problem_id": str,
     "method": {"source": "builtin" | "plugin", "method_id", "version", "plugin_file"?, "code_sha256"?},
     "instance": {...}, "config": {...}, "limits": {"memory_mb"?: int, "cpu_s"?: int}}

* ``-I`` (isolated mode): no ``PYTHON*`` environment variables, no user site directory, and neither the current
  directory nor the script directory is put on the module search path. The framework must be *installed*.
* A plugin is compiled from the exact bytes whose SHA-256 was verified (no time-of-check/time-of-use gap).
* Anything a method prints goes to stderr; only the reply is written to the reply channel.
* The instance and the configuration are passed as deep read-only views.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import traceback
import types


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


def main() -> int:
    reply_fd = os.dup(1)                                    # reply channel = the original stdout
    os.dup2(2, 1)                                           # everything printed by methods goes to stderr
    sys.stdout = sys.stderr
    reply: dict = dict(ok=False)
    try:
        req = json.loads(sys.stdin.read())
        _apply_limits(req.get("limits") or {})
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
    except BaseException as e:                              # reported, never hidden (MemoryError, SystemExit, ...)
        reply.update(error=f"{type(e).__name__}: {e}", traceback=traceback.format_exc()[-2000:])
    try:
        data = json.dumps(reply)
    except (TypeError, ValueError) as e:
        data = json.dumps(dict(ok=False, error=f"output not JSON-serialisable: {e}"))
    with os.fdopen(reply_fd, "w") as f:
        f.write(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
