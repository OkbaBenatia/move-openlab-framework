"""Researcher A → researcher B, over HTTP, with the public sample scenario: A imports the scenario package, runs both
built-in methods, every run is independently validated, A locks and exports one bundle. B — another account of another
installation — imports it: integrity verified, every run re-validated, the records marked imported (never executed
there); B re-executes them, gets the reproduction verdict, and compares with full provenance. Nothing private is
needed or exported."""
import io
import json
import zipfile

from fastapi.testclient import TestClient

from move_openlab import samples
from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.hashing import sha256_bytes
from test_api import make_settings, wait

RIDE = "public-ride-matching"
METHODS = [["exact-matching-highs", "1.0.0"], ["greedy-min-detour", "1.0.0"]]
PW = "Correct-Horse-Battery-9!"


def researcher(tmp, inst: str, user: str) -> TestClient:
    s = make_settings(tmp, inst)
    auth = Auth(s, UserStore(None))
    auth.create_user(user, user.replace("_", " ").title(), role="researcher", password=PW)
    auth.store.set_password(user, hash_password(PW), must_change=False)
    c = TestClient(create_app(s, auth))
    assert c.post("/api/auth/login", json=dict(username=user, password=PW)).status_code == 200
    return c


def test_researcher_a_to_researcher_b_through_the_public_samples(tmp_path):
    a = researcher(tmp_path, "inst-a", "researcher_a")
    # A: the public scenario package, downloaded from the application, then imported through the normal importer
    pkg = a.get("/api/lab/sample/scenario")
    assert pkg.status_code == 200 and sha256_bytes(pkg.content) == samples.scenario_info()["packed_sha256"]
    rep = a.post("/api/lab/inspect", files=dict(file=("sample_scenario.zip", pkg.content, "application/zip"))).json()
    assert rep["kind"] == "scenario"
    imp = a.post("/api/lab/sample/scenario").json()
    h = imp["scenario"]["instance_hash"]
    assert any(s["instance_hash"] == h for s in a.get("/api/geo/scenarios").json()["scenarios"])
    # A: run both built-in methods on it; every run accepted by the independent validator
    c = a.post("/api/campaigns", json=dict(problem_id=RIDE, title="Sample scenario, researcher A",
                                            scenario_params=dict(instance_hashes=[h]), methods=METHODS, repetitions=2)).json()
    wait(a, a.post(f"/api/campaigns/{c['campaign_id']}/execute").json())
    rec = a.get(f"/api/campaigns/{c['campaign_id']}").json()["campaign"]
    assert len(rec["runs"]) == 4 and all(r["accepted"] for r in rec["runs"])
    checksum = a.post(f"/api/campaigns/{c['campaign_id']}/lock").json()["checksum"]
    bundle = a.get(f"/api/campaigns/{c['campaign_id']}/export", params=dict(evidence="true"))
    assert bundle.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(bundle.content)).namelist()
    assert not any(n.endswith(".py") for n in names)                                    # records only, no code

    # B: another installation, another account
    b = researcher(tmp_path, "inst-b", "researcher_b")
    got = b.post("/api/import", files=dict(file=("from_a.zip", bundle.content, "application/zip"))).json()
    assert got["bundle_sha256"] == bundle.headers["X-Bundle-SHA256"]
    assert got["revalidation"]["runs"] == got["revalidation"]["confirmed"] == 4         # re-validated here
    assert got["campaigns_verified"][0]["checksum"] == checksum
    cid = c["campaign_id"]
    e = b.get(f"/api/lab/experiments/{cid}").json()
    assert e["campaign"]["imported"] is True and e["campaign"]["locked"] is True
    assert e["campaign"]["owner_display"] == "Researcher A"                              # provenance kept
    # B re-executes A's records on B's own installation
    r = b.post(f"/api/campaigns/{cid}/reproduce").json()
    wait(b, b.post(f"/api/campaigns/{r['campaign_id']}/execute").json())
    rr = b.get(f"/api/campaigns/{r['campaign_id']}/reproducibility").json()
    assert rr["numerically_reproduced"] is True and rr["agreement"]["different"] == 0 and rr["cells"] == 2
    cmp = b.get(f"/api/campaigns/{r['campaign_id']}/compare").json()
    assert [x["kind"] for x in cmp["lineage"]] == ["reproduction", "baseline"]
    assert {x["reproduction_status"] for x in cmp["rows"] if x["campaign_kind"] == "reproduction"} == {"REPRODUCED"}
    # B's re-execution is B's: executed here, not imported; A's records stay marked imported
    mine = b.get(f"/api/lab/experiments/{r['campaign_id']}").json()
    assert mine["campaign"]["imported"] is False and mine["campaign"]["owner_display"] == "Researcher B"
    # isolation: A's installation knows nothing of B, and B's export carries no account data of A beyond provenance
    assert a.get(f"/api/campaigns/{r['campaign_id']}").status_code == 404
    man = json.loads(zipfile.ZipFile(io.BytesIO(bundle.content)).read("manifest.json"))
    assert man["exported_by"] == "Researcher A" and "password" not in json.dumps(man).lower()
