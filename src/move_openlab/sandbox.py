"""Fail-closed sandbox for researcher plugins (Linux, bubblewrap).

Plugin execution modes (``MOVE_OPENLAB_PLUGIN_MODE``):

``disabled``         default. No plugin is listed, registered or executed; built-in methods only.
``sandbox``          every plugin run (including the registration self-test) happens inside a bubblewrap sandbox
                     whose isolation is verified before first use. If bubblewrap is missing, the platform is not Linux,
                     or any isolation check fails, plugins are refused — there is no fallback to an unsandboxed process.
``trusted-process``  plugins run in a plain separate process with the server's operating-system permissions. NOT a
                     sandbox: only for code the administrator fully trusts. Only administrators may register plugins
                     in this mode, and the server refuses to start in production with it.

The sandbox (one per run):

* new user, PID, network, IPC, UTS and cgroup namespaces (``--unshare-all``); all capabilities dropped; new session;
  the sandbox dies with its parent;
* network: only an isolated loopback interface — no route to any other host;
* processes: a private PID namespace and ``/proc`` — the server process and its environment are invisible;
* environment: cleared; only PATH, locale and thread settings are set;
* filesystem: an empty root with read-only binds of the system libraries (``/usr`` and its compatibility links), the
  Python installation and the installed framework packages, plus the single plugin file; a private ``/tmp``;
  the installation data directory, the credential store, the plugin directory and home directories are not mounted.
  A bind that would expose a protected path is refused.

Remaining risks: no seccomp filter (the kernel attack surface of unprivileged user namespaces remains), no cgroup
limits (memory/CPU are bounded by rlimits and the wall-clock timeout), and the instance data given to a plugin is,
by design, visible to it.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import sysconfig
import threading
from dataclasses import dataclass, field
from pathlib import Path

MODES = ("disabled", "sandbox", "trusted-process")
PLUGIN_MOUNT = "/sandbox/plugin.py"
ENV = {"PATH": "/usr/bin:/bin", "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "1",
       "LANG": "C.UTF-8"}
COMPAT_LINKS = ("bin", "sbin", "lib", "lib32", "lib64", "libx32")
ETC_FILES = ("/etc/ld.so.cache", "/etc/localtime")


class SandboxUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class SandboxSpec:
    """Paths that must never be visible inside the sandbox (data directory, credential store, plugin directory)."""
    protected: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def of(cls, *paths) -> "SandboxSpec":
        return cls(tuple(sorted({str(Path(p).resolve()) for p in paths if p})))


def bwrap() -> str:
    if not sys.platform.startswith("linux"):
        raise SandboxUnavailable(f"the plugin sandbox requires Linux (platform {sys.platform})")
    for cand in ("/usr/bin/bwrap", shutil.which("bwrap")):
        if cand and os.access(cand, os.X_OK):
            return cand
    raise SandboxUnavailable("bubblewrap (bwrap) is not installed")


def _readonly_roots(spec: SandboxSpec) -> list[str]:
    import move_openlab
    cands = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix,
             str(Path(sys.executable).resolve().parents[1]), str(Path(move_openlab.__file__).resolve().parents[1])}
    for scheme in ("stdlib", "platstdlib", "purelib", "platlib"):
        p = sysconfig.get_paths().get(scheme)
        if p:
            cands.add(p)
    roots = sorted({str(Path(c).resolve()) for c in cands if c and Path(c).exists()})
    roots = [r for r in roots if not (r == "/usr" or r.startswith("/usr/"))]           # already bound
    minimal = [r for r in roots if not any(r != o and r.startswith(o.rstrip("/") + "/") for o in roots)]
    for r in minimal:
        if r in ("/", str(Path.home().resolve())):
            raise SandboxUnavailable(f"refusing to expose {r} to plugins")
        for p in spec.protected:
            if p == r or p.startswith(r.rstrip("/") + "/"):
                raise SandboxUnavailable(f"a read-only root of the Python installation ({r}) contains a protected path; "
                                         "move the data/plugin directory or the virtual environment")
    return minimal


def _symlink_chain(path: str) -> list[tuple[str, str]]:
    """(target, link) pairs for every symbolic link met while resolving ``path`` (e.g. a virtual environment's
    ``bin/python`` pointing through a versioned directory link), so the same path works inside the sandbox."""
    out, todo, seen = [], [Path(path).absolute()], set()
    while todo:
        cur = todo.pop()
        acc = Path("/")
        for part in cur.parts[1:]:
            nxt = acc / part
            if nxt.is_symlink() and str(nxt) not in seen:
                seen.add(str(nxt))
                tgt = os.readlink(nxt)
                out.append((tgt, str(nxt)))
                todo.append((acc / tgt) if not os.path.isabs(tgt) else Path(tgt))
                break
            acc = nxt
    return out


def command(spec: SandboxSpec, plugin_file: str | None, python: str | None = None) -> list[str]:
    """bubblewrap argv that runs ``python -I -m move_openlab.worker`` with the plugin mounted at PLUGIN_MOUNT."""
    argv = [bwrap(), "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"]
    for k, v in ENV.items():
        argv += ["--setenv", k, v]
    # private /proc, /dev and /tmp first: binds made afterwards stay visible even when they live under /tmp
    argv += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    argv += ["--ro-bind", "/usr", "/usr"]
    for name in COMPAT_LINKS:
        p = Path("/") / name
        if p.is_symlink():
            argv += ["--symlink", os.readlink(p), str(p)]
        elif p.is_dir():
            argv += ["--ro-bind", str(p), str(p)]
    for f in ETC_FILES:
        argv += ["--ro-bind-try", f, f]
    roots = _readonly_roots(spec)
    for r in roots:
        argv += ["--ro-bind", r, r]
    for tgt, link in _symlink_chain(python or sys.executable):
        if not any(link == r or link.startswith(r.rstrip("/") + "/") for r in roots) and not link.startswith("/usr/") \
                and Path(link).name not in COMPAT_LINKS:
            argv += ["--symlink", tgt, link]
    if plugin_file:
        argv += ["--ro-bind", str(Path(plugin_file).resolve()), PLUGIN_MOUNT]
    argv += ["--chdir", "/tmp", "--hostname", "sandbox", "--", python or sys.executable, "-I", "-m", "move_openlab.worker"]
    return argv


PROBE = r"""
import json, os, socket, sys
spec = json.loads(sys.stdin.read())
checks = {}
ifaces = [l.split(":")[0].strip() for l in open("/proc/net/dev").read().splitlines()[2:]]
checks["network_loopback_only"] = ifaces == ["lo"]
try:
    s = socket.socket(); s.settimeout(1); s.connect(("192.0.2.1", 9)); s.close(); checks["network_connect_refused"] = False
