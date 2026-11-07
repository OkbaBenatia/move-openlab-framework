"""HTTP API: authentication, per-user workspaces, the full experiment workflow over HTTP, uploads."""
import time

import pytest
from fastapi.testclient import TestClient

from move_openlab.api import create_app
from move_openlab.auth import Auth
from move_openlab.auth.store import UserStore
from move_openlab.settings import Settings

PID = "synthetic-capacitated-bipartite-assignment"
PW = {"alice": "alice-password-123", "bob": "bob-password-12345"}


def make_settings(tmp_path, name, plugin_dir=None, production=False, secret="s" * 40, plugin_mode="disabled"):
    return Settings(data_dir=tmp_path / name, plugin_dir=plugin_dir, installation_id=f"inst-{name}", auth_db=None,
                    production=production, session_secret=secret, session_ttl_s=3600, cookie_secure=False,
                    frontend_dist=tmp_path / "no-dist", plugin_mode=plugin_mode)


def make_client(tmp_path, name, plugin_dir=None, plugin_mode="disabled"):
    s = make_settings(tmp_path, name, plugin_dir, plugin_mode=plugin_mode)
    auth = Auth(s, UserStore(None))
    for u in PW:
        auth.create_user(u, u.title(), password=PW[u])
        auth.store.set_password(u, __import__("move_openlab.auth", fromlist=["hash_password"]).hash_password(PW[u]), must_change=False)
    return TestClient(create_app(s, auth))


def login(c, user):
    r = c.post("/api/auth/login", json=dict(username=user, password=PW[user]))
    assert r.status_code == 200, r.text
    return r


def wait(c, job):
    for _ in range(600):
        j = c.get(f"/api/jobs/{job['job_id']}").json()
        if j["state"] != "running":
            assert j["state"] == "done", j
            return j
        time.sleep(0.1)
    raise AssertionError("job did not finish")


def test_everything_requires_sign_in(tmp_path):
    c = make_client(tmp_path, "a")
    assert c.get("/api/health").status_code == 200
    for path in ("/api/info", "/api/problems", "/api/campaigns", "/api/auth/me"):
        assert c.get(path).status_code == 401
    assert c.get("/", follow_redirects=False).headers["location"].startswith("/login")
    assert c.post("/api/auth/login", json=dict(username="alice", password="wrong")).status_code == 401
    login(c, "alice")
    me = c.get("/api/auth/me").json()["user"]
    assert me["username"] == "alice"
    assert c.get("/api/auth/me").headers["x-frame-options"] == "DENY"
    c.post("/api/auth/logout")
    assert c.get("/api/campaigns").status_code == 401


def test_forced_password_change_and_session_rotation(tmp_path):
    s = make_settings(tmp_path, "a")
    auth = Auth(s, UserStore(None))
    _, temp = auth.create_user("carol", "Carol")
    c = TestClient(create_app(s, auth))
    r = c.post("/api/auth/login", json=dict(username="carol", password=temp))
    assert r.json()["must_change_password"] is True
    assert c.get("/api/campaigns").json()["code"] == "password_change_required"
    old = c.cookies.get("move_openlab_session")
    bad = c.post("/api/auth/change-password", json=dict(current_password=temp, new_password="short", confirm_password="short"))
    assert bad.status_code == 400
    ok = c.post("/api/auth/change-password", json=dict(current_password=temp, new_password="a-much-better-password",
                                                       confirm_password="a-much-better-password"))
    assert ok.status_code == 200 and c.get("/api/campaigns").status_code == 200
    assert auth.read(old) is None                                                  # older sessions invalidated


