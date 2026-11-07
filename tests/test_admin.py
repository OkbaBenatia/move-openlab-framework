"""Account administration: admin-only access, one-time temporary passwords, deactivation guards, audit log,
workspace isolation preserved for administrators."""
import json

from fastapi.testclient import TestClient

from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from test_api import PW, login, make_settings


def admin_client(tmp_path):
    s = make_settings(tmp_path, "adm")
    auth = Auth(s, UserStore(None))
    for u, role in (("alice", "researcher"), ("bob", "researcher"), ("root", "admin")):
        auth.create_user(u, u.title(), role=role, password=PW.get(u, "root-password-123"))
        auth.store.set_password(u, hash_password(PW.get(u, "root-password-123")), must_change=False)
    return TestClient(create_app(s, auth)), auth, s


def test_admin_routes_require_the_admin_role(tmp_path):
    c, _, _ = admin_client(tmp_path)
    login(c, "alice")
    assert c.get("/api/admin/users").status_code == 403
    assert c.post("/api/admin/users", json=dict(username="eve", display_name="Eve")).status_code == 403


def test_admin_lifecycle_and_audit(tmp_path):
    c, auth, s = admin_client(tmp_path)
    r = c.post("/api/auth/login", json=dict(username="root", password="root-password-123")); assert r.status_code == 200
    users = c.get("/api/admin/users").json()["users"]
    assert {u["username"] for u in users} == {"alice", "bob", "root"} and all("scrypt" not in json.dumps(u) and "password_hash" not in u for u in users)
    r = c.post("/api/admin/users", json=dict(username="carol", display_name="Carol"))
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    temp = r.json()["temporary_password"]
    assert auth.store.get("carol").must_change_password and len(temp) >= 16
    carol = TestClient(c.app)
    assert carol.post("/api/auth/login", json=dict(username="carol", password=temp)).json()["must_change_password"]
    # reset invalidates the old temporary password
    temp2 = c.post("/api/admin/users/carol/reset-password").json()["temporary_password"]
    assert carol.post("/api/auth/login", json=dict(username="carol", password=temp)).status_code == 401
    assert carol.post("/api/auth/login", json=dict(username="carol", password=temp2)).status_code == 200
    # deactivation ends sessions and blocks sign-in; guards against self/last admin
    bob = TestClient(c.app); login(bob, "bob")
    assert c.post("/api/admin/users/bob/deactivate").json()["user"]["active"] is False
    assert bob.get("/api/campaigns").status_code == 401
    assert bob.post("/api/auth/login", json=dict(username="bob", password=PW["bob"])).status_code == 401
    assert c.post("/api/admin/users/bob/reactivate").json()["user"]["active"] is True
    assert c.post("/api/admin/users/root/deactivate").status_code == 409
    assert c.post("/api/admin/users/nobody/reset-password").status_code == 404
    # self-reset is refused: it would end the session before the one-time password is shown
    assert c.post("/api/admin/users/root/reset-password").status_code == 409
    assert c.get("/api/admin/users").status_code == 200
    log = [json.loads(l) for l in (s.data_dir / "audit.log").read_text().splitlines()]
    assert [e["action"] for e in log] == ["create_user", "reset_password", "deactivate", "reactivate"]
    assert temp not in (s.data_dir / "audit.log").read_text()


def test_administrators_do_not_see_other_workspaces(tmp_path):
    c, _, _ = admin_client(tmp_path)
    alice = TestClient(c.app); login(alice, "alice")
    cid = alice.post("/api/campaigns", json=dict(problem_id="synthetic-capacitated-bipartite-assignment", title="private",
                                                  scenario_params=dict(sizes=["small"], seeds=[1]),
                                                  methods=[["greedy-min-cost", "1.0.0"]], repetitions=1)).json()["campaign_id"]
    c.post("/api/auth/login", json=dict(username="root", password="root-password-123"))
    assert c.get(f"/api/campaigns/{cid}").status_code == 404
    assert next(u for u in c.get("/api/admin/users").json()["users"] if u["username"] == "alice")["campaigns"] == 1


def test_operator_cli_reset_password(tmp_path, monkeypatch, capsys):
    """Host-side recovery for a locked-out account: new temporary password printed once, old one rejected."""
    from move_openlab import cli
    monkeypatch.setenv("MOVE_OPENLAB_DATA_DIR", str(tmp_path / "data"))
    assert cli.main(["users", "add", "ops", "--role", "admin"]) == 0
    first = capsys.readouterr().out.strip().splitlines()[-1]
    assert cli.main(["users", "reset-password", "ops"]) == 0
    temp = capsys.readouterr().out.strip()
    assert len(temp) >= 16 and temp != first
    s = __import__("move_openlab.settings", fromlist=["Settings"]).Settings.from_env()
    auth = Auth(s)
    assert auth.store.get("ops").must_change_password
    assert auth.authenticate("ops", temp)[0] is not None and auth.authenticate("ops", first)[0] is None
    assert cli.main(["users", "reset-password", "nobody"]) == 2