except OSError:
    checks["network_connect_refused"] = True
pids = [p for p in os.listdir("/proc") if p.isdigit()]
checks["pid_namespace_private"] = len(pids) <= 4
env1 = set(k.split(b"=", 1)[0].decode() for k in open("/proc/1/environ", "rb").read().split(b"\0") if k)
checks["init_environment_minimal"] = env1 <= set(spec["allowed_env"])
checks["own_environment_minimal"] = set(os.environ) <= set(spec["allowed_env"])
checks["protected_paths_invisible"] = not any(os.path.exists(p) for p in spec["protected"])
def skeleton_only(d):
    # a directory is acceptable only if it is a bound root, or contains nothing but the path components leading to one
    if any(d == r or d.startswith(r.rstrip("/") + "/") for r in spec["roots"]):
        return True
    if os.path.islink(d):
        real = os.path.realpath(d)
        return any(real == r or real.startswith(r.rstrip("/") + "/") for r in spec["roots"])
    if not os.path.isdir(d):
        return False
    return all(skeleton_only(os.path.join(d, e)) and (os.path.islink(os.path.join(d, e)) or any(
               r.startswith(os.path.join(d, e) + "/") or r == os.path.join(d, e) for r in spec["roots"]))
               for e in os.listdir(d))
checks["home_contents_invisible"] = (not os.path.exists(spec["home"])) or skeleton_only(spec["home"])
w = spec["readonly_probe"]
try:
    open(os.path.join(w, ".sandbox-write-probe"), "w").close(); checks["installation_read_only"] = False
except OSError:
    checks["installation_read_only"] = True
print(json.dumps(checks))
"""

_verified: dict[SandboxSpec, dict] = {}
_vlock = threading.Lock()


def verify(spec: SandboxSpec, refresh: bool = False) -> dict:
    """Run the isolation probe inside the exact sandbox used for plugins. Returns the checks; raises
    SandboxUnavailable if the sandbox cannot start or any check fails. Successful results are cached per spec."""
    with _vlock:
        if not refresh and spec in _verified:
            return _verified[spec]
        argv = command(spec, None)
        argv = argv[:argv.index("--") + 1] + [sys.executable, "-I", "-c", PROBE]
        import move_openlab
        payload = json.dumps(dict(protected=list(spec.protected), home=str(Path.home()), allowed_env=sorted(ENV) + ["PWD"],
                                  roots=_readonly_roots(spec),
                                  readonly_probe=str(Path(move_openlab.__file__).resolve().parent)))
        try:
            p = subprocess.run(argv, input=payload, capture_output=True, text=True, timeout=30, env=dict(ENV))
        except (OSError, subprocess.TimeoutExpired) as e:
            raise SandboxUnavailable(f"sandbox could not start: {type(e).__name__}") from None
        if p.returncode != 0:
            raise SandboxUnavailable(f"sandbox could not start: {p.stderr.strip()[-300:]}")
        try:
            checks = json.loads(p.stdout)
        except ValueError:
            raise SandboxUnavailable("sandbox isolation probe returned no verdict") from None
        failed = sorted(k for k, ok in checks.items() if ok is not True)
        if failed:
            raise SandboxUnavailable(f"sandbox isolation could not be verified: {failed}")
        _verified[spec] = checks
        return checks


def harden_current_process() -> bool:
    """Make the server process non-dumpable (Linux): other processes of the same user — including trusted-process
    plugins — can then no longer read its /proc/<pid>/environ or memory. Returns True when applied."""
    if not sys.platform.startswith("linux"):
        return False
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        PR_SET_DUMPABLE = 4
        return libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0
    except (OSError, AttributeError):
        return False
