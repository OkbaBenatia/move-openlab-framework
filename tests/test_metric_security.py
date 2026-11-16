"""Security boundary of registered (third-party) custom metrics.

A registered metric is code written by someone other than the platform. These tests prove that it never runs in the
server process (not at discovery, listing, registration or evaluation), that in sandbox mode it cannot read other
workspaces, the data directory or the credential store, cannot see the server's environment or reach the network,
is stopped by the timeout and the memory limit, that its outputs are validated, that a file modified after
registration is refused, and that an unavailable isolation means *no value* — never an unsandboxed fallback.
"""
import json
import socket
import sys
import time

import pytest

from conftest import sandbox_or_skip
from move_openlab import custom_metrics as CM
from move_openlab import registry, sandbox
from move_openlab.methods import ContractError
from move_openlab.store import Forbidden, Installation, Workspace

RIDE = "public-ride-matching"
CANARY = "canary-session-secret-3b1f9e7a5c2d4e6f8091a2b3c4d5e6f7"


def metric_source(mid: str, body: str, version: str = "1.0.0", requires=("served",), aggregate: str = "sum",
                  top: str = "") -> str:
    meta = dict(id=mid, version=version, name=mid, unit="u", direction="higher", problems=[RIDE],
                requires=list(requires), aggregate=aggregate, description="test metric", provenance="tests")
    return f"{top}\nMETADATA = {json.dumps(meta, ensure_ascii=False)}\n\n\ndef compute(ctx):\n{body}\n"


@pytest.fixture(autouse=True)
def clean_cache():
    CM._cache.clear()
    yield
    CM._cache.clear()


@pytest.fixture
def lab(tmp_path, monkeypatch):
    """An installation in sandbox mode holding secrets: another researcher's data, a credential store, a canary in the
    server's environment and a local service listening."""
    sandbox_or_skip(tmp_path)
    plugins, data = tmp_path / "plugins", tmp_path / "data"
    plugins.mkdir()
    auth = tmp_path / "auth.sqlite3"
    auth.write_text("credential store")
    inst = Installation(data, plugins, "inst-metrics", plugin_mode="sandbox", protected=(auth,))
    alice, bob = Workspace(inst, "alice", "Alice"), Workspace(inst, "bob", "Bob")
    secret = bob.root / "campaigns" / "c-private" / "campaign.json"
    secret.parent.mkdir(parents=True)
    secret.write_text('{"secret": "bob data"}')
    monkeypatch.setenv("MOVE_OPENLAB_SESSION_SECRET", CANARY)
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)

    def add(name: str, src: str):
        (plugins / name).mkdir(exist_ok=True)
        (plugins / name / CM.METRIC_FILE).write_text(src)
        return plugins / name / CM.METRIC_FILE
    yield dict(inst=inst, alice=alice, bob=bob, add=add, secret=secret, auth=auth, data=data, plugins=plugins,
               port=srv.getsockname()[1], problem=registry.get(RIDE), tmp=tmp_path)
    srv.close()


def ctxs(*served):
    return [dict(metrics=dict(served=s, detour_s=60.0 * s), domain={}, instance={}) for s in served]


def values(w, problem, contexts, mid):
    for meta, ev in w.metric_evaluations(problem, contexts):
        if meta["id"] == mid:
            return meta, ev
    raise AssertionError(f"{mid} not listed")


