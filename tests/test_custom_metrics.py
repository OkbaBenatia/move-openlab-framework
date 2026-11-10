"""Custom metrics: the contract, aggregation with worked examples, problem filtering (no Accuracy on mobility), no
loading of installed packages in the server, the shipped example metric file, and values computed by the platform from
validated figures only. The security boundary of registered metrics is tested in test_metric_security.py."""
import math
from dataclasses import replace

import pytest

from move_openlab import custom_metrics as CM
from move_openlab.custom_metrics import DETOUR_PER_SERVED_RIDER, MetricSpec

from test_api import login, make_client


def spec(**kw):
    base = dict(id="test-metric", version="1.0.0", name="Test", unit="u", direction="higher", problems=("p",),
                requires=("x",), aggregate="sum", compute=lambda c: c["metrics"]["x"])
    return MetricSpec(**{**base, **kw})


def ctx(**metrics):
    return dict(metrics=metrics, domain={}, instance={})


def test_contract_is_checked():
    assert CM.check(DETOUR_PER_SERVED_RIDER) == []
    bad = {"id": "Bad Id", "version": "1", "direction": "up", "aggregate": "max", "problems": (), "requires": ("instance.colour",), "compute": None}
    for k, v in bad.items():
        assert CM.check(spec(**{k: v})), k
    assert CM.check(spec(name=" ")) and CM.check(object())
    with pytest.raises(ValueError):
        CM.register(spec(version="v1"))


def test_aggregation_worked_examples():
    # ratio of sums: (600 s + 1200 s) / (1 + 3) riders = 30 min / 4 = 7.5 min, not the mean of the ratios (8.33)
    per, total = CM.evaluate(DETOUR_PER_SERVED_RIDER, [ctx(detour_s=600, served=1), ctx(detour_s=1200, served=3)])
    assert per == [10.0, pytest.approx(20 / 3)] and total == 7.5
    s = spec()
    assert CM.evaluate(s, [ctx(x=1), ctx(x=2), ctx(x=6)]) == ([1.0, 2.0, 6.0], 9.0)
    assert CM.evaluate(replace(s, aggregate="mean"), [ctx(x=1), ctx(x=2), ctx(x=6)])[1] == 3.0
    assert CM.evaluate(replace(s, aggregate="median"), [ctx(x=1), ctx(x=2), ctx(x=6)])[1] == 2.0
    # a missing input, a failing formula or a non-finite value gives no value; the aggregate uses the others
    per, total = CM.evaluate(s, [ctx(x=4), ctx(y=1), ctx(x=math.inf)])
    assert per == [4.0, None, None] and total == 4.0
    boom = replace(s, compute=lambda c: 1 / 0)
    assert CM.evaluate(boom, [ctx(x=1)]) == ([None], None)
    assert CM.evaluate(DETOUR_PER_SERVED_RIDER, [ctx(detour_s=0, served=0)]) == ([None], None)


def test_metrics_are_offered_only_for_their_problem():
    acc = spec(id="accuracy", name="Accuracy", unit="%", problems=("binary-classification",), requires=("tp", "tn", "n"),
               aggregate="ratio-of-sums", compute=lambda c: (c["metrics"]["tp"] + c["metrics"]["tn"], c["metrics"]["n"]))
    CM.register(acc)
    try:
        ride = [m.id for m in CM.for_problem("public-ride-matching")]
        assert "detour-per-served-rider" in ride and "accuracy" not in ride       # no Accuracy on mobility
        assert [m.id for m in CM.for_problem("binary-classification")] == ["accuracy"]
        assert CM.for_problem("synthetic-capacitated-bipartite-assignment") == []
    finally:
        CM.unregister("accuracy")


def test_installed_packages_are_never_loaded(monkeypatch, tmp_path):
    """Metric packages declaring the former entry-point group are not imported by the server: listing and computing
    metrics never call an entry point's load()."""
    import importlib.metadata as md
    loaded = []

    class EP:
        name = value = "ext"

        def load(self):
            loaded.append(1)
            return spec(id="ext-metric", problems=("public-ride-matching",))
    real = md.entry_points
    monkeypatch.setattr(md, "entry_points", lambda **kw: [EP()] if kw.get("group") == "move_openlab.metrics" else real(**kw))
    assert [m.id for m in CM.builtin_for("public-ride-matching")] == ["detour-per-served-rider"]
    c = make_client(tmp_path, "ep")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    assert [m["id"] for m in c.get("/api/lab/metrics?problem_id=public-ride-matching").json()["metrics"]] == ["detour-per-served-rider"]
    c.get(f"/api/lab/experiments/{base}")
    assert loaded == []


