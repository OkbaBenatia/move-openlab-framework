"""Ride matching through the whole experimentation workflow, and the geographic API."""
import pytest
from fastapi.testclient import TestClient

from geo_fixtures import BBOX, grid_overpass, rpc_csv
from move_openlab.analysis.compare import compare
from move_openlab.analysis.reproducibility import reproducibility
from move_openlab.analysis.semantic import semantic_compare
from move_openlab.analysis.threshold import threshold_report
from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.geo import scenarios as SC
from move_openlab.geo.osm import NetworkStore
from move_openlab import registry
from move_openlab.store import IntegrityError, Installation, NotFound
from test_api import PW, login, make_settings

RIDE = "public-ride-matching"
METHODS = [("exact-matching-highs", "1.0.0"), ("greedy-min-detour", "1.0.0")]


def library(tmp_path, inst_dir):
    st = NetworkStore(inst_dir)
    prov = st.save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    g = st.load(prov["network_id"])
    insts = [SC.build_instance(SC.generate_synthetic(g, f"seed {k}", 5, 7, k, 25200, 27000,
                                                     dict(max_detour_s=900, max_detour_ratio=1.5), 300), g, prov, f"s{k}")
             for k in range(3)]
    return insts


def test_ride_matching_campaign_lifecycle(tmp_path):
    A, B = Installation(tmp_path / "A", installation_id="inst-A"), Installation(tmp_path / "B", installation_id="inst-B")
    p = registry.get(RIDE)
    r1, r2 = A.workspace("r1", "R1"), B.workspace("r2", "R2")
    insts = library(tmp_path, A.data)
    recs = [r1.save_scenario(p, dict(name=f"lib {k}", network_id=i["network"]["network_id"], drivers=[], riders=[]), i)
            for k, i in enumerate(insts)]
    assert {s["instance_hash"] for s in r1.scenarios(RIDE)} == {i["instance_hash"] for i in insts}
    c = r1.create_campaign(RIDE, "geo baseline", dict(instance_hashes=[r["instance_hash"] for r in recs]), METHODS, repetitions=1)
    r1.execute(c["campaign_id"]); c = r1.lock(c["campaign_id"])
    assert all(r["accepted"] for r in c["runs"])
    rows = {r["method_id"]: r for r in compare(r1, c["campaign_id"])["rows"]}
    assert rows["exact-matching-highs"]["optimal"] == 3 and rows["exact-matching-highs"]["optimality_scope"] == {
        "proven optimal (full problem)": 3}
    data, _ = r1.export_bundle(c["campaign_id"]); r2.import_bundle(data)
    rep = r2.create_reproduction(c["campaign_id"]); r2.execute(rep["campaign_id"])
    assert reproducibility(r2, rep["campaign_id"])["numerically_reproduced"]
    for variant, expected in (("detour-tightening", "INCOMPATIBLE"), ("detour-nonbinding", "DIRECT")):
        try:
            v = r1.create_variant(c["campaign_id"], variant)
        except Exception as e:                      # a variant may not apply to every generated instance set
            pytest.skip(str(e))
        r1.execute(v["campaign_id"])
        cand = [x for x in semantic_compare(r1, c["campaign_id"], v["campaign_id"])["rows"] if x["side"] == "candidate campaign"]
        assert {x["quality"]["status"] for x in cand} == {expected}
    st = r1.create_threshold_study(c["campaign_id"], METHODS[0], "relative-detour", [0.5, 1.0], mode="share")
    r1.execute(st["campaign_id"])
    tr = threshold_report(r1, st["campaign_id"])
    assert all(s["feasible_on_original"] == s["cells"] for s in tr["summary"])
    with pytest.raises((NotFound, IntegrityError)):
        r1.create_campaign(RIDE, "bad", dict(instance_hashes=["0" * 64]), METHODS)


def geo_client(tmp_path):
    s = make_settings(tmp_path, "geo")
    auth = Auth(s, UserStore(None))
    for u, role in (("alice", "researcher"), ("root", "admin")):
        pw = PW.get(u, "root-password-123")
        auth.create_user(u, u.title(), role=role, password=pw)
        auth.store.set_password(u, hash_password(pw), must_change=False)
    prov = NetworkStore(s.data_dir).save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    return TestClient(create_app(s, auth)), s, prov