def test_probe_sees_no_secret_no_other_workspace_and_no_network(lab):
    """Every observation is encoded as a bit of the returned value: 1000 means nothing leaked."""
    targets = dict(other=str(lab["secret"]), auth=str(lab["auth"]), data=str(lab["data"]),
                   own=str(lab["alice"].root), plugins=str(lab["plugins"]), port=lab["port"], canary=CANARY)
    body = f"""    import os, socket
    t = {json.dumps(targets)}
    if ctx["metrics"]["served"] == 1:
        return 1.0
    bits = 0
    for i, p in enumerate((t["other"], t["auth"])):
        try:
            open(p).read(); bits |= 1 << i
        except OSError:
            pass
    for i, d in enumerate((t["data"], t["own"], t["plugins"]), start=2):
        try:
            os.listdir(d); bits |= 1 << i
        except OSError:
            pass
    if t["canary"] in repr(dict(os.environ)):
        bits |= 32
    for pid in [p for p in os.listdir("/proc") if p.isdigit()]:
        try:
            if t["canary"].encode() in open(f"/proc/{{pid}}/environ", "rb").read():
                bits |= 64
        except OSError:
            pass
    for host in ("127.0.0.1", "192.0.2.1"):
        try:
            s = socket.socket(); s.settimeout(1); s.connect((host, t["port"])); s.close(); bits |= 128
        except OSError:
            pass
    try:
        open(__file__, "a").write("#"); bits |= 256
    except OSError:
        pass
    return 1000.0 + bits"""
    lab["add"]("probe", metric_source("probe", body))
    entry = lab["alice"].register_metric(lab["problem"], "probe")
    assert entry["selftest"]["value"] == 1.0 and entry["isolation_at_registration"] == "sandbox"
    meta, ev = values(lab["alice"], lab["problem"], ctxs(2), "probe")
    assert ev.per == [1000.0], f"leaks (bit mask): {ev.per} {ev.issues}"
    assert meta["trust"] == CM.TRUST_SANDBOX and meta["code_sha256"] == entry["code_sha256"]
    # the probe is not vacuous: in a plain separate process (trusted-process mode, not a sandbox) it does see the
    # other workspace, the credential store, the data directory and the local service
    f = lab["plugins"] / "probe" / CM.METRIC_FILE
    spec = CM.spec_from_metadata(CM.read_metadata(f), CM.code_sha256(f))
    plain = CM.evaluate_isolated(spec, ctxs(2), str(f), "process").per[0]
    assert plain is not None and int(plain - 1000) & (1 | 2 | 4 | 128) == (1 | 2 | 4 | 128)


def test_metric_code_never_runs_in_the_server_process(lab):
    """Top-level code of a metric file would write a marker if it were ever executed outside the sandbox (where the
    plugin directory is not writable and the marker path does not exist)."""
    marker = lab["tmp"] / "imported-in-server"
    top = f"open({str(marker)!r}, 'w').write('x')"
    body = "    return 1.0"
    lab["add"]("side_effect", metric_source("side-effect", body, top=top).replace(top, f"try:\n    {top}\nexcept OSError:\n    pass"))
    assert [i["plugin"] for i in CM.discover(lab["plugins"], lab["problem"])] == ["side_effect"]
    lab["alice"].available_metrics(lab["problem"])
    lab["alice"].register_metric(lab["problem"], "side_effect")
    _, ev = values(lab["alice"], lab["problem"], ctxs(3, 4), "side-effect")
    assert ev.per == [1.0, 1.0]
    assert not marker.exists()
    assert not [m for m in sys.modules if m.startswith("move_openlab_metric_")]


def test_registered_metrics_belong_to_one_workspace(lab):
    lab["add"]("count", metric_source("served-count", '    return ctx["metrics"]["served"]'))
    lab["alice"].register_metric(lab["problem"], "count")
    assert [m["id"] for m in lab["alice"].registered_metrics(RIDE)] == ["served-count"]
    assert lab["bob"].registered_metrics(RIDE) == []
    assert "served-count" not in [m["id"] for m, _ in lab["bob"].metric_evaluations(lab["problem"], ctxs(2))]
    _, ev = values(lab["alice"], lab["problem"], ctxs(2, 5), "served-count")
    assert ev.per == [2.0, 5.0] and ev.total == 7.0


def test_timeout_and_memory_limits(lab, monkeypatch):
    monkeypatch.setattr(CM, "TIMEOUT_S", 3.0)
    lab["add"]("spin", metric_source("spin", "    while ctx['metrics']['served'] > 1:\n        pass\n    return 1.0"))
    lab["add"]("hog", metric_source("hog", "    if ctx['metrics']['served'] > 1:\n        b = bytearray(3 * 1024 ** 3)\n"
                                           "        return float(len(b))\n    return 1.0"))
    for p in ("spin", "hog"):
        lab["alice"].register_metric(lab["problem"], p)
    t0 = time.perf_counter()
    _, ev = values(lab["alice"], lab["problem"], ctxs(2), "spin")
    assert ev.per == [None] and ev.total is None and "timeout" in ev.issues[0]
    assert time.perf_counter() - t0 < 15
    _, ev = values(lab["alice"], lab["problem"], ctxs(1, 2), "hog")
    assert ev.per == [1.0, None] and ev.issues == ["computation failed (MemoryError) in 1 scenario"]


