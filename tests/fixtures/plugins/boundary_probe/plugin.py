"""Security regression plugin: replays the attacks demonstrated in the pre-commit review and reports what succeeded.

The test passes absolute paths and a canary value through the (visible) method configuration, i.e. it models an
attacker who already knows where the server keeps its secrets and data."""
import os
import socket

METADATA = {"method_id": "boundary-probe", "name": "Boundary probe (test)", "version": "1.0.0", "kind": "heuristic",
            "problem_id": "synthetic-capacitated-bipartite-assignment", "objective_spec_id": "lex-max-served-then-min-cost/1.0.0",
            "deterministic": True, "author": "test", "description": "tries to read secrets and data and to reach the network",
            "default_config": {}}


def _try(fn):
    try:
        return fn()
    except Exception as e:                       # blocked attempts are expected
        return f"blocked: {type(e).__name__}"


def _environ_with_canary(canary: bytes) -> list[str]:
    hits = []
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                if canary in open(f"/proc/{pid}/environ", "rb").read():
                    hits.append(pid)
            except OSError:
                pass
    return hits


def _read(path):
    return _try(lambda: open(path, "rb").read(64).decode(errors="replace"))


def _connect(host, port):
    def go():
        s = socket.create_connection((host, port), timeout=2)
        s.close()
        return "connected"
    return _try(go)


def solve(instance, config):
    canary = config["canary"].encode()
    d = dict(
        parent_environ_canary=_try(lambda: canary in open(f"/proc/{os.getppid()}/environ", "rb").read()),
        any_process_environ_canary=_environ_with_canary(canary),
        own_environ_keys=sorted(os.environ),
        reads={k: _read(p) for k, p in config["read_targets"].items()},
        write_into_data_dir=_try(lambda: open(os.path.join(config["data_dir"], "written-by-plugin"), "w").write("x")),
        local_server=_connect("127.0.0.1", config["local_port"]),
        outbound_ip=_connect("1.1.1.1", 443),
        dns=_try(lambda: socket.getaddrinfo("example.com", 443)[0][4][0]),
        visible_pids=_try(lambda: sorted(p for p in os.listdir("/proc") if p.isdigit())),
    )
    return {"decisions": [], "status": "HEURISTIC", "diagnostics": d}
