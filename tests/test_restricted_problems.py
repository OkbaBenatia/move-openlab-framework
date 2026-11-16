"""Restricted problems: visible only to the accounts an administrator granted them to. Enforcement is on the server
(listings, lookups, experiments, scenarios, instances, exports, imports); no role implies access; refusals are audited.
The open, shipped synthetic problem is marked restricted for the duration of a test: no private package is needed."""
import json

import pytest
from fastapi.testclient import TestClient

from move_openlab import registry
from move_openlab.access import Access
from test_admin import admin_client
from test_api import PID, login, wait

ROOT_PW = "Operator-Key-2026-xyz"
BODY = dict(problem_id=PID, title="restricted study", scenario_params=dict(sizes=["small"], seeds=[1]),
            methods=[["exact-milp-highs", "1.0.0"]], repetitions=1)


@pytest.fixture
def restricted(monkeypatch):
    monkeypatch.setattr(registry.get(PID), "restricted", True, raising=False)


def clients(tmp_path):
    root, _auth, s = admin_client(tmp_path)
    assert root.post("/api/auth/login", json=dict(username="root", password=ROOT_PW)).status_code == 200
    alice, bob = TestClient(root.app), TestClient(root.app)
    login(alice, "alice"), login(bob, "bob")
    return root, alice, bob, s


def test_open_problems_need_no_grant(tmp_path):
    root, alice, _bob, _s = clients(tmp_path)
    assert PID in [p["spec"]["problem_id"] for p in alice.get("/api/problems").json()["problems"]]
    ext = root.get("/api/admin/extensions").json()
    row = next(p for p in ext["problems"] if p["problem_id"] == PID)
    assert row["restricted"] is False and row["granted"] is None and row["distribution"]
    assert root.put(f"/api/admin/extensions/{PID}/access", json=dict(usernames=["alice"])).status_code == 400
    assert alice.get("/api/admin/extensions").status_code == 403


def test_a_restricted_problem_is_invisible_without_a_grant(tmp_path, restricted):
    root, alice, _bob, s = clients(tmp_path)
    for c in (alice, root):                                  # the administrator role implies nothing
        assert PID not in [p["spec"]["problem_id"] for p in c.get("/api/problems").json()["problems"]]
        assert PID not in [p["problem_id"] for p in c.get("/api/info").json()["problems"]]
        assert c.get(f"/api/problems/{PID}").status_code == 404
        assert c.get(f"/api/problems/{PID}/methods").status_code == 404
        assert c.get("/api/lab/metrics", params=dict(problem_id=PID)).status_code == 404
        assert c.post("/api/campaigns", json=BODY).status_code == 404
        r = c.post("/api/campaigns/import-results", json=dict(problem_id=PID, title="imported", instance_hashes=["0" * 64],
                                                              methods=[["exact-milp-highs", "1.0.0"]], records=[{}], source=dict(name="x")))
        assert r.status_code == 404
    # same answer as for a problem that is not installed at all
    assert alice.get(f"/api/problems/{PID}").json()["detail"].endswith("is not installed here")
    assert alice.get("/api/problems/no-such-problem").json()["detail"].endswith("is not installed here")
    # the registry identifies the package to the administrator, without describing it
    row = next(p for p in root.get("/api/admin/extensions").json()["problems"] if p["problem_id"] == PID)
    assert row["restricted"] is True and row["granted"] == [] and "metrics" not in row and "methods" not in row
    log = [json.loads(x) for x in (s.data_dir / "audit.log").read_text().splitlines()]
    assert any(e["action"] == "refused_restricted_problem" and e["actor"] == "alice" and e["target"] == PID for e in log)