def test_invalid_outputs_are_rejected_and_reported(lab):
    body = """    s = ctx["metrics"]["served"]
    return {1: 1.0, 2: "text", 3: float("nan"), 4: (1, 2, 3), 5: True, 7: [1.0, 2.0]}.get(s) if s != 6 else 1 / 0"""
    lab["add"]("bad", metric_source("bad-outputs", body))
    lab["alice"].register_metric(lab["problem"], "bad")
    _, ev = values(lab["alice"], lab["problem"], ctxs(1, 2, 3, 4, 5, 6, 7, 8), "bad-outputs")
    assert ev.per == [1.0, None, None, None, None, None, None, None] and ev.total == 1.0
    # NaN and a pair where a number is expected; a 3-tuple, a string and a boolean; an exception; 8 → None = no value
    assert sorted(ev.issues) == ["computation failed (ZeroDivisionError) in 1 scenario",
                                 "invalid output (bool) in 1 scenario", "invalid output (expected a finite number) in 2 scenarios",
                                 "invalid output (str) in 1 scenario", "invalid output (tuple) in 1 scenario"]
    # a ratio-of-sums metric must return a pair; a metric failing its self-test is not registered
    lab["add"]("ratio", metric_source("bad-ratio", "    return 3.0", aggregate="ratio-of-sums"))
    with pytest.raises(ContractError, match="self-test failed"):
        lab["alice"].register_metric(lab["problem"], "ratio")
    assert "bad-ratio" not in [m["id"] for m in lab["alice"].registered_metrics()]


def test_modification_after_registration_is_refused(lab):
    f = lab["add"]("pinned", metric_source("pinned", "    return 1.0"))
    entry = lab["alice"].register_metric(lab["problem"], "pinned")
    f.write_text(metric_source("pinned", "    return 99.0"))            # same id and version, different code
    meta, ev = values(lab["alice"], lab["problem"], ctxs(2), "pinned")
    assert ev.per == [None] and meta["available"] is False and "changed since registration" in ev.issues[0]
    # even called directly with the registered hash, the worker refuses bytes that do not match it
    spec = CM.spec_from_metadata(CM.read_metadata(f), entry["code_sha256"])
    ev = CM.evaluate_isolated(spec, ctxs(2), str(f), "sandbox", lab["inst"].sandbox_spec)
    assert ev.per == [None] and "SHA-256" in ev.issues[0]
    # METADATA that no longer matches the registration is refused too
    f.write_text(metric_source("pinned", "    return 1.0", version="2.0.0"))
    spec = CM.spec_from_metadata(dict(CM.read_metadata(f), version="1.0.0"), CM.code_sha256(f))
    ev = CM.evaluate_isolated(spec, ctxs(2), str(f), "sandbox", lab["inst"].sandbox_spec)
    assert ev.per == [None] and "does not match its registration" in ev.issues[0]
    # a new semantic version is a new registration
    assert lab["alice"].register_metric(lab["problem"], "pinned")["version"] == "2.0.0"


