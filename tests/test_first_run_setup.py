"""First-run setup: the first administrator is created in the browser, with a setup key only the installing account can
read, from this computer only, once; an installation that already has accounts never enters setup mode."""
import json
import threading

from fastapi.testclient import TestClient

from move_openlab.api import create_app
from move_openlab.auth import Auth
from move_openlab.auth import setup as SETUP
from move_openlab.auth.store import UserStore

from test_api import PW, login, make_client, make_settings

LOCAL = ("127.0.0.1", 50000)
GOOD = dict(username="ada", display_name="Ada Lovelace", new_password="Analytical-Engine-1843!", confirm_password="Analytical-Engine-1843!")


def fresh(tmp_path, name="fresh", persistent=False, client=LOCAL):
    s = make_settings(tmp_path, name)
    if persistent:
        from dataclasses import replace
        s = replace(s, auth_db=s.data_dir / "auth.sqlite3")
    auth = Auth(s, UserStore(s.auth_db))
    return TestClient(create_app(s, auth), client=client), s


def key(s) -> str:
    return SETUP.read_key(s.data_dir)


def test_a_fresh_installation_opens_the_setup_page_and_nothing_else(tmp_path):
    c, s = fresh(tmp_path)
    assert c.get("/api/setup/status").json() == {"setup_required": True}
    for page in ("/", "/login", "/#/workspace", "/lab"):
        r = c.get(page, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/setup", page
    api = c.get("/api/lab/state")
    assert api.status_code == 401 and api.json()["code"] == "setup_required"
    page = c.get("/setup")
    assert page.status_code == 200 and "Welcome to MOVE OpenLab" in page.text and "Create administrator" in page.text
    assert page.headers["cache-control"] == "no-store"
    k = key(s)
    assert k and len(k) >= 32 and k not in page.text                  # the key is never served by the server
    assert oct((s.data_dir / "setup-key").stat().st_mode & 0o777) == "0o600"


def test_the_first_administrator_needs_the_key_this_computer_and_a_strong_password(tmp_path):
    c, s = fresh(tmp_path)
    post = lambda **kw: c.post("/api/setup/admin", json={**GOOD, "setup_key": key(s), **kw})   # noqa: E731
    assert c.post("/api/setup/admin", json=GOOD).status_code == 403                             # no key
    assert post(setup_key="x" * 43).status_code == 403                                           # wrong key
    assert post(confirm_password="Analytical-Engine-1844!").status_code == 400                  # not confirmed
    weak = post(new_password="short", confirm_password="short")
    assert weak.status_code == 400 and weak.json()["detail"].startswith("password:")
    assert post(username="Not Valid!").status_code == 400
    remote = TestClient(c.app, client=("192.168.1.20", 40000))
    assert remote.post("/api/setup/admin", json=dict(GOOD, setup_key=key(s))).status_code == 403  # another computer
    assert c.get("/api/setup/status").json()["setup_required"]                                   # nothing created
    ok = post()
    assert ok.status_code == 200 and ok.json()["user"] == dict(username="ada", display="Ada Lovelace", role="admin")
    me = c.get("/api/auth/me").json()["user"]                                                    # signed in, no forced change
    assert me["username"] == "ada" and me["role"] == "admin" and not me["must_change_password"]
    assert c.get("/api/lab/state").status_code == 200                                            # enters the Workspace
    # setup mode is over for good: no key file, the endpoints refuse, the page sends to sign-in
    assert not (s.data_dir / "setup-key").exists()
    assert post(setup_key="anything", username="eve").status_code == 404
    assert c.get("/setup", follow_redirects=False).headers["location"] == "/login"
    assert c.post("/api/setup/password-policy", json={"password": "x"}).status_code == 404
    c.post("/api/auth/logout")
    assert c.post("/api/auth/login", json=dict(username="ada", password=GOOD["new_password"])).status_code == 200
    log = [json.loads(x) for x in (s.data_dir / "audit.log").read_text().splitlines()]
    assert [(e["action"], e["target"]) for e in log] == [("first_run_setup", "ada")]
    assert GOOD["new_password"] not in (s.data_dir / "audit.log").read_text()


def test_concurrent_first_run_requests_create_exactly_one_administrator(tmp_path):
    c, s = fresh(tmp_path, persistent=True)
    k, codes = key(s), []

    def go(i):
        r = TestClient(c.app, client=LOCAL).post("/api/setup/admin", json=dict(GOOD, username=f"admin{i}", setup_key=k))
        codes.append(r.status_code)
    threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes).count(200) == 1 and all(x in (200, 403, 404) for x in codes)
    users = UserStore(s.auth_db).list()
    assert len(users) == 1 and users[0].role == "admin"


def test_restarting_during_setup_keeps_the_key_and_existing_accounts_never_see_setup(tmp_path):
    c, s = fresh(tmp_path, persistent=True)
    k = key(s)
    c2 = TestClient(create_app(s, Auth(s, UserStore(s.auth_db))), client=LOCAL)                 # restart before setup
    assert key(s) == k and c2.get("/setup").status_code == 200
    assert c2.post("/api/setup/admin", json=dict(GOOD, setup_key=k)).status_code == 200
    c3 = TestClient(create_app(s, Auth(s, UserStore(s.auth_db))), client=LOCAL)                 # restart after setup
    assert not (s.data_dir / "setup-key").exists() and not c3.get("/api/setup/status").json()["setup_required"]
    # an installation with accounts (created by the CLI or an earlier version) is never in setup mode
    e = make_client(tmp_path, "existing")
    assert not (tmp_path / "existing" / "setup-key").exists()
    assert e.get("/login").status_code == 200 and e.get("/setup", follow_redirects=False).status_code == 303
    assert e.post("/api/setup/admin", json=dict(GOOD, setup_key="x" * 43)).status_code == 404
    login(e, "alice")
    assert e.get("/api/auth/me").json()["user"]["username"] == "alice" and PW


def test_the_new_administrator_is_an_ordinary_public_administrator(tmp_path):
    c, s = fresh(tmp_path)
    assert c.post("/api/setup/admin", json=dict(GOOD, setup_key=key(s))).status_code == 200
    probs = c.get("/api/problems").json()["problems"]
    assert all(not p.get("restricted") for p in probs)                    # no private research problem
    assert c.get("/api/lab/state").json()["demo"]["available"]           # the public demonstration is there
    users = c.get("/api/admin/users").json()["users"]
    assert [u["username"] for u in users] == ["ada"]                      # can manage accounts as any administrator
