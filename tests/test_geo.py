"""Road networks, routing, geographic scenarios, the ride-matching problem, playback and the open-data connector."""
import csv
import hashlib
import itertools
import json

import pytest

from geo_fixtures import BBOX, LAT0, LON0, STEP, grid_overpass, pt, rpc_csv
from move_openlab import registry
from move_openlab.geo import playback as PB
from move_openlab.geo import scenarios as SC
from move_openlab.geo.osm import NetworkStore, build_network, haversine_m, validate_bbox
from move_openlab.integrations import rpc

RIDE = "public-ride-matching"


@pytest.fixture
def netstore(tmp_path):
    st = NetworkStore(tmp_path / "data")
    prov = st.save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    return st, prov


def scenario(nid, n_d=4, n_r=6):
    drivers = [dict(id=f"D{k + 1}", origin=pt(k, 0), destination=pt(k, 6), earliest=25200, latest=26100) for k in range(n_d)]
    riders = [dict(id=f"R{k + 1}", origin=pt(k % 6, 1 + k % 3), destination=pt((k + 1) % 6, 5), earliest=25200 + 60 * k,
                   latest=26400 + 60 * k) for k in range(n_r)]
    return dict(name="grid scenario", network_id=nid, params=dict(max_detour_s=600, max_detour_ratio=1.0), drivers=drivers,
                riders=riders)


def test_network_build_is_deterministic_and_respects_access_and_oneway(netstore):
    st, prov = netstore
    net = build_network(grid_overpass())
    assert net["network_id"] == prov["network_id"] == build_network(grid_overpass())["network_id"]
    assert prov["licence"]["id"] == "ODbL-1.0" and prov["source"]["osm_timestamp"] == "2026-01-01T00:00:00Z"
    assert prov["source"]["raw_sha256"] == hashlib.sha256(grid_overpass()).hexdigest()
    g = st.load(prov["network_id"])
    idx = {o: i for i, o in enumerate(g.osm_node_ids)}
    # one-way row 1: travelling east along the row is direct, west must detour
    east, _ = g.travel(idx[1000 + 7], idx[1000 + 7 + 6])
    west, _ = g.travel(idx[1000 + 7 + 6], idx[1000 + 7])
    assert west > east
    # maxspeed=90 on row 3 makes it faster than an equal-length residential row
    assert g.travel(idx[1000 + 21], idx[1000 + 27])[0] < g.travel(idx[1000 + 35], idx[1000 + 41])[0]
    f = st.root / prov["network_id"] / "network.json"
    doc = json.loads(f.read_text()); doc["edges"][0][3] += 1; f.write_text(json.dumps(doc))
    with pytest.raises(ValueError):
        NetworkStore(st.root.parent).load(prov["network_id"])          # tampering detected


def test_snap_and_route(netstore):
    st, prov = netstore
    g = st.load(prov["network_id"])
    n, d = g.snap(LAT0 + 2 * STEP + 0.0004, LON0 + 3 * STEP)
    assert g.osm_node_ids[n] == 1000 + 2 * 7 + 3 and d < 60
    r = g.route(*(g.snap(*pt(0, 0))[0], g.snap(*pt(4, 4))[0]))
    assert r["coords"][0] == pt(0, 0) and r["coords"][-1] == pt(4, 4)
    assert abs(r["length_m"] - sum(haversine_m(*a, *b) for a, b in zip(r["coords"], r["coords"][1:]))) < 1
    with pytest.raises(ValueError):
        validate_bbox([0, 0, 2, 2])                                      # too large for one Overpass query


def test_scenario_instance_matches_its_compatibility_rule(netstore):
    st, prov = netstore
    g = st.load(prov["network_id"])
    inst = SC.build_instance(scenario(prov["network_id"]), g, prov, "geo-test")
    p = registry.get(RIDE)
    assert p.check_instance(inst) == [] and inst["network"]["attribution"] == "© OpenStreetMap contributors"
    idx = {o: i for i, o in enumerate(g.osm_node_ids)}
    T = lambda a, b: int(round(g.travel(idx[a], idx[b])[0]))      # noqa: E731
    expected = set()
    for d in inst["drivers"]:
        for r in inst["riders"]:
            tp = T(d["origin_node"], r["origin_node"])
            det = tp + T(r["origin_node"], r["destination_node"]) + T(r["destination_node"], d["destination_node"]) - d["direct_s"]
            lo, hi = max(d["earliest"] + tp, r["earliest"]), min(d["latest"] + tp, r["latest"])
            if 0 <= det <= min(600, int(1.0 * d["direct_s"])) and lo <= hi:
                expected.add((d["id"], r["id"]))
    assert {(q["driver"], q["rider"]) for q in inst["pairs"]} == expected and expected
    bad = json.loads(json.dumps(inst)); bad["pairs"][0]["detour_s"] += 1
    from move_openlab.hashing import with_hash
    assert any("inconsistent" in e for e in p.check_instance(with_hash(bad)))
    with pytest.raises(ValueError):
        SC.build_instance(dict(scenario(prov["network_id"]), drivers=[dict(id="D1", origin=[0.0, 0.0], destination=pt(1, 1),
                                                                             earliest=0, latest=10)]), g, prov, "far")


def brute(inst):
    best = (0, 0)
    pairs = inst["pairs"]
    for k in range(len(pairs) + 1):
        for combo in itertools.combinations(pairs, k):
            ds, rs = [p["driver"] for p in combo], [p["rider"] for p in combo]
            if len(set(ds)) == len(ds) and len(set(rs)) == len(rs):
                key = (-len(combo), sum(p["detour_s"] for p in combo))
                if key < (-best[0], best[1]):
                    best = (len(combo), key[1])
    return best


