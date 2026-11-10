"""Custom metrics: the contract, aggregation with worked examples, problem filtering (no Accuracy on mobility), loading
from installed packages, and values computed by the platform from validated figures only."""
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


def test_installed_packages_provide_metrics(monkeypatch):
    class EP:
        def __init__(self, name, obj):
            self.name, self.value, self._obj = name, name, obj

        def load(self):
            return self._obj
    good = spec(id="ext-metric", problems=("public-ride-matching",))
    monkeypatch.setattr(CM, "entry_points", lambda group: [EP("good", good), EP("broken", spec(id="BROKEN")), EP("dup", DETOUR_PER_SERVED_RIDER)])
    monkeypatch.setattr(CM, "_metrics", None)
    monkeypatch.setattr(CM, "_errors", {})
    assert "ext-metric" in [m.id for m in CM.for_problem("public-ride-matching")]
    st = CM.status()
    assert "broken" in st["errors"] and "dup" in st["errors"] and "ext-metric" in st["loaded"]


def test_values_come_from_validated_figures(tmp_path):
    c = make_client(tmp_path, "cm")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    listed = c.get("/api/lab/metrics?problem_id=public-ride-matching").json()["metrics"]
    assert [m["id"] for m in listed] == ["detour-per-served-rider"] and listed[0]["trust"].startswith("computed by the platform")
    assert c.get("/api/lab/metrics?problem_id=synthetic-capacitated-bipartite-assignment").json()["metrics"] == []
    e = c.get(f"/api/lab/experiments/{base}").json()
    for row in e["results"]["rows"]:
        t = row["totals"]                                                  # validator-recomputed totals
        assert row["custom"]["detour-per-served-rider"] == pytest.approx(t["detour_s"] / 60 / t["served"])
        for cell in row["per_scenario"].values():
            m = cell["metrics"]
            assert cell["custom"]["detour-per-served-rider"] == pytest.approx(m["detour_s"] / 60 / m["served"])


def test_example_package_declares_and_computes_its_metric(tmp_path):
    """examples/custom_metric: the entry point it declares, its contract, and values equal to the validated figures."""
    import importlib.util
    import tomllib
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "examples" / "custom_metric"
    ep = tomllib.loads((root / "pyproject.toml").read_text())["project"]["entry-points"][CM.GROUP]
    assert ep == {"co2-avoided-per-served-rider": "openlab_metric_example:CO2_AVOIDED_PER_SERVED_RIDER"}
    spec_ = importlib.util.spec_from_file_location("openlab_metric_example", root / "openlab_metric_example" / "__init__.py")
    mod = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(mod)
    m = mod.CO2_AVOIDED_PER_SERVED_RIDER
    assert CM.check(m) == [] and m.problems == ("public-ride-matching",)
    # worked example: (-2 kg + 6 kg) / (1 + 3) riders = 1 kg per served rider; incomplete CO2 figures give no value
    per, total = CM.evaluate(m, [dict(metrics=dict(served=1), domain=dict(complete=True, avoided_g=-2000.0), instance={}),
                                 dict(metrics=dict(served=3), domain=dict(complete=True, avoided_g=6000.0), instance={}),
                                 dict(metrics=dict(served=2), domain=dict(complete=False, avoided_g=1.0), instance={})])
    assert per == [-2.0, 2.0, None] and total == 1.0
    CM.register(m)
    try:
        c = make_client(tmp_path, "cmx")
        login(c, "alice")
        base = c.post("/api/lab/demo").json()["baseline_id"]
        e = c.get(f"/api/lab/experiments/{base}").json()
        for row in e["results"]["rows"]:
            d = row["domain"]
            assert d["complete"] and row["custom"][m.id] == pytest.approx(d["avoided_g"] / 1000 / row["totals"]["served"])
    finally:
        CM.unregister(m.id)