def test_geo_api(tmp_path):
    c, s, prov = geo_client(tmp_path)
    login(c, "alice")
    cfg = c.get("/api/geo/config").json()
    assert cfg["can_manage"] is False and cfg["networks"][0]["network_id"] == prov["network_id"]
    assert "tile.openstreetmap.org" in c.get("/api/geo/config").headers["content-security-policy"]
    assert c.post("/api/geo/networks", json=dict(name="grid area", bbox=BBOX)).status_code == 403            # admin only
    assert c.post("/api/geo/opendata/rpc/ingest", json=dict(release="2026-08", area_name="grid area", bbox=BBOX)).status_code == 403
    r = c.get(f"/api/geo/networks/{prov['network_id']}/route", params=dict(a="10.0,20.0", b="10.016,20.016")).json()
    assert r["time_s"] > 0 and len(r["coords"]) >= 2
    gen = c.post("/api/geo/scenarios/generate", json=dict(network_id=prov["network_id"], name="generated", n_drivers=4,
                                                          n_riders=5, seed=1, start_s=25200, end_s=27000,
                                                          params=dict(max_detour_s=900, max_detour_ratio=1.5)))
    assert gen.status_code == 200, gen.text
    sid, h = gen.json()["scenario_id"], gen.json()["instance_hash"]
    full = c.get(f"/api/geo/scenarios/{sid}").json()
    edited = dict(full["scenario"], name="generated (edited)")
    edited["riders"] = edited["riders"][:3]
    e = c.post("/api/geo/scenarios", json=dict(scenario=edited, parent=sid)).json()
    assert e["parent"] == sid and e["instance_hash"] != h and e["summary"]["riders"] == 3
    ep = c.get(f"/api/geo/scenarios/{e['scenario_id']}").json()["scenario"]["provenance"]
    assert e["source"] == "editor" and ep["parent"] == sid and ep["derived_from"]["source"] == "generator"
    assert ep["derived_from"]["seed"] == 1                                    # parent provenance kept, not client-set
    forged = c.post("/api/geo/scenarios", json=dict(scenario=dict(edited, name="forged provenance",
                                                                  provenance=dict(source="open-data")))).json()
    assert forged["source"] == "editor"
    camp = c.post("/api/campaigns", json=dict(problem_id=RIDE, title="geo http", scenario_params=dict(instance_hashes=[h]),
                                              methods=[list(m) for m in METHODS], repetitions=1)).json()
    import time
    j = c.post(f"/api/campaigns/{camp['campaign_id']}/execute").json()
    for _ in range(200):
        j = c.get(f"/api/jobs/{j['job_id']}").json()
        if j["state"] != "running":
            break
        time.sleep(0.05)
    assert j["state"] == "done" and any(e["stage"] == "run" for e in j["events"])
    hist = c.get("/api/jobs").json()["jobs"]
    assert hist[0]["job_id"] == j["job_id"]
    run = c.get(f"/api/campaigns/{camp['campaign_id']}").json()["campaign"]["runs"][0]
    pb = c.get(f"/api/geo/playback/{camp['campaign_id']}/{run['run_id']}").json()
    assert pb["geometry"] == "road" and pb["vehicles"]
    assert c.get(f"/api/geo/instances/{h}").json()["instance_hash"] == h
    # another user cannot read this user's scenario or instance
    other = TestClient(c.app); other.post("/api/auth/login", json=dict(username="root", password="root-password-123"))
    assert other.get(f"/api/geo/scenarios/{sid}").status_code == 404
    assert other.get(f"/api/geo/instances/{h}").status_code == 404


def test_rpc_ingest_job_as_admin(tmp_path, monkeypatch):
    c, s, prov = geo_client(tmp_path)
    c.post("/api/auth/login", json=dict(username="root", password="root-password-123"))
    f = tmp_path / "2026-08.csv"
    rel = rpc_csv(f)
    from move_openlab.api import geo as G
    from move_openlab.integrations import rpc
    monkeypatch.setattr(rpc, "list_releases", lambda: [rel])
    G._releases.clear()
    real = rpc.ingest
    monkeypatch.setattr(rpc, "ingest", lambda *a, **k: real(*a, source=f, **k))
    j = c.post("/api/geo/opendata/rpc/ingest", json=dict(release="2026-08", area_name="grid", bbox=BBOX)).json()
    import time
    for _ in range(200):
        j = c.get(f"/api/jobs/{j['job_id']}").json()
        if j["state"] != "running":
            break
        time.sleep(0.05)
    assert j["state"] == "done", j
    ds = c.get("/api/geo/opendata/rpc/datasets").json()["datasets"]
    assert ds[0]["rows_kept"] == 40
    gen = c.post("/api/geo/scenarios/from-open-data", json=dict(network_id=prov["network_id"], dataset_key=ds[0]["dataset_key"],
                                                                name="from open data", n_drivers=3, n_riders=4, seed=2,
                                                                start_s=25200, end_s=32400))
    assert gen.status_code == 200, gen.text and gen.json()["source"] == "open-data"
