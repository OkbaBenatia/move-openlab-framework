"""Workflow corrections: short derived titles (never nested) with display labels for old ones, the per-network travel
cache (Save & Run reuses the preview's routing and gives the identical instance), the Workspace details preference,
the public synthetic benchmark (definition, run, independent oracle check) and running one added method."""
from move_openlab.store import base_title, display_title
from test_api import login, make_client, wait


def test_derived_titles_are_short_and_never_nested(tmp_path):
    c = make_client(tmp_path, "titles")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    r1 = c.post(f"/api/campaigns/{base}/reproduce").json()
    wait(c, c.post(f"/api/campaigns/{r1['campaign_id']}/execute").json())
    c.post(f"/api/campaigns/{r1['campaign_id']}/lock")
    r2 = c.post(f"/api/campaigns/{r1['campaign_id']}/reproduce").json()      # a reproduction of a reproduction
    assert r1["title"] == "Montbéliard Demo — Reproduction 1"
    assert r2["title"] == "Montbéliard Demo — Reproduction 2"
    e = c.get(f"/api/lab/experiments/{r2['campaign_id']}").json()
    assert e["campaign"]["parent"]["campaign_id"] == r1["campaign_id"]      # the lineage is recorded separately
    assert e["campaign"]["record_title"] == r2["title"]


def test_old_nested_titles_get_short_display_labels():
    old = "Independent re-execution of Independent re-execution of Montbéliard Demo — Baseline"
    assert display_title(old) == "Montbéliard Demo — Baseline — Reproduction (of a reproduction)"
    assert display_title("Extension of X with My Greedy Matching") == "X — Extension (My Greedy Matching)"
    assert display_title("Plain title") == "Plain title"
    assert base_title(old) == base_title("Montbéliard Demo — Baseline — Reproduction 3") == "Montbéliard Demo — Baseline"


def test_save_reuses_the_preview_routing_and_freezes_the_same_instance(tmp_path):
    from move_openlab.geo import scenarios as SC
    from move_openlab.geo.osm import NetworkStore
    from geo_fixtures import BBOX, grid_overpass
    prov = NetworkStore(tmp_path).save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    net = NetworkStore(tmp_path).load(prov["network_id"])
    sc = SC.generate_synthetic(net, "travel cache", 3, 5, 7, 27000, 28800, dict(max_detour_s=1200, max_detour_ratio=1.0), 300)
    SC._travel.clear()
    a = SC.build_instance(SC.validate_scenario(sc), net, prov, "x")
    cached = len(SC._travel[prov["network_id"]])
    calls = []
    real = net.travel
    net.travel = lambda u, v: calls.append(1) or real(u, v)
    b = SC.build_instance(SC.validate_scenario(sc), net, prov, "x")
    net.travel = real
    assert cached > 0 and calls == []                     # the second build routes nothing again
    assert a == b                                         # and freezes exactly the same instance


def test_details_preference(tmp_path):
    c = make_client(tmp_path, "prefs")
    login(c, "alice")
    assert c.get("/api/lab/state").json()["preferences"]["details_open"] is None
    c.put("/api/lab/preferences", json=dict(details_open=True))
    assert c.get("/api/lab/state").json()["preferences"]["details_open"] is True



def test_public_benchmark_definition_run_and_oracle_check(tmp_path):
    c = make_client(tmp_path, "bench")
    login(c, "alice")
    d = c.get("/api/lab/benchmark/public").json()["definition"]
    assert d["scenario_params"] == dict(sizes=["small", "medium", "large"], seeds=list(range(1, 11)))
    assert "not the separate synthetic scientific study" in d["scope"] and "Planned" in d["scope"]
    small = dict(d, scenario_params=dict(sizes=["small"], seeds=[1, 2]))
    # the endpoint lists only runs of the frozen definition: a smaller run is not "the benchmark"
    x = c.post("/api/campaigns", json=dict(problem_id=d["problem_id"], title="smaller", scenario_params=small["scenario_params"],
                                           methods=[[m["method_id"], m["version"]] for m in d["methods"]], repetitions=1)).json()
    wait(c, c.post(f"/api/campaigns/{x['campaign_id']}/execute").json())
    assert c.get("/api/lab/benchmark/public").json()["runs"] == []
    r = c.post("/api/campaigns", json=dict(problem_id=d["problem_id"], title=d["title"], scenario_params=d["scenario_params"],
                                           methods=[[m["method_id"], m["version"]] for m in d["methods"]], repetitions=1)).json()
    wait(c, c.post(f"/api/campaigns/{r['campaign_id']}/execute").json())
    run = c.get("/api/lab/benchmark/public").json()["runs"][0]
    assert run["scenarios"] == 30
    m = {x["method_id"]: x for x in run["methods"]}
    assert m["exact-milp-highs"]["oracle_optimal"] == m["exact-milp-highs"]["runs"] == 30
    assert m["greedy-min-cost"]["accepted"] == 30 and m["greedy-min-cost"]["oracle_optimal"] < 30


def test_one_added_method_runs_as_an_extension_of_the_locked_experiment(tmp_path):
    """What "Run with this method" does: one method on the frozen scenarios, as an extension; the original is untouched."""
    from conftest import ROOT, sandbox_or_skip
    import shutil
    sandbox_or_skip(tmp_path)
    plugins = tmp_path / "plugins"
    shutil.copytree(ROOT / "plugins" / "my_greedy_matching", plugins / "my_greedy_matching")
    c = make_client(tmp_path, "runm", plugin_dir=plugins, plugin_mode="sandbox")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    before = c.get(f"/api/campaigns/{base}").json()
    assert c.post("/api/problems/public-ride-matching/methods/register", json=dict(plugin="my_greedy_matching")).status_code == 200
    ext = c.post(f"/api/campaigns/{base}/extend", json=dict(methods=[["my-greedy-matching", "1.0.0"]])).json()
    wait(c, c.post(f"/api/campaigns/{ext['campaign_id']}/execute").json())
    e = c.get(f"/api/lab/experiments/{ext['campaign_id']}").json()
    assert e["campaign"]["title"] == "Montbéliard Demo — Extension 1 (My Greedy Matching)"
    assert e["validation"]["accepted"] == e["validation"]["runs"] == 9
    assert {r["method_id"] for r in e["results"]["rows"]} == {"exact-matching-highs", "greedy-min-detour", "my-greedy-matching"}
    assert c.get(f"/api/campaigns/{base}").json() == before
