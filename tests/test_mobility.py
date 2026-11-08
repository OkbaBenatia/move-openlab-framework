"""Mobility domain: vehicle profiles, configurable emissions, their fingerprints, bundles and comparability; the
wizard endpoints (preview, save with provenance, Save & Run), the A/B diff, hidden records and the route fix."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from geo_fixtures import BBOX, grid_overpass, pt
from move_openlab import registry
from move_openlab.analysis.compare import compare
from move_openlab.analysis.semantic import semantic_compare
from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.comparability.model import problem_fingerprint
from move_openlab.geo import scenarios as SC
from move_openlab.geo.osm import NetworkStore
from move_openlab.mobility import emissions as E
from move_openlab.mobility import vehicles as V
from move_openlab.store import Installation
from test_api import PW, login, make_settings

RIDE = "public-ride-matching"
METHODS = [("exact-matching-highs", "1.0.0"), ("greedy-min-detour", "1.0.0")]
SRC = dict(source="test fixture", source_version="2026", applicability="tests")


def profile(pid="petrol", powertrain="ICE", **params):
    base = {"ICE": dict(fuel_consumption_l_100km=6.0, fuel_emission_factor_g_per_l=2300.0),
            "HEV": dict(fuel_consumption_l_100km=4.0, fuel_emission_factor_g_per_l=2300.0),
            "PHEV": dict(fuel_consumption_l_100km=2.0, fuel_emission_factor_g_per_l=2300.0,
                         electricity_consumption_kwh_100km=10.0, electricity_emission_factor_g_per_kwh=50.0),
            "BEV": dict(electricity_consumption_kwh_100km=16.0, electricity_emission_factor_g_per_kwh=50.0),
            "custom": dict(direct_co2_g_per_km=120.0)}[powertrain]
    base.update(params)
    return dict(id=pid, name=pid.title(), powertrain=powertrain, passenger_capacity=4,
                parameters={k: (dict(SRC, **v) if isinstance(v, dict) else dict(value=v, **SRC)) for k, v in base.items()},
                provenance=dict(kind="researcher"))


# ---------------------------------------------------------------- profiles and formulas
def test_vehicle_profile_validation_covers_every_powertrain():
    for pt_ in V.POWERTRAINS:
        p = V.validate_profile(profile("p", pt_))
        assert p["powertrain"] == pt_ and p["parameters"] and all("source" in r for r in p["parameters"].values())
    assert V.validate_profile(profile(), stamp=True)["parameters"]["fuel_consumption_l_100km"]["recorded_at"]
    bare = V.validate_profile(dict(id="x", name="X", powertrain="ICE", parameters=dict(fuel_consumption_l_100km=5)))
    assert bare["parameters"]["fuel_consumption_l_100km"] == dict(value=5.0, unit="L/100 km")
    for bad in (dict(profile(), id="Bad Id"), dict(profile(), powertrain="steam"), dict(profile(), passenger_capacity=0),
                dict(profile(), parameters=dict(unknown_param=1)), dict(profile(), provenance=dict(kind="magic")),
                dict(profile(), parameters=dict(fuel_consumption_l_100km=dict(value=-1)))):
        with pytest.raises(ValueError):
            V.validate_profile(bad)
    f = V.validate_profile(profile(fuel_emission_factor_g_per_l=dict(value=2.3, unit="kg/L", basis="CO2e")))
    assert f["parameters"]["fuel_emission_factor_g_per_l"]["basis"] == "CO2e"


def test_emission_formulas_per_scope():
    km = 10_000.0                                                        # 10 km
    assert E.co2_g(profile("a", "ICE"), km, "tailpipe") == (pytest.approx(10 * 6.0 / 100 * 2300), [])
    assert E.co2_g(profile("a", "BEV"), km, "tailpipe") == (0.0, [])          # tailpipe zero, not life-cycle zero
    assert E.co2_g(profile("a", "BEV"), km, "operational-energy") == (pytest.approx(10 * 16 / 100 * 50), [])
    phev = E.co2_g(profile("a", "PHEV"), km, "operational-energy")
    assert phev == (pytest.approx(10 * 2 / 100 * 2300 + 10 * 10 / 100 * 50), [])  # explicit split, nothing invented
    assert E.co2_g(profile("a", "custom"), km, "direct-intensity") == (pytest.approx(1200.0), [])
    g, missing = E.co2_g(profile("a", "ICE"), km, "direct-intensity")
    assert g is None and missing == ["direct_co2_g_per_km"]              # never substituted
    g, missing = E.co2_g(profile("a", "BEV", electricity_emission_factor_g_per_kwh=dict(value=None)), km, "operational-energy")
    assert g is None and missing == ["electricity_emission_factor_g_per_kwh"]
    with pytest.raises(ValueError):
        E.validate_config(dict(scope="lifecycle"))


def _instance(vehicles=True, default="petrol", pet=None, missing=False):
    pet = pet or profile("petrol", "ICE")
    if missing:
        pet = profile("petrol", "ICE", fuel_emission_factor_g_per_l=dict(value=None))
    ev = profile("ev", "BEV")
    drivers = [dict(id="D1", origin=[0, 0], destination=[0, 1], earliest=0, latest=600, direct_s=600, direct_m=10_000.0),
               dict(id="D2", origin=[0, 0], destination=[0, 1], earliest=0, latest=600, direct_s=600, direct_m=8_000.0)]
    riders = [dict(id="R1", origin=[0, 0], destination=[0, 1], earliest=0, latest=900, direct_s=300, direct_m=5_000.0),
              dict(id="R2", origin=[0, 0], destination=[0, 1], earliest=0, latest=900, direct_s=300, direct_m=4_000.0)]
    if vehicles:
        drivers[0]["vehicle"], drivers[1]["vehicle"] = pet, ev
    pairs = [dict(driver="D1", rider="R1", to_pickup_s=100, ride_s=300, to_dest_s=300, detour_s=100, pickup_earliest=100,
                  pickup_latest=700, to_pickup_m=1_000.0, ride_m=5_000.0, to_dest_m=5_000.0)]
    inst = dict(instance_hash="x" * 64, instance_id="t", drivers=drivers, riders=riders, pairs=pairs)
    if vehicles:
        inst["vehicles"] = dict(default={"petrol": pet, "ev": ev}[default])
        inst["emissions"] = dict(scope="operational-energy", baseline="everyone-drives-alone")
    return inst


def test_solution_emissions_baseline_and_avoided():
    inst = _instance()
    r = E.compute(inst, [["D1", "R1"]], None)
    ice = lambda m: m / 1000 * 6 / 100 * 2300                             # noqa: E731
    ev = lambda m: m / 1000 * 16 / 100 * 50                               # noqa: E731
    base = ice(10_000) + ev(8_000) + ice(5_000) + ice(4_000)             # everyone drives alone (riders: default petrol)
    sol = ice(11_000) + ev(8_000) + ice(4_000)                           # D1 detours for R1, R2 still drives alone
    assert r["complete"] and r["baseline"] == "everyone-drives-alone" and r["scope"] == "operational-energy"
    assert r["baseline_g"] == pytest.approx(base, abs=0.1) and r["solution_g"] == pytest.approx(sol, abs=0.1)
    assert r["avoided_g"] == pytest.approx(base - sol, abs=0.1) and r["avoided_pct"] == pytest.approx(100 * (base - sol) / base, abs=0.01)
    assert r["served"] == 1 and r["vehicles_used"] == 3 and r["fleet"] == {"ICE": 1, "BEV": 1}
    assert r["per_served_request_g"] == pytest.approx(sol, abs=0.1) and r["basis"] == "CO2"
    assert set(r["parameters"]) == {"petrol", "ev"} and r["baseline_definition"]
    d = E.compute(inst, [["D1", "R1"]], dict(emissions=dict(scope="tailpipe", baseline="drivers-only")))
    assert d["baseline"] == "drivers-only" and d["baseline_g"] == pytest.approx(ice(10_000) + 0, abs=0.1)
    assert d["solution_g"] == pytest.approx(ice(11_000), abs=0.1) and d["vehicles_used"] == 2
    inc = E.compute(_instance(missing=True), [["D1", "R1"]], None)
    assert inc["complete"] is False and any("fuel_emission_factor_g_per_l" in m for m in inc["missing"])
    assert E.compute(_instance(vehicles=False), [["D1", "R1"]], None) is None
    assert E.aggregate([r, r])["solution_g"] == pytest.approx(2 * r["solution_g"], abs=0.1)
    assert E.aggregate([r, d]) is None and E.aggregate([r, inc]) is None and E.aggregate([]) is None
    desc = E.descriptor(inst, None)
    assert desc["scope"] == "operational-energy" and desc["assignment"] == {"D1": "petrol", "D2": "ev"} and desc["fingerprint"]
    assert E.descriptor(inst, dict(emissions=dict(scope="tailpipe", baseline="drivers-only")))["fingerprint"] != desc["fingerprint"]
    assert E.descriptor(_instance(vehicles=False), None) is None


# ---------------------------------------------------------------- instances, fingerprints, workflow
@pytest.fixture
def grid(tmp_path):
    inst = Installation(tmp_path / "A", installation_id="inst-A")
    st = NetworkStore(inst.data)
    prov = st.save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    return inst, st.load(prov["network_id"]), prov


def scenario(nid, vehicles=None, emissions=None, factor=50.0):
    drivers = [dict(id=f"D{k + 1}", origin=pt(k, 0), destination=pt(k, 6), earliest=25200, latest=26100) for k in range(3)]
    riders = [dict(id=f"R{k + 1}", origin=pt(k % 6, 1 + k % 3), destination=pt((k + 1) % 6, 5), earliest=25200 + 60 * k,
                   latest=26400 + 60 * k) for k in range(4)]
    sc = dict(name="grid scenario", network_id=nid, params=dict(max_detour_s=900, max_detour_ratio=1.5), drivers=drivers,
              riders=riders)
    if vehicles is not False:
        sc["vehicles"] = vehicles or dict(profiles=[profile("petrol", "ICE"), profile("ev", "BEV", electricity_emission_factor_g_per_kwh=factor)],
                                          default="petrol", assignments={"D2": "ev"})
        sc["emissions"] = emissions or dict(scope="operational-energy", baseline="everyone-drives-alone")
    return sc


def test_instances_carry_distances_and_frozen_vehicles_without_changing_the_problem(grid):
    inst_, g, prov = grid
    p = registry.get(RIDE)
    a = SC.build_instance(scenario(g.network_id), g, prov, "a")
    b = SC.build_instance(scenario(g.network_id, factor=400.0), g, prov, "a")            # one factor differs
    plain = SC.build_instance(scenario(g.network_id, vehicles=False), g, prov, "a")        # no vehicle data at all
    assert p.check_instance(a) == [] and p.check_instance(plain) == []
    assert all(d["direct_m"] > 0 for d in a["drivers"] + a["riders"]) and all(x["ride_m"] > 0 for x in a["pairs"])
    assert a["drivers"][1]["vehicle"]["id"] == "ev" and a["drivers"][0]["vehicle"]["id"] == "petrol"
    assert a["vehicles"]["default"]["id"] == "petrol" and a["emissions"]["scope"] == "operational-energy"
    assert a["instance_hash"] != b["instance_hash"] != plain["instance_hash"]            # experiments differ
    fp = lambda i: problem_fingerprint(p, i, p.objective_spec_id)["problem"]               # noqa: E731
    assert fp(a) == fp(b) == fp(plain)                                                   # same optimization problem
    ex = p.explain_problem_differences(a, b)
    assert ex["dimensions"] == [] and any("vehicle" in n["dimension"] for n in ex["nonbinding"])
    with pytest.raises(ValueError):
        SC.validate_scenario(scenario(g.network_id, vehicles=dict(profiles=[profile()], assignments={"D9": "petrol"})))
    with pytest.raises(ValueError):
        SC.validate_scenario(scenario(g.network_id, vehicles=dict(profiles=[profile()], default="nope")))
    bad = json.loads(json.dumps(a)); bad["drivers"][0]["vehicle"]["powertrain"] = "steam"
    assert any("vehicle" in e for e in p.check_instance_content(bad))


def _campaign(w, inst, emissions=None, title="emissions"):
    p = registry.get(RIDE)
    w.save_scenario(p, dict(name=title, network_id=inst["network"]["network_id"], drivers=[], riders=[]), inst)
    c = w.create_campaign(RIDE, title, dict(instance_hashes=[inst["instance_hash"]]), METHODS, repetitions=1, emissions=emissions)
    w.execute(c["campaign_id"])
    return w.lock(c["campaign_id"])


def test_runs_carry_emissions_and_bundles_restore_parameters_exactly(grid, tmp_path):
    A, g, prov = grid
    w = A.workspace("r1", "R1")
    inst = SC.build_instance(scenario(g.network_id), g, prov, "a")
    c = _campaign(w, inst, emissions=dict(scope="operational-energy", baseline="everyone-drives-alone"))
    assert c["config"]["emissions"] == dict(scope="operational-energy", baseline="everyone-drives-alone")
    assert all(r["domain"]["complete"] and r["domain"]["avoided_g"] is not None for r in c["runs"])
    assert any(s["stage"] == "domain" for s in c["runs"][0]["trace"])
    rows = {r["method_id"]: r for r in compare(w, c["campaign_id"])["rows"]}
    assert rows["exact-matching-highs"]["domain"]["scope"] == "operational-energy"
    exact_served = c["runs"][0]["validation"]["metrics"]["served"]
    assert rows[c["runs"][0]["method_id"]]["domain"]["served"] == exact_served
    data, info = w.export_bundle(c["campaign_id"])
    import io
    import zipfile
    man = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("manifest.json"))
    assert {v["id"] for v in man["vehicles"]} == {"petrol", "ev"} and man["emissions"]["configurations"][0]["scope"]
    assert man["emissions"]["descriptors"] and man["scenarios"][0]["vehicles"] == ["ev", "petrol"]
    B = Installation(tmp_path / "B", installation_id="inst-B").workspace("r2", "R2")
    rep = B.import_bundle(data)
    got = B.inst.get_instance(inst["instance_hash"])
    assert got["drivers"][1]["vehicle"] == inst["drivers"][1]["vehicle"]                 # byte-exact parameters
    assert got["vehicles"]["default"]["parameters"] == inst["vehicles"]["default"]["parameters"]
    assert rep["fingerprints"] == man["fingerprints"]
    # a different electricity factor is a different experiment and a different semantic fingerprint
    other = SC.build_instance(scenario(g.network_id, factor=400.0), g, prov, "a")
    c2 = _campaign(w, other, emissions=dict(scope="operational-energy", baseline="everyone-drives-alone"), title="other factor")
    _, info2 = w.export_bundle(c2["campaign_id"])
    man2 = json.loads(zipfile.ZipFile(io.BytesIO(w.export_bundle(c2["campaign_id"])[0])).read("manifest.json"))
    assert man2["fingerprints"]["experiment"] != man["fingerprints"]["experiment"]
    assert man2["fingerprints"]["semantic"] != man["fingerprints"]["semantic"]
    # a campaign-level scope change alone changes the experiment and semantic fingerprints too
    c3 = _campaign(w, inst, emissions=dict(scope="tailpipe", baseline="drivers-only"), title="tailpipe")
    man3 = json.loads(zipfile.ZipFile(io.BytesIO(w.export_bundle(c3["campaign_id"])[0])).read("manifest.json"))
    assert man3["fingerprints"] != man["fingerprints"]
    # comparability: quality stays direct, emissions become conditional (factor) or incompatible (scope)
    sem = semantic_compare(w, c["campaign_id"], c2["campaign_id"])
    cand = [r for r in sem["rows"] if r["side"] == "candidate campaign"]
    assert {r["quality"]["status"] for r in cand} == {"DIRECT"} and {r["emissions"]["status"] for r in cand} == {"CONDITIONAL"}
    assert any("vehicle parameters differ" in q for r in cand for q in r["emissions"]["qualifications"])
    sem3 = semantic_compare(w, c["campaign_id"], c3["campaign_id"])
    cand3 = [r for r in sem3["rows"] if r["side"] == "candidate campaign"]
    assert {r["emissions"]["status"] for r in cand3} == {"INCOMPATIBLE"} and {r["runtime"]["status"] for r in cand3} <= {"DIRECT", "CONDITIONAL"}
    assert any("scope" in x for r in cand3 for x in r["emissions"]["incompatible"])
    plain = SC.build_instance(scenario(g.network_id, vehicles=False), g, prov, "a")
    c4 = _campaign(w, plain, title="no vehicles")
    assert all("domain" not in r for r in c4["runs"])
    sem4 = semantic_compare(w, c4["campaign_id"], c4["campaign_id"])
    assert all(r["emissions"]["status"] == "INCOMPATIBLE" and not r["emissions_applicable"] for r in sem4["rows"])


# ---------------------------------------------------------------- HTTP: wizard, vehicles, diff, hidden, route
def client(tmp_path):
    s = make_settings(tmp_path, "mob")
    auth = Auth(s, UserStore(None))
    for u in ("alice", "bob"):
        auth.create_user(u, u.title(), password=PW[u])
        auth.store.set_password(u, hash_password(PW[u]), must_change=False)
    prov = NetworkStore(s.data_dir).save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    return TestClient(create_app(s, auth)), prov["network_id"]


def wait(c, job):
    for _ in range(400):
        j = c.get(f"/api/jobs/{job['job_id']}").json()
        if j["state"] != "running":
            assert j["state"] == "done", j
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_route_refuses_a_degenerate_route(tmp_path):
    c, nid = client(tmp_path)
    login(c, "alice")
    r = c.get(f"/api/geo/networks/{nid}/route", params=dict(a="10.0,20.0", b="10.0,20.0"))
    assert r.status_code == 400 and "same road node" in r.json()["detail"]
    r = c.get(f"/api/geo/networks/{nid}/route", params=dict(a="10.0,20.0", b="10.016,20.016"))
    assert r.status_code == 200 and len(r.json()["coords"]) >= 2
    far = c.get(f"/api/geo/networks/{nid}/route", params=dict(a="10.0,20.0", b="10.06,20.06"))      # snaps, but > 1500 m away
    assert far.status_code == 400 and "from the road network" in far.json()["detail"]
    assert c.get(f"/api/geo/networks/{nid}/route", params=dict(a="10.0,20.0", b="48.8,2.3")).status_code == 404


def test_wizard_preview_save_and_run(tmp_path):
    c, nid = client(tmp_path)
    login(c, "alice")
    veh = dict(profiles=[profile("petrol", "ICE")], default="petrol")
    basis = dict(source="synthetic", network_id=nid, name="wizard demand", n_drivers=4, n_riders=5, seed=3, start_s=25200,
                 end_s=27000, params=dict(max_detour_s=900, max_detour_ratio=1.5), min_trip_m=300, vehicles=veh,
                 emissions=dict(scope="tailpipe", baseline="everyone-drives-alone"))
    pv = c.post("/api/geo/scenarios/preview", json=basis)
    assert pv.status_code == 200, pv.text
    pv = pv.json()
    assert len(pv["scenario"]["drivers"]) == 4 and pv["summary"]["pairs"] >= 0 and pv["agents"][0]["vehicle"] == "petrol"
    assert c.get("/api/geo/scenarios").json()["scenarios"] == []                  # preview stored nothing
    assert c.post("/api/geo/scenarios/preview", json=dict(basis, source="dataset")).status_code == 400
    # save with the composition as basis: generator provenance kept, edited agents recorded
    sc = pv["scenario"]
    sc["drivers"][0]["latest"] += 60
    saved = c.post("/api/geo/scenarios", json=dict(scenario=sc, basis=basis))
    assert saved.status_code == 200, saved.text
    rec = c.get(f"/api/geo/scenarios/{saved.json()['scenario_id']}").json()
    prov = rec["scenario"]["provenance"]
    assert prov["source"] == "generator" and prov["seed"] == 3 and prov["edited_agents"] == ["D1"]
    assert rec["instance"]["drivers"][0]["vehicle"]["id"] == "petrol" and rec["instance"]["emissions"]["scope"] == "tailpipe"
    lib = c.get("/api/geo/scenarios").json()["scenarios"]
    assert lib[0]["category"] == "Generated"
    # Save & Run in one call
    run = c.post("/api/lab/run", json=dict(title="wizard experiment", methods=[list(m) for m in METHODS], repetitions=1,
                                           scenario=pv["scenario"], basis=basis,
                                           emissions=dict(scope="tailpipe", baseline="drivers-only")))
    assert run.status_code == 200, run.text
    run = run.json()
    wait(c, run["job"])
    e = c.get(f"/api/lab/experiments/{run['campaign_id']}").json()
    assert e["campaign"]["emissions"] == dict(scope="tailpipe", baseline="drivers-only") and e["campaign"]["category"] == "Generated"
    assert e["scenarios"][0]["vehicles"]["fleet"][0]["id"] == "petrol" and e["scenarios"][0]["emissions"]["baseline"] == "drivers-only"
    assert e["job_id"] == run["job"]["job_id"] and e["problem"]["domain_metrics"]
    row = e["results"]["rows"][0]
    assert row["domain"]["complete"] and row["domain"]["baseline"] == "drivers-only"
    assert c.get(f"/api/jobs?campaign={run['campaign_id']}").json()["jobs"][0]["job_id"] == run["job"]["job_id"]
    assert c.get("/api/jobs?campaign=nothing").json()["jobs"] == []
    assert c.post("/api/lab/run", json=dict(title="nothing", methods=[list(METHODS[0])])).status_code == 400
    # hidden records: a non-destructive preference
    st = c.put("/api/lab/preferences", json=dict(hidden_ids=[run["campaign_id"]])).json()
    assert st["preferences"]["hidden_ids"] == [run["campaign_id"]]
    exps = c.get("/api/lab/experiments").json()["experiments"]
    assert [x["hidden"] for x in exps if x["campaign_id"] == run["campaign_id"]] == [True]
    assert c.get(f"/api/campaigns/{run['campaign_id']}").status_code == 200       # still there
    assert c.put("/api/lab/preferences", json=dict(hidden_ids=["../x"])).status_code == 400


def test_vehicle_profiles_and_ab_diff(tmp_path):
    c, nid = client(tmp_path)
    login(c, "alice")
    v = c.get("/api/lab/vehicles").json()
    assert {p["id"] for p in v["parameters"]} == set(V.PARAMETERS) and {s["id"] for s in v["scopes"]} == set(E.SCOPES)
    assert v["mine"] == [] and v["default_emissions"] == E.DEFAULT
    assert len(v["presets"]) >= 2 and v["default"]["provenance"]["kind"] == "preset"
    for p in v["presets"]:                                               # every shipped value documents its source
        for rec in p["parameters"].values():
            if rec.get("value") is not None:
                assert rec.get("source") and rec.get("source_version") and rec.get("applicability"), (p["id"], rec)
    mine = c.put("/api/lab/vehicles", json=profile("my-ev", "BEV")).json()
    assert mine["version"] == 1 and mine["provenance"]["kind"] == "researcher"
    again = c.put("/api/lab/vehicles", json=dict(mine, name="My EV")).json()
    assert again["version"] == 2 and again["name"] == "My EV"
    dup = c.post("/api/lab/vehicles/my-ev/duplicate").json()
    assert dup["id"] == "my-ev-copy" and dup["provenance"]["derived_from"] == "my-ev"
    assert c.put("/api/lab/vehicles", json=dict(mine, powertrain="steam")).status_code == 400
    assert c.post("/api/lab/vehicles/nope/duplicate").status_code == 404
    other = TestClient(c.app); login(other, "bob")
    assert other.get("/api/lab/vehicles").json()["mine"] == []           # profiles are per workspace
    # two experiments on the same scenario with different electricity factors -> A/B diff
    def run_with(factor, title):
        basis = dict(source="synthetic", network_id=nid, name=title, n_drivers=4, n_riders=5, seed=7, start_s=25200,
                     end_s=27000, params=dict(max_detour_s=900, max_detour_ratio=1.5), min_trip_m=300,
                     vehicles=dict(profiles=[profile("petrol", "ICE"), profile("ev", "BEV", electricity_emission_factor_g_per_kwh=factor)],
                                   default="petrol", assignments={"D1": "ev"}))
        sc = c.post("/api/geo/scenarios/preview", json=basis).json()["scenario"]
        r = c.post("/api/lab/run", json=dict(title=title, methods=[list(m) for m in METHODS], repetitions=1, scenario=sc,
                                             basis=basis, emissions=dict(scope="operational-energy", baseline="everyone-drives-alone"))).json()
        wait(c, r["job"])
        return r["campaign_id"]
    a, b = run_with(50.0, "Experiment A"), run_with(400.0, "Experiment B")
    d = c.get("/api/lab/diff", params=dict(a=a, b=b))
    assert d.status_code == 200, d.text
    d = d.json()
    assert d["matched"] == 1 and d["a"]["method_id"] == "exact-matching-highs" and d["rows"][0]["same_instance"] is False
    row = d["rows"][0]
    assert row["assignments"]["same"] + row["assignments"]["changed"] + row["assignments"]["only_a"] == row["served"]["a"]
    assert row["emissions"]["a"]["complete"] and row["emissions"]["a"]["solution_g"] != row["emissions"]["b"]["solution_g"]
    assert d["totals"]["emissions"]["a"]["scope"] == "operational-energy" and d["comparability"]["quality"] == "direct"
    assert d["comparability"]["emissions"] == "conditional"
    dg = c.get("/api/lab/diff", params=dict(a=a, b=b, method_a="greedy-min-detour", method_b="greedy-min-detour")).json()
    assert dg["a"]["method_id"] == "greedy-min-detour"
    assert c.get("/api/lab/diff", params=dict(a=a, b=b, method_a="nope")).status_code == 400
    assert other.get("/api/lab/diff", params=dict(a=a, b=b)).status_code == 404
