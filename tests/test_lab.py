"""Workspace API, shipped demonstration, bundle format 2 (fingerprints, replay geometry), format 1 compatibility,
map tile configuration."""
import io
import json
import zipfile

import pytest

from move_openlab import demo
from move_openlab.bundles import FORMAT_V1, FORMAT_V2
from move_openlab.hashing import canonical, sha256_bytes
from move_openlab.settings import Settings
from move_openlab.store import Installation, IntegrityError
from move_openlab.api.web import csp_for

from test_api import login, make_client


def _rewrite(data: bytes, fn) -> bytes:
    """Apply ``fn(manifest, members) -> (manifest, members)`` and re-sign the manifest digest (a consistent forgery)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    members = {n: z.read(n) for n in z.namelist() if n not in ("manifest.json", "manifest.sha256")}
    man, members = fn(json.loads(z.read("manifest.json")), members)
    mb = canonical(man)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n, b in members.items():
            out.writestr(n, b)
        out.writestr("manifest.json", mb)
        out.writestr("manifest.sha256", sha256_bytes(mb))
    return buf.getvalue()


def test_demo_bundle_verifies_and_carries_format_2_metadata(tmp_path):
    w = Installation(tmp_path / "i", installation_id="inst-x").workspace("researcher1", "Researcher 1")
    rep, camps, insts, problem = w.verify_bundle(demo.bundle_bytes())
    man = demo.manifest()
    assert rep["format"] == FORMAT_V2 and rep["executable_code_in_bundle"] is False
    assert rep["geometry_verified"] == len(insts) == 6 and len(camps) == 2
    assert {c["title"] for c in camps.values()} == {"Public Mobility Demo — Baseline",
                                                     "Public Mobility Demo — Controlled Variant"}
    assert man["networks"][0]["licence"]["id"] == "ODbL-1.0" and man["networks"][0]["raw_sha256"]
    assert man["datasets"][0]["licence"]["id"] == "fr-lo" and man["datasets"][0]["release"]
    assert set(man["fingerprints"]) == {"experiment", "semantic"}
    assert all(s["seed"] in (1, 2, 3) for s in man["scenarios"])
    assert [entry["kind"] for entry in man["lineage"]] == ["variant", "baseline"]
    assert not any(n.endswith(".py") for n in zipfile.ZipFile(io.BytesIO(demo.bundle_bytes())).namelist())


def test_demo_reproduces_identically_on_another_installation(tmp_path):
    w = Installation(tmp_path / "i", installation_id="inst-y").workspace("researcher2", "Researcher 2")
    rep = w.import_bundle(demo.bundle_bytes())
    from move_openlab.analysis.reproducibility import reproducibility
    base = next(c["campaign_id"] for c in rep["campaigns_verified"] if c["kind"] == "baseline")
    r = w.create_reproduction(base)
    w.execute(r["campaign_id"])
    rr = reproducibility(w, r["campaign_id"])
    assert rr["numerically_reproduced"] and rr["cells"] == 6


def test_tampered_fingerprint_or_geometry_is_refused(tmp_path):
    w = Installation(tmp_path / "i").workspace("researcher1", "R1")
    data = demo.bundle_bytes()

    def bad_fp(man, m):
        man["fingerprints"]["semantic"] = "0" * 64
        return man, m

    def foreign_geometry(man, m):
        g = sorted(k for k in m if k.startswith("geometry/"))
        doc = json.loads(m[g[0]])
        doc["legs"]["1>2"] = [[0, 0], [1, 1]]                 # a leg the instance never uses
        m[g[0]] = canonical(doc)
        man["files"][g[0]] = sha256_bytes(m[g[0]])
        return man, m

    def code_member(man, m):
        m["geometry/x.py"] = b"import os"
        man["files"]["geometry/x.py"] = sha256_bytes(m["geometry/x.py"])
        return man, m
    for fn in (bad_fp, foreign_geometry, code_member):
        with pytest.raises(IntegrityError):
            w.import_bundle(_rewrite(data, fn))
    assert w.list() == []


def test_format_1_bundles_still_import(tmp_path):
    w = Installation(tmp_path / "i").workspace("researcher1", "R1")

    def to_v1(man, m):
        keep = ("format", "created_at", "exported_by", "exporter_installation", "root_campaign_id", "spec",
                "validator_version", "synthetic", "campaigns", "instances", "methods", "environment_requirements")
        m = {k: v for k, v in m.items() if not k.startswith("geometry/")}
        v1 = {k: man[k] for k in keep}
        v1["format"] = FORMAT_V1
        v1["campaigns"] = [{k: c[k] for k in ("campaign_id", "kind", "checksum", "owner_display")} for c in man["campaigns"]]
        v1["files"] = {k: v for k, v in man["files"].items() if not k.startswith("geometry/")}
        return v1, m
    rep = w.import_bundle(_rewrite(demo.bundle_bytes(), to_v1))
    assert rep["format"] == FORMAT_V1 and rep["fingerprints"] is None and len(w.list()) == 2

    def v1_with_geometry(man, m):
        man, m = to_v1(man, m)
        g = next(k for k in demo.manifest()["files"] if k.startswith("geometry/"))
        m[g] = (demo.ROOT / g).read_bytes()
        man["files"][g] = sha256_bytes(m[g])
        return man, m
    with pytest.raises(IntegrityError):                               # format 1 has no geometry members
        Installation(tmp_path / "j").workspace("r", "R").import_bundle(_rewrite(demo.bundle_bytes(), v1_with_geometry))


def test_lab_api_demo_preferences_and_isolation(tmp_path):
    c = make_client(tmp_path, "lab")
    login(c, "alice")
    st = c.get("/api/lab/state").json()
    assert st["demo"] == dict(available=True, installed=False, campaigns=[])
    r = c.post("/api/lab/demo").json()
    assert len(r["campaigns"]) == 2
    assert c.post("/api/lab/demo").status_code == 200                    # idempotent
    assert len(c.get("/api/campaigns").json()["campaigns"]) == 2
    st = c.get("/api/lab/state").json()
    assert st["demo"]["installed"] and st["preferences"]["last_experiment"] == r["root_campaign_id"]
    exps = c.get("/api/lab/experiments").json()["experiments"]
    assert all(e["demo"] and e["imported"] and e["locked"] for e in exps)
    e = c.get(f"/api/lab/experiments/{r['root_campaign_id']}").json()
    assert e["context"]["area"]["label"] == "Paris" and e["context"]["dataset"].startswith("RPC open data")
    assert e["comparability"]["quality"] == "direct"                    # non-binding variant: same problem
    rows = e["results"]["rows"]
    assert {x["method_id"] for x in rows} == {"exact-matching-highs", "greedy-min-detour"}
    exact = next(x for x in rows if x["method_id"] == "exact-matching-highs")
    assert exact["proven_optimal"] == 3 and {d["id"] for d in exact["descriptive"]} == {"service_rate", "mean_detour_s"}
    # replay works without the road network: geometry imported with the bundle
    run = e["runs"][0]
    pb = c.get(f"/api/geo/playback/{r['root_campaign_id']}/{run['run_id']}").json()
    assert pb["geometry"] == "road"
    assert c.put("/api/lab/preferences", json=dict(tour_dismissed=True)).json()["preferences"]["tour_dismissed"]
    assert c.put("/api/lab/preferences", json=dict(last_experiment="../x")).status_code == 400
    c.post("/api/auth/logout")
    login(c, "bob")                                                     # other researcher: nothing of alice's
    st = c.get("/api/lab/state").json()
    assert not st["demo"]["installed"] and not st["preferences"]["tour_dismissed"]
    assert c.get(f"/api/lab/experiments/{r['root_campaign_id']}").status_code == 404


def test_tile_configuration(monkeypatch):
    monkeypatch.setenv("MOVE_OPENLAB_TILE_URL", "none")
    s = Settings.from_env()
    assert s.tile_url == "" and "tile" not in csp_for(s.tile_url)
    monkeypatch.setenv("MOVE_OPENLAB_TILE_URL", "https://tiles.example.org/{z}/{x}/{y}.png")
    s = Settings.from_env()
    assert s.tile_url.startswith("https://tiles.example.org/") and "https://tiles.example.org" in csp_for(s.tile_url)
    monkeypatch.delenv("MOVE_OPENLAB_TILE_URL")
    assert Settings.from_env().tile_url.startswith("https://tile.openstreetmap.org/")


def test_lab_summary_of_a_reproduction_covers_its_scope(tmp_path):
    from test_api import wait
    c = make_client(tmp_path, "lab2")
    login(c, "alice")
    root = c.post("/api/lab/demo").json()["root_campaign_id"]
    r = c.post(f"/api/campaigns/{root}/reproduce").json()
    wait(c, c.post(f"/api/campaigns/{r['campaign_id']}/execute").json())
    e = c.get(f"/api/lab/experiments/{r['campaign_id']}").json()
    assert e["reproduction"]["reproduced"] and e["campaign"]["parent"]["relation"] == "reproduces"
    assert {x["campaign_id"] for x in e["runs"]} == {root, r["campaign_id"]}          # parent rows can be replayed
    assert {x["campaign_kind"] for x in e["results"]["rows"]} == {"variant", "reproduction"}
    assert e["comparability"]["quality"] == "direct"