def test_no_isolation_means_no_value(lab, monkeypatch):
    """Plugins switched off, or a sandbox that cannot be verified: the registered metric is listed with the reason and
    no value. Nothing falls back to an unsandboxed process."""
    lab["add"]("count", metric_source("served-count", '    return ctx["metrics"]["served"]'))
    lab["alice"].register_metric(lab["problem"], "count")
    off = Workspace(Installation(lab["data"], lab["plugins"], "inst-metrics", plugin_mode="disabled"), "alice", "Alice")
    meta, ev = values(off, lab["problem"], ctxs(2), "served-count")
    assert ev.per == [None] and meta["available"] is False and "disabled" in ev.issues[0]

    def broken(spec, refresh=False):
        raise sandbox.SandboxUnavailable("isolation check failed")
    monkeypatch.setattr(sandbox, "verify", broken)
    calls = []
    monkeypatch.setattr("move_openlab.runner.execute_isolated", lambda *a, **k: calls.append(a) or ({}, 0))
    _, ev = values(lab["alice"], lab["problem"], ctxs(3), "served-count")
    assert ev.per == [None] and calls == []
    with pytest.raises(ContractError):
        off.register_metric(lab["problem"], "count")


def test_registration_rules(lab, tmp_path):
    lab["add"]("count", metric_source("served-count", '    return ctx["metrics"]["served"]'))
    lab["add"]("builtin_clash", metric_source("detour-per-served-rider", "    return 1.0"))
    lab["add"]("wrong_input", metric_source("wrong-input", "    return 1.0", requires=("accuracy",)))
    with pytest.raises(ContractError, match="built-in"):
        lab["alice"].register_metric(lab["problem"], "builtin_clash")
    with pytest.raises(ContractError, match="not a validated metric"):
        lab["alice"].register_metric(lab["problem"], "wrong_input")
    with pytest.raises(ContractError, match="not defined for problem"):
        lab["alice"].register_metric(registry.get("synthetic-capacitated-bipartite-assignment"), "count")
    lab["alice"].register_metric(lab["problem"], "count")
    with pytest.raises(Exception, match="already registered"):
        lab["alice"].register_metric(lab["problem"], "count")
    trusted = Workspace(Installation(tmp_path / "t", lab["plugins"], "inst-t", plugin_mode="trusted-process"), "bob", "Bob")
    with pytest.raises(Forbidden):
        trusted.register_metric(lab["problem"], "count", admin=False)
    entry = trusted.register_metric(lab["problem"], "count", admin=True)
    assert entry["trust"] == CM.TRUST_PROCESS and entry["isolation_at_registration"] == "process"


def test_api_registers_and_computes_the_example_metric(tmp_path):
    """The shipped example file, registered through the API, computed in the sandbox from the validated CO₂ figures."""
    import shutil
    from test_api import login, make_client
    from conftest import ROOT
    sandbox_or_skip(tmp_path)
    plugins = tmp_path / "plugins"
    shutil.copytree(ROOT / "plugins" / "co2_avoided_per_served_rider", plugins / "co2_avoided_per_served_rider")
    c = make_client(tmp_path, "mx", plugin_dir=plugins, plugin_mode="sandbox")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    listing = c.get(f"/api/lab/metrics?problem_id={RIDE}").json()
    assert [a["plugin"] for a in listing["available"]] == ["co2_avoided_per_served_rider"] and listing["can_register"]
    r = c.post("/api/lab/metrics/register", json=dict(problem_id=RIDE, plugin="co2_avoided_per_served_rider"))
    assert r.status_code == 200, r.text
    listed = {m["id"]: m for m in c.get(f"/api/lab/metrics?problem_id={RIDE}").json()["metrics"]}
    assert listed["co2-avoided-per-served-rider"]["trust"] == CM.TRUST_SANDBOX
    assert listed["detour-per-served-rider"]["trust"] == CM.TRUST_BUILTIN
    e = c.get(f"/api/lab/experiments/{base}").json()
    for row in e["results"]["rows"]:
        d = row["domain"]
        assert d["complete"] and row["custom"]["co2-avoided-per-served-rider"] == pytest.approx(d["avoided_g"] / 1000 / row["totals"]["served"])
        assert row["custom_issues"] == {}
        for cell in row["per_scenario"].values():
            assert cell["custom"]["co2-avoided-per-served-rider"] == pytest.approx(
                cell["domain"]["avoided_g"] / 1000 / cell["metrics"]["served"])
    # another researcher of the same installation does not get it
    login(c, "bob")
    assert [m["id"] for m in c.get(f"/api/lab/metrics?problem_id={RIDE}").json()["metrics"]] == ["detour-per-served-rider"]
