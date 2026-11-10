"""Scientific audit of the comparison engine on the shipped demonstration: verdicts are claim-dependent (results,
runtime and CO₂ have their own conditions), a CO₂ calculation change is a new, traceable configuration that changes the
CO₂ figures and fingerprints but neither the decisions nor the locked original, and validation, reproducibility and
comparability stay three separate statements."""
import pytest

from test_api import login, make_client, wait


@pytest.fixture(scope="module")
def lab(tmp_path_factory):
    c = make_client(tmp_path_factory.mktemp("audit"), "audit")
    login(c, "alice")
    d = c.post("/api/lab/demo").json()
    base = d["baseline_id"]
    variant = next(x for x in d["campaigns"] if x != base)
    e = c.get(f"/api/lab/experiments/{base}").json()
    hs = [s["instance_hash"] for s in e["scenarios"]]
    ms = [[m["method_id"], m["version"]] for m in e["methods"]]

    def run(title, **kw):
        r = c.post("/api/lab/run", json=dict(title=title, methods=kw.pop("methods", ms), repetitions=kw.pop("repetitions", 1),
                                             instance_hashes=kw.pop("hashes", hs), **kw)).json()
        wait(c, r["job"])
        return r["campaign_id"]
    ids = dict(base=base, variant=variant,
               tailpipe=run("tailpipe", emissions=dict(scope="tailpipe", baseline="everyone-drives-alone")),
               greedy=run("greedy only", methods=[ms[1]]), subset=run("one scenario", hashes=hs[:1]))
    rp = c.post(f"/api/campaigns/{base}/reproduce").json()
    wait(c, c.post(f"/api/campaigns/{rp['campaign_id']}/execute").json())
    ids["reproduction"] = rp["campaign_id"]
    verdicts = {x["campaign_id"]: x for x in c.get(f"/api/lab/compatible?a={base}").json()["candidates"]}
    return c, ids, verdicts, e


def _v(verdicts, cid):
    x = verdicts[cid]
    v = x.get("verdict") or x
    return {k: v.get(k) for k in ("quality", "runtime", "emissions")}, v.get("reasons") or []


def test_verdicts_are_claim_dependent(lab):
    c, ids, verdicts, _ = lab
    assert _v(verdicts, ids["reproduction"])[0] == dict(quality="direct", runtime="direct", emissions="direct")
    assert _v(verdicts, ids["variant"])[0]["quality"] == "direct"
    # another CO₂ calculation on the same frozen scenarios: results comparable, CO₂ not, and the reason says why
    v, why = _v(verdicts, ids["tailpipe"])
    assert v["quality"] == "direct" and v["emissions"] == "incompatible"
    assert any("emission scope: operational-energy vs tailpipe" in r for r in why)
    # other repetitions behind the runtime medians: runtime conditional, results direct
    v, why = _v(verdicts, ids["greedy"])
    assert v == dict(quality="direct", runtime="conditional", emissions="direct")
    assert any("repetitions" in r for r in why)


def test_a_co2_calculation_change_is_a_new_traceable_configuration(lab):
    c, ids, _, base_exp = lab
    t = c.get(f"/api/lab/experiments/{ids['tailpipe']}").json()
    assert t["campaign"]["emissions"] == dict(scope="tailpipe", baseline="everyone-drives-alone")
    assert c.post(f"/api/campaigns/{ids['tailpipe']}/lock").status_code == 200          # fingerprints of locked records
    fb = c.get(f"/api/lab/experiments/{ids['base']}/evidence").json()["fingerprints"]
    ft = c.get(f"/api/lab/experiments/{ids['tailpipe']}/evidence").json()["fingerprints"]
    assert fb["experiment"] != ft["experiment"]
    rows_b = {r["method_id"]: r for r in base_exp["results"]["rows"] if r["campaign_id"] == ids["base"]}
    rows_t = {r["method_id"]: r for r in t["results"]["rows"] if r["campaign_id"] == ids["tailpipe"]}
    for m, rb in rows_b.items():
        rt = rows_t[m]
        assert rt["totals"] == rb["totals"]                                     # same decisions, same validated metrics
        assert rb["domain"]["scope"] == "operational-energy" and rt["domain"]["scope"] == "tailpipe"
        assert rt["domain"]["solution_g"] != rb["domain"]["solution_g"]        # CO₂ figures follow the calculation
    # the locked original is untouched
    again = c.get(f"/api/lab/experiments/{ids['base']}").json()
    assert again["campaign"]["locked"] and again["results"]["rows"] == base_exp["results"]["rows"]


def test_units_and_aggregation_of_co2_figures(lab):
    c, ids, _, e = lab
    for r in e["results"]["rows"]:
        d = r["domain"]
        assert d["complete"] and d["avoided_g"] == pytest.approx(d["baseline_g"] - d["solution_g"])
        assert d["avoided_pct"] == pytest.approx(100 * d["avoided_g"] / d["baseline_g"], abs=0.005)   # ratio of sums, % (2 dp)
        assert d["per_served_request_g"] == pytest.approx(d["solution_g"] / r["totals"]["served"], rel=1e-3)
        per = list(r["per_scenario"].values())
        assert sum(x["domain"]["solution_g"] for x in per) == pytest.approx(d["solution_g"])       # sum over scenarios
        assert sum(x["metrics"]["served"] for x in per) == r["totals"]["served"]


def test_scenario_level_values_are_matched_by_frozen_instance(lab):
    """A one-scenario experiment compared with the three-scenario baseline: the engine judges the shared scenario; the
    experiment's own totals cover only that scenario (the interface puts no total beside the baseline's)."""
    c, ids, verdicts, e = lab
    s = c.get(f"/api/lab/experiments/{ids['subset']}").json()
    assert [x["instance_hash"] for x in s["scenarios"]] == [e["scenarios"][0]["instance_hash"]]
    assert _v(verdicts, ids["subset"])[0]["quality"] == "direct"
    h = e["scenarios"][0]["instance_hash"]
    rb = {r["method_id"]: r for r in e["results"]["rows"] if r["campaign_id"] == ids["base"]}
    for r in s["results"]["rows"]:
        if r["campaign_id"] == ids["subset"]:
            assert r["per_scenario"][h]["metrics"] == rb[r["method_id"]]["per_scenario"][h]["metrics"]
            assert r["totals"]["served"] < rb[r["method_id"]]["totals"]["served"]          # totals of another scope


def test_validation_reproducibility_and_comparability_are_separate(lab):
    c, ids, _, _ = lab
    r = c.get(f"/api/lab/experiments/{ids['reproduction']}").json()
    assert r["validation"]["accepted"] == r["validation"]["runs"]          # 1. independent validation
    assert r["reproduction"]["reproduced"] is True                          # 2. reproducibility
    assert r["comparability"]["quality"] == "direct"                        # 3. semantic comparability (per claim)
    assert {"quality", "runtime", "emissions"} <= set(r["comparability"])


def test_no_heuristic_or_time_limited_run_claims_optimality(lab):
    c, ids, _, e = lab
    for r in e["results"]["rows"]:
        if r["kind"] != "exact":
            assert not r["proven_optimal"]