def test_exact_matches_brute_force_and_greedy_is_feasible(netstore):
    from move_openlab.benchmarks.ride_matching import model as M
    from move_openlab.methods import freeze
    st, prov = netstore
    g = st.load(prov["network_id"])
    p = registry.get(RIDE)
    checked = 0
    for seed in range(8):
        sc = SC.generate_synthetic(g, f"seed {seed}", 3, 4, seed, 25200, 27000, dict(max_detour_s=900, max_detour_ratio=1.5),
                                   min_trip_m=300)
        inst = SC.build_instance(sc, g, prov, f"s{seed}")
        if len(inst["pairs"]) > 14:
            continue
        ex = p.validate(inst, M.solve_exact(freeze(inst), M.EXACT_META["default_config"])["decisions"])
        gr = p.validate(inst, M.solve_greedy(freeze(inst), {})["decisions"])
        assert ex["feasible"] and gr["feasible"]
        assert (ex["metrics"]["served"], ex["metrics"]["detour_s"]) == brute(inst)
        assert p.objective_key(gr["metrics"]) >= p.objective_key(ex["metrics"])
        checked += 1
    assert checked >= 3


def test_generators_are_deterministic(netstore):
    st, prov = netstore
    g = st.load(prov["network_id"])
    a = SC.build_instance(SC.generate_synthetic(g, "det test", 3, 3, 7, 25200, 27000, min_trip_m=300), g, prov, "a")
    b = SC.build_instance(SC.generate_synthetic(g, "det test", 3, 3, 7, 25200, 27000, min_trip_m=300), g, prov, "a")
    c = SC.build_instance(SC.generate_synthetic(g, "det test", 3, 3, 8, 25200, 27000, min_trip_m=300), g, prov, "a")
    assert a["instance_hash"] == b["instance_hash"] != c["instance_hash"]


def test_playback_follows_the_instance_times(netstore):
    from move_openlab.benchmarks.ride_matching import model as M
    from move_openlab.methods import freeze
    st, prov = netstore
    g = st.load(prov["network_id"])
    inst = SC.build_instance(scenario(prov["network_id"]), g, prov, "geo-test")
    dec = M.solve_exact(freeze(inst), M.EXACT_META["default_config"])["decisions"]
    plan = PB.plan(inst, dec, g)
    assert plan["geometry"] == "road" and plan["served"] == len(dec) and len(plan["vehicles"]) == len(inst["drivers"])
    riders = {r["id"]: r for r in inst["riders"]}
    for v in plan["vehicles"]:
        ts = [q[2] for q in v["path"]]
        assert ts == sorted(ts)
        if v["rider"]:
            pick = next(s for s in v["stops"] if s["type"] == "pickup")
            assert riders[v["rider"]]["earliest"] <= pick["t"] <= riders[v["rider"]]["latest"]
    assert PB.plan(inst, dec, None)["geometry"] == "straight"
    assert {u["rider"] for u in plan["unserved"]} == set(riders) - {r for _, r in dec}


def test_rpc_ingestion_cleans_validates_and_records_provenance(tmp_path):
    f = tmp_path / "2026-08.csv"
    rel = rpc_csv(f)
    rep = rpc.ingest(rel, BBOX, "grid", tmp_path / "rpc", source=f)
    assert rep["rows_read"] == 47 and rep["rows_kept"] == 40
    assert rep["rejected"] == {"duplicate_journey": 1, "end_before_start": 1, "implausible_speed": 1, "invalid_coordinates": 1,
                               "invalid_datetime": 1, "non_positive_distance_or_duration": 1, "outside_area": 1}
    assert rep["source"]["sha256"] == hashlib.sha256(f.read_bytes()).hexdigest() and rep["licence"]["id"] == "fr-lo"
    assert "Registre de Preuve de Covoiturage" in rep["attribution"]
    out = (tmp_path / "rpc" / rep["dataset_key"] / "trips.csv").read_text()
    header = next(csv.reader([out.splitlines()[0]]))
    assert "journey_id" not in header and "trip_id" not in header                 # identifiers dropped
    trips, rep2 = rpc.load_trips(tmp_path / "rpc", rep["dataset_key"])
    assert len(trips) == 40 and rep2 == rep and [d["dataset_key"] for d in rpc.list_datasets(tmp_path / "rpc")] == [rep["dataset_key"]]


def test_empirical_scenarios_from_open_data(tmp_path, netstore):
    st, prov = netstore
    g = st.load(prov["network_id"])
    f = tmp_path / "2026-08.csv"
    rep = rpc.ingest(rpc_csv(f), BBOX, "grid", tmp_path / "rpc", source=f)
    trips, rep = rpc.load_trips(tmp_path / "rpc", rep["dataset_key"])
    sc = SC.generate_empirical(trips, rep, prov["network_id"], "open data", 4, 5, 3, 25200, 32400)
    assert sc["provenance"]["source"] == "open-data" and sc["provenance"]["licence"]["id"] == "fr-lo"
    assert sc == SC.generate_empirical(trips, rep, prov["network_id"], "open data", 4, 5, 3, 25200, 32400)
    inst = SC.build_instance(sc, g, prov, "emp")
    assert registry.get(RIDE).check_instance(inst) == []
    with pytest.raises(ValueError):
        SC.generate_empirical(trips, rep, prov["network_id"], "empty", 2, 2, 1, 0, 60)
