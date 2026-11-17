"""Plugin security boundary — regression tests for the failures demonstrated in the pre-commit review.

Demonstrated before the fix (plain separate process): a plugin read the server's SESSION_SECRET from
/proc/<parent>/environ, read and wrote the data directory, and opened outbound connections. These tests prove that in
the default configuration plugins do not run at all, that in sandbox mode every one of those attacks is blocked, that
an unavailable or unverifiable sandbox refuses execution (no fallback), and that trusted-process mode is
administrator-only and documented as not being a sandbox.
"""
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import PROBLEM_ID, ROOT, plugin_ref, sandbox_or_skip
from move_openlab import runner, sandbox
from move_openlab.benchmarks.synthetic_assignment import generator
from move_openlab.methods import ContractError
from move_openlab.runner import IsolationRefused, run_once
from move_openlab.store import Forbidden, Installation

CANARY = "canary-session-secret-7f3a9c1e5b2d4f60a8c3e1d9b7f5a2c4"


@pytest.fixture
def fresh_sandbox_cache():
    sandbox._verified.clear()
    yield
    sandbox._verified.clear()


@pytest.fixture
def victim(tmp_path, plugin_dir):
    """An installation holding secrets and another researcher's data, with a local service listening."""
    data = tmp_path / "data"
    inst = Installation(data, plugin_dir, "inst-victim", plugin_mode="sandbox", protected=(tmp_path / "auth.sqlite3",))
    other = data / "workspaces" / "other-researcher" / "campaigns" / "c-private" / "campaign.json"
    other.parent.mkdir(parents=True)
    other.write_text('{"secret": "other researcher data"}')
    (tmp_path / "auth.sqlite3").write_text("credential store")
    srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
    cfg = dict(canary=CANARY, data_dir=str(data), local_port=srv.getsockname()[1],
               read_targets=dict(other_workspace=str(other), auth_db=str(tmp_path / "auth.sqlite3"),
                                 installation_json=str(data / "installation.json"),
                                 plugin_dir_file=str(plugin_dir / "regret_greedy" / "plugin.py"),
                                 repository_file=str(ROOT / "pyproject.toml")))
    yield inst, cfg
    srv.close()


SERVER = """
import json, sys
from pathlib import Path
from move_openlab import registry, sandbox
from move_openlab.plugins import code_sha256
from move_openlab.runner import run_once
from move_openlab.store import Installation
from move_openlab.benchmarks.synthetic_assignment import generator
a = json.loads(sys.argv[1])
if a["harden"]:
    assert sandbox.harden_current_process()
inst = Installation(a["data_dir"], a["plugin_dir"], "inst-victim", plugin_mode=a["mode"], protected=tuple(a["protected"]))
f = Path(a["plugin_dir"]) / "boundary_probe" / "plugin.py"
ref = dict(source="plugin", method_id="boundary-probe", version="1.0.0", plugin_file=str(f), code_sha256=code_sha256(f),
           isolation="sandbox" if a["mode"] == "sandbox" else "process")
r = run_once(registry.get("synthetic-capacitated-bipartite-assignment"), ref, generator.generate("small", 1), a["cfg"],
             sandbox=inst.sandbox_spec)
print(json.dumps(dict(accepted=r["accepted"], error=r.get("error"), isolation=r["isolation"], d=r["diagnostics"])))
"""


def probe(inst, cfg, mode, harden=False, protected=()):
    """Run the probe from a separate 'server' process that, like the real server, received SESSION_SECRET in its
    initial environment (/proc/<pid>/environ shows the environment a process started with)."""
    args = dict(data_dir=str(inst.data), plugin_dir=str(inst.plugin_dir), mode=mode, harden=harden, cfg=cfg,
                protected=[str(x) for x in protected])
    out = subprocess.run([sys.executable, "-c", SERVER, json.dumps(args)], capture_output=True, text=True, timeout=180,
                         env=dict(os.environ, SESSION_SECRET=CANARY))
    assert out.returncode == 0, out.stderr[-800:]
    r = json.loads(out.stdout.strip().splitlines()[-1])
    assert r["accepted"], r["error"]
    return r