def test_throttling_and_cross_origin(tmp_path):
    c = make_client(tmp_path, "a")
    for _ in range(10):
        c.post("/api/auth/login", json=dict(username="bob", password="nope"))
    assert c.post("/api/auth/login", json=dict(username="bob", password=PW["bob"])).status_code == 429
    c = make_client(tmp_path, "b")                       # the client address is throttled too: use a fresh app
    login(c, "alice")
    r = c.post("/api/campaigns", json={}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_production_requires_secret(tmp_path):
    with pytest.raises(RuntimeError):
        create_app(make_settings(tmp_path, "p", production=True, secret=""), Auth(make_settings(tmp_path, "p", secret="s" * 40), UserStore(None)))


def test_workflow_over_http(tmp_path, plugin_dir):
    from conftest import sandbox_or_skip
    sandbox_or_skip(tmp_path)
    a, b = make_client(tmp_path, "A", plugin_dir, "sandbox"), make_client(tmp_path, "B", plugin_dir, "sandbox")
    login(a, "alice"); login(b, "bob")
    probs = {p["spec"]["problem_id"]: p for p in a.get("/api/problems").json()["problems"]}
    assert probs[PID]["synthetic"] is True and probs["public-ride-matching"]["synthetic"] is False
    body = dict(problem_id=PID, title="HTTP baseline", scenario_params=dict(sizes=["small"], seeds=[1, 2]),
                methods=[["exact-milp-highs", "1.0.0"], ["greedy-min-cost", "1.0.0"]], repetitions=1)
    assert a.post("/api/campaigns", json=dict(body, scenario_params=dict(sizes=["huge"]))).status_code == 400
    cid = a.post("/api/campaigns", json=body).json()["campaign_id"]
    wait(a, a.post(f"/api/campaigns/{cid}/execute").json())
    assert a.post(f"/api/campaigns/{cid}/lock").status_code == 200
    assert a.post(f"/api/campaigns/{cid}/execute").status_code == 409
    exp = a.get(f"/api/campaigns/{cid}/export")
    assert exp.headers["content-type"] == "application/zip" and len(exp.headers["x-bundle-sha256"]) == 64
    assert b.get(f"/api/campaigns/{cid}").status_code == 404                          # other installation / user
    rep = b.post("/api/import", files=dict(file=("bundle.zip", exp.content, "application/zip"))).json()
    assert rep["ok"] and rep["root_campaign_id"] == cid
    assert b.post("/api/import", files=dict(file=("x.zip", b"garbage", "application/zip"))).status_code == 422
    rid = b.post(f"/api/campaigns/{cid}/reproduce").json()["campaign_id"]
    wait(b, b.post(f"/api/campaigns/{rid}/execute").json())
    assert b.get(f"/api/campaigns/{rid}/reproducibility").json()["numerically_reproduced"] is True
    b.post(f"/api/campaigns/{rid}/lock")
    m = b.get(f"/api/problems/{PID}/methods").json()
    assert m["plugins_enabled"] and m["plugin_status"]["isolation"] == "sandbox" and all(m["isolation_checks"].values())
    assert any(p["plugin"] == "regret_greedy" and p["compatible"] for p in m["plugins"])
    assert b.post(f"/api/problems/{PID}/methods/register", json=dict(plugin="incompatible")).status_code == 422
    assert b.post(f"/api/problems/{PID}/methods/register", json=dict(plugin="regret_greedy")).status_code == 200
    eid = b.post(f"/api/campaigns/{rid}/extend", json=dict(methods=[["regret-greedy", "1.0.0"]])).json()["campaign_id"]
    wait(b, b.post(f"/api/campaigns/{eid}/execute").json())
    b.post(f"/api/campaigns/{eid}/lock")
    cmp = b.get(f"/api/campaigns/{eid}/compare").json()
    assert len(cmp["rows"]) == 5 and cmp["reference"]["method_id"] == "exact-milp-highs"
    assert b.get(f"/api/campaigns/{eid}/report.md").text.startswith("# Method comparison")
    assert "regret-greedy" in b.get(f"/api/campaigns/{eid}/report.csv").text
    vid = b.post(f"/api/campaigns/{cid}/variant", json=dict(variant="capacity-binding")).json()["campaign_id"]
    wait(b, b.post(f"/api/campaigns/{vid}/execute").json())
    sem = b.get("/api/semantic-compare", params=dict(reference=cid, candidate=vid)).json()
    assert sem["summary"]["quality"]["INCOMPATIBLE"] > 0
    tid = b.post(f"/api/campaigns/{cid}/threshold-study", json=dict(method=["greedy-min-cost", "1.0.0"],
                                                                    scorer="relative-cost", thresholds=[0.5, 1.0])).json()["campaign_id"]
    wait(b, b.post(f"/api/campaigns/{tid}/execute").json())
    assert len(b.get(f"/api/campaigns/{tid}/threshold-report").json()["summary"]) == 2
    assert b.get("/api/integrations").json() == {"sources": []}