def test_registered_metrics_cannot_use_the_in_process_path():
    reg = CM.spec_from_metadata(dict(id="x-metric", version="1.0.0", name="X", unit="u", direction="higher",
                                     problems=["p"], requires=["x"], aggregate="sum"))
    assert reg.source == "registered" and reg.compute is None
    with pytest.raises(ValueError, match="trusted in-process"):
        CM.register(reg)
    with pytest.raises(ValueError, match="unknown METADATA keys"):
        CM.spec_from_metadata(dict(id="x-metric", compute="print(1)"))


def test_values_come_from_validated_figures(tmp_path):
    c = make_client(tmp_path, "cm")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    listed = c.get("/api/lab/metrics?problem_id=public-ride-matching").json()["metrics"]
    assert [m["id"] for m in listed] == ["detour-per-served-rider"] and listed[0]["trust"] == CM.TRUST_BUILTIN
    assert c.get("/api/lab/metrics?problem_id=synthetic-capacitated-bipartite-assignment").json()["metrics"] == []
    e = c.get(f"/api/lab/experiments/{base}").json()
    for row in e["results"]["rows"]:
        t = row["totals"]                                                  # validator-recomputed totals
        assert row["custom"]["detour-per-served-rider"] == pytest.approx(t["detour_s"] / 60 / t["served"])
        for cell in row["per_scenario"].values():
            m = cell["metrics"]
            assert cell["custom"]["detour-per-served-rider"] == pytest.approx(m["detour_s"] / 60 / m["served"])


def test_example_metric_file_is_read_statically_and_its_formula_is_right():
    """plugins/co2_avoided_per_served_rider: METADATA read without executing the file, contract and compatibility,
    and the worked example — computed here by the trusted path from the same formula, so that the arithmetic is
    checked without a sandbox (the sandboxed computation is tested in test_metric_security.py)."""
    from pathlib import Path
    from move_openlab import registry
    f = Path(__file__).resolve().parents[1] / "plugins" / "co2_avoided_per_served_rider" / CM.METRIC_FILE
    m = CM.spec_from_metadata(CM.read_metadata(f), CM.code_sha256(f))
    assert m.id == "co2-avoided-per-served-rider" and m.problems == ("public-ride-matching",) and m.source == "registered"
    assert CM.compatibility(m, registry.get("public-ride-matching")) == []
    found = CM.discover(f.parents[1], registry.get("public-ride-matching"))
    assert [(i["plugin"], i["compatible"]) for i in found] == [("co2_avoided_per_served_rider", True)]
    ns: dict = {}
    exec(compile(f.read_text(), str(f), "exec"), ns)      # the test process only, never the server
    trusted = replace(m, source="builtin", compute=ns["compute"])
    # worked example: (-2 kg + 6 kg) / (1 + 3) riders = 1 kg per served rider; incomplete CO2 figures give no value
    per, total = CM.evaluate(trusted, [dict(metrics=dict(served=1), domain=dict(complete=True, avoided_g=-2000.0), instance={}),
                                       dict(metrics=dict(served=3), domain=dict(complete=True, avoided_g=6000.0), instance={}),
                                       dict(metrics=dict(served=2), domain=dict(complete=False, avoided_g=1.0), instance={})])
    assert per == [-2.0, 2.0, None] and total == 1.0


def test_a_metric_sees_only_its_declared_inputs():
    seen = []
    s = spec(requires=("x", "domain.avoided_g", "instance.riders"), compute=lambda c: seen.append(c) or 1.0)
    CM.evaluate(s, [dict(metrics=dict(x=1, secret=2), domain=dict(avoided_g=3.0, baseline_g=9.0), instance=dict(riders=4, drivers=5))])
    assert [{k: dict(v) for k, v in c.items()} for c in seen] == [dict(metrics=dict(x=1), domain=dict(avoided_g=3.0), instance=dict(riders=4))]