# ---------------------------------------------------------------- default: off
def test_plugins_are_disabled_by_default(tmp_path, plugin_dir, monkeypatch, problem):
    for k in ("MOVE_OPENLAB_PLUGIN_MODE", "MOVE_OPENLAB_PLUGIN_DIR"):
        monkeypatch.delenv(k, raising=False)
    from move_openlab.settings import Settings
    assert Settings.from_env().plugin_mode == "disabled"
    inst = Installation(tmp_path / "d", plugin_dir)                 # a plugin directory alone does not enable plugins
    st = inst.plugin_status()
    assert st["enabled"] is False and "disabled" in st["reason"]
    w = inst.workspace("r", "R")
    assert w.available_plugins(problem) == []
    with pytest.raises(ContractError, match="disabled"):
        w.register_plugin(problem, "regret_greedy", admin=True)


def test_a_plugin_run_without_an_isolation_decision_is_refused(tmp_path, plugin_dir, problem, monkeypatch):
    monkeypatch.setattr(runner, "execute_isolated", lambda *a, **k: pytest.fail("a worker must not be started"))
    inst = Installation(tmp_path / "d", plugin_dir, plugin_mode="sandbox")
    ref = plugin_ref(inst, "regret_greedy", "regret-greedy"); ref.pop("isolation")
    with pytest.raises(IsolationRefused):
        run_once(problem, ref, generator.generate("small", 1), {}, sandbox=inst.sandbox_spec)


# ---------------------------------------------------------------- sandbox blocks the demonstrated attacks
def test_sandbox_blocks_secrets_private_data_and_network(victim, fresh_sandbox_cache, tmp_path):
    sandbox_or_skip(tmp_path)
    inst, cfg = victim
    r = probe(inst, cfg, "sandbox", protected=[Path(cfg["read_targets"]["auth_db"])])
    assert r["isolation"] == "sandbox"
    d = r["d"]
    assert d["parent_environ_canary"] is False                     # the reviewed attack: /proc/<parent>/environ
    assert d["any_process_environ_canary"] == []                    # no process in view carries the secret
    assert set(d["own_environ_keys"]) <= set(sandbox.ENV) | {"PWD"}
    assert all(str(v).startswith("blocked") for v in d["reads"].values()), d["reads"]
    assert str(d["write_into_data_dir"]).startswith("blocked")
    assert not (Path(cfg["data_dir"]) / "written-by-plugin").exists()
    assert str(d["local_server"]).startswith("blocked")            # host loopback unreachable: separate network
    assert str(d["outbound_ip"]).startswith("blocked") and str(d["dns"]).startswith("blocked")
    assert len(d["visible_pids"]) <= 4                              # private PID namespace


LINUX_ONLY = pytest.mark.skipif(not sys.platform.startswith("linux"),
                                reason="Linux-only mechanism (/proc probe, prctl, bubblewrap): plug-ins are refused on other systems")


@LINUX_ONLY
def test_trusted_process_control_is_not_a_sandbox(victim, tmp_path):
    """Control experiment: the same probe without the sandbox reproduces the reviewed failures. This proves the probe
    is effective and documents why trusted-process mode is administrator-only and refused in production."""
    inst, cfg = victim
    d = probe(inst, cfg, "trusted-process")["d"]
    assert d["parent_environ_canary"] is True
    assert d["reads"]["other_workspace"].startswith('{"secret"')
    assert d["local_server"] == "connected"


@LINUX_ONLY
def test_server_hardening_hides_its_environment_from_trusted_plugins(victim, tmp_path):
    """`move-openlab serve` marks the server non-dumpable: even a trusted-process plugin can no longer read the
    server's environment (it can still read files: trusted-process remains not a sandbox)."""
    inst, cfg = victim
    d = probe(inst, cfg, "trusted-process", harden=True)["d"]
    assert d["parent_environ_canary"] is not True and d["any_process_environ_canary"] == []


# ---------------------------------------------------------------- fail closed
def test_missing_bubblewrap_refuses_plugins(tmp_path, plugin_dir, problem, monkeypatch, fresh_sandbox_cache):
    def no_bwrap():
        raise sandbox.SandboxUnavailable("bubblewrap (bwrap) is not installed")
    monkeypatch.setattr(sandbox, "bwrap", no_bwrap)
    monkeypatch.setattr(runner, "execute_isolated", lambda *a, **k: pytest.fail("a worker must not be started"))
    inst = Installation(tmp_path / "d", plugin_dir, plugin_mode="sandbox")
    st = inst.plugin_status()
    assert st["enabled"] is False and "not installed" in st["reason"]
    w = inst.workspace("r", "R")
    with pytest.raises(ContractError, match="refused"):
        w.register_plugin(problem, "regret_greedy")
    with pytest.raises(IsolationRefused):
        run_once(problem, plugin_ref(inst, "regret_greedy", "regret-greedy"), generator.generate("small", 1), {},
                 sandbox=inst.sandbox_spec)