def test_grant_use_and_revocation(tmp_path, restricted):
    root, alice, bob, s = clients(tmp_path)
    assert root.put(f"/api/admin/extensions/{PID}/access", json=dict(usernames=["nobody-here"])).status_code == 404
    assert root.put(f"/api/admin/extensions/{PID}/access", json=dict(usernames=["alice"])).json()["granted"] == ["alice"]
    assert Access(s.data_dir).file.stat().st_mode & 0o077 == 0                       # owner-only
    assert PID in [p["spec"]["problem_id"] for p in alice.get("/api/problems").json()["problems"]]
    assert alice.get("/api/info").json()["problems"][0].keys() >= {"restricted"}
    cid = alice.post("/api/campaigns", json=BODY).json()["campaign_id"]
    wait(alice, alice.post(f"/api/campaigns/{cid}/execute").json())
    assert alice.post(f"/api/campaigns/{cid}/lock").status_code == 200
    h = alice.get(f"/api/campaigns/{cid}").json()["campaign"]["scenario_set"]["instance_hashes"][0]
    assert alice.get(f"/api/geo/instances/{h}").status_code == 200
    bundle = alice.get(f"/api/campaigns/{cid}/export")
    assert bundle.status_code == 200
    # another account: the experiment, its scenario and its bundle are out of reach (also for the administrator)
    for c in (bob, root):
        assert c.get(f"/api/campaigns/{cid}").status_code == 404
        assert c.get(f"/api/lab/experiments/{cid}").status_code == 404
        assert c.get(f"/api/campaigns/{cid}/export").status_code == 404
        assert c.get(f"/api/geo/instances/{h}").status_code == 404
        r = c.post("/api/import", files=dict(file=("bundle.zip", bundle.content, "application/zip")))
        assert r.status_code == 422 and "is not installed here" in r.json()["detail"]
        assert c.get("/api/campaigns").json()["campaigns"] == []
    # revocation: the records stay on disk, the account no longer reaches them
    assert root.put(f"/api/admin/extensions/{PID}/access", json=dict(usernames=[])).json()["granted"] == []
    assert alice.get("/api/campaigns").json()["campaigns"] == []
    assert alice.get(f"/api/campaigns/{cid}").status_code == 404
    assert alice.get(f"/api/lab/experiments/{cid}").status_code == 404
    assert alice.get(f"/api/campaigns/{cid}/export").status_code == 404
    assert alice.get(f"/api/geo/instances/{h}").status_code == 404
    assert alice.get("/api/lab/experiments").json()["experiments"] == []
    assert (s.data_dir / "workspaces" / "alice" / "campaigns" / cid / "campaign.json").exists()
    log = [json.loads(x) for x in (s.data_dir / "audit.log").read_text().splitlines()]
    assert [e["target"] for e in log if e["action"] == "set_problem_access"] == [f"{PID}: alice", f"{PID}: (nobody)"]


PUBLIC = {"X-Move-Context": "public"}


def test_the_public_context_leaves_granted_restricted_records_out(tmp_path, restricted):
    """A granted account working in the public Workspace (requests marked ``X-Move-Context: public``) gets exactly what
    an account without the grant gets; nothing is deleted, nothing is audited as a refusal, and the header never widens
    access for an account that has no grant."""
    root, alice, bob, s = clients(tmp_path)
    assert root.put(f"/api/admin/extensions/{PID}/access", json=dict(usernames=["alice"])).status_code == 200
    cid = alice.post("/api/campaigns", json=BODY).json()["campaign_id"]
    job = alice.post(f"/api/campaigns/{cid}/execute").json()
    wait(alice, job)
    h = alice.get(f"/api/campaigns/{cid}").json()["campaign"]["scenario_set"]["instance_hashes"][0]
    # research context (no header): everything is there
    assert [c["campaign_id"] for c in alice.get("/api/campaigns").json()["campaigns"]] == [cid]
    assert any(j["job_id"] == job["job_id"] for j in alice.get("/api/jobs").json()["jobs"])
    # public context: the same account sees no restricted problem and none of its records
    for path in ("/api/problems", "/api/info"):
        body = alice.get(path, headers=PUBLIC).json()["problems"]
        assert PID not in [p.get("problem_id") or p["spec"]["problem_id"] for p in body]
    assert alice.get("/api/campaigns", headers=PUBLIC).json()["campaigns"] == []
    assert alice.get("/api/lab/experiments", headers=PUBLIC).json()["experiments"] == []
    for path in (f"/api/campaigns/{cid}", f"/api/lab/experiments/{cid}", f"/api/campaigns/{cid}/export", f"/api/geo/instances/{h}",
                 f"/api/problems/{PID}", f"/api/jobs/{job['job_id']}"):
        assert alice.get(path, headers=PUBLIC).status_code == 404, path
    assert alice.get("/api/jobs", headers=PUBLIC).json()["jobs"] == []
    assert alice.post("/api/campaigns", json=BODY, headers=PUBLIC).status_code == 404
    log = [json.loads(x) for x in (s.data_dir / "audit.log").read_text().splitlines()]
    assert not any(e["action"] == "refused_restricted_problem" and e["actor"] == "alice" for e in log)
    # the record is untouched, and still there without the header
    assert alice.get(f"/api/campaigns/{cid}").status_code == 200
    # the header only narrows: any value gives an account without the grant nothing more
    for hdr in ({"X-Move-Context": "research"}, {"X-Move-Context": "all"}, {}):
        assert bob.get(f"/api/campaigns/{cid}", headers=hdr).status_code == 404
        assert PID not in [p["spec"]["problem_id"] for p in bob.get("/api/problems", headers=hdr).json()["problems"]]