def test_unverifiable_isolation_refuses_plugins(tmp_path, plugin_dir, problem, monkeypatch, fresh_sandbox_cache):
    sandbox_or_skip(tmp_path)
    sandbox._verified.clear()
    monkeypatch.setattr(sandbox, "PROBE", 'import json; print(json.dumps({"network_loopback_only": False}))')
    inst = Installation(tmp_path / "d", plugin_dir, plugin_mode="sandbox")
    st = inst.plugin_status()
    assert st["enabled"] is False and "network_loopback_only" in st["reason"]
    with pytest.raises(ContractError):
        inst.workspace("r", "R").register_plugin(problem, "regret_greedy")


def test_registered_plugin_is_refused_when_the_sandbox_breaks(installations, problem, monkeypatch, fresh_sandbox_cache):
    inst = installations[0]
    w = inst.workspace("r", "R")
    w.register_plugin(problem, "regret_greedy")
    c = w.create_campaign(PROBLEM_ID, "plugin run", dict(sizes=["small"], seeds=[1]), [("regret-greedy", "1.0.0")],
                          repetitions=1)
    sandbox._verified.clear()
    monkeypatch.setattr(sandbox, "bwrap", lambda: (_ for _ in ()).throw(sandbox.SandboxUnavailable("gone")))
    with pytest.raises(ContractError):
        w.execute(c["campaign_id"])
    assert w.get(c["campaign_id"])["runs"] == [] and w.get(c["campaign_id"])["status"] == "draft"


@LINUX_ONLY
def test_protected_path_inside_a_mounted_root_is_refused(fresh_sandbox_cache):
    import move_openlab
    spec = sandbox.SandboxSpec.of(Path(move_openlab.__file__).resolve().parent / "data-placed-here")
    with pytest.raises(sandbox.SandboxUnavailable, match="protected path"):
        sandbox.verify(spec)


# ---------------------------------------------------------------- trusted-process is administrator-controlled
def test_trusted_process_registration_is_admin_only(tmp_path, plugin_dir, problem):
    inst = Installation(tmp_path / "d", plugin_dir, plugin_mode="trusted-process")
    w = inst.workspace("r", "R")
    with pytest.raises(Forbidden):
        w.register_plugin(problem, "regret_greedy")
    assert w.register_plugin(problem, "regret_greedy", admin=True)["isolation_at_registration"] == "process"


def test_trusted_process_is_refused_in_production(tmp_path, plugin_dir):
    from test_api import make_settings
    from move_openlab.api import create_app
    from move_openlab.auth import Auth
    from move_openlab.auth.store import UserStore
    s = make_settings(tmp_path, "p", plugin_dir, production=True, plugin_mode="trusted-process")
    with pytest.raises(RuntimeError, match="not a sandbox"):
        create_app(s, Auth(s, UserStore(None)))


def test_trusted_process_api_requires_admin(tmp_path, plugin_dir):
    from test_api import PID, login, make_client
    c = make_client(tmp_path, "t", plugin_dir, "trusted-process")
    login(c, "alice")                                              # alice is a researcher in make_client
    m = c.get(f"/api/problems/{PID}/methods").json()
    assert m["plugin_status"]["isolation"] == "process" and m["can_register"] is False
    assert c.post(f"/api/problems/{PID}/methods/register", json=dict(plugin="regret_greedy")).status_code == 403


def test_sandbox_works_when_the_python_environment_lives_under_tmp(tmp_path, fresh_sandbox_cache):
    """Regression: the private /tmp of the sandbox must not hide read-only binds located under /tmp."""
    sandbox_or_skip(tmp_path)
    argv = sandbox.command(sandbox.SandboxSpec.of(tmp_path / "data"), None)
    tmpfs, binds = argv.index("/tmp"), [i for i, x in enumerate(argv) if x == "--ro-bind"]
    assert argv[tmpfs - 1] == "--tmpfs" and all(tmpfs < i for i in binds)
