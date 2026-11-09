"""Account roles and supervision, the password policy, geocoder providers, comparison candidates, version label."""
import json

import pytest
from fastapi.testclient import TestClient

from move_openlab import version
from move_openlab.auth import Auth, hash_password, password_policy
from move_openlab.auth.store import UserStore
from move_openlab.api import create_app
from move_openlab.geo.geocode import Geocoder
from move_openlab.geo.osm import SourceUnavailable
from test_api import PW, login, make_settings


# ---------------------------------------------------------------- password policy
def test_password_policy_levels():
    assert password_policy("short")["level"] == "weak"
    assert password_policy("alllowercaseletters")["level"] == "weak"            # one class only
    assert "username" in " ".join(password_policy("Alice-Rules-2026", "alice")["problems"])
    assert "name" in " ".join(password_policy("Okay-Benattia-99!", "x", "Okba Benattia")["problems"])
    assert password_policy("aaaaaaaaaaaaA1")["level"] == "weak"                  # repeated characters
    ok = password_policy("Staplemountain7")
    assert ok["ok"] and ok["level"] == "acceptable"
    assert password_policy("Correct-Horse-Battery-9!")["level"] == "strong"


# ---------------------------------------------------------------- roles, supervision, migration
def admin_client(tmp_path):
    s = make_settings(tmp_path, "acc")
    auth = Auth(s, UserStore(None))
    for u, role in (("root", "admin"), ("alice", "researcher"), ("bob", "researcher")):
        pw = PW.get(u, "Operator-Key-2026-xyz")
        auth.create_user(u, u.title(), role=role, password=pw)
        auth.store.set_password(u, hash_password(pw), must_change=False)
    c = TestClient(create_app(s, auth))
    return c, auth


def test_roles_supervision_and_isolation(tmp_path):
    c, auth = admin_client(tmp_path)
    c.post("/api/auth/login", json=dict(username="root", password="Operator-Key-2026-xyz"))
    roles = c.get("/api/admin/users").json()
    assert roles["roles"] == ["admin", "researcher", "student"] and roles["role_labels"]["student"] == "Student"
    # a student needs a supervising researcher (or an administrator)
    assert c.post("/api/admin/users", json=dict(username="stu1", display_name="Student One", role="student", supervisor="alice")).status_code == 400
    assert c.put("/api/admin/users/alice/supervision", json=dict(can_supervise=True)).json()["user"]["can_supervise"] is True
    assert c.put("/api/admin/users/stu0/supervision", json=dict(can_supervise=True)).status_code == 404
    r = c.post("/api/admin/users", json=dict(username="stu1", display_name="Student One", role="student", supervisor="alice"))
    assert r.status_code == 200 and r.json()["user"]["supervisor"] == "alice" and r.json()["temporary_password"]
    assert r.headers["cache-control"] == "no-store"
    assert c.post("/api/admin/users", json=dict(username="stu2", display_name="Student Two", role="student", supervisor="bob")).status_code == 400  # bob cannot supervise
    assert c.put("/api/admin/users/alice/supervisor", json=dict(supervisor="root")).status_code == 409        # only students have a supervisor
    audit = c.get("/api/admin/audit").json()["entries"]
    assert [e["action"] for e in audit][:2] == ["create_user", "grant_supervision"]
    # alice (supervisor) manages her own student only
    a = TestClient(c.app); login(a, "alice")
    assert a.get("/api/auth/me").json()["user"]["can_supervise"] is True
    assert [s["username"] for s in a.get("/api/supervision/students").json()["students"]] == ["stu1"]
    r2 = a.post("/api/supervision/students", json=dict(username="stu3", display_name="Student Three"))
    assert r2.status_code == 200 and r2.json()["user"]["supervisor"] == "alice" and r2.json()["user"]["role"] == "student"
    temp = a.post("/api/supervision/students/stu3/reset-password").json()["temporary_password"]
    assert a.post("/api/supervision/students/stu3/deactivate").json()["user"]["active"] is False
    assert a.post("/api/supervision/students/stu3/reactivate").json()["user"]["active"] is True
    assert a.post("/api/supervision/students/bob/reset-password").status_code == 404                        # not her student
    assert a.get("/api/admin/users").status_code == 403                                                       # not an admin
    # bob (no supervision flag) and the student get nothing
    b = TestClient(c.app); login(b, "bob")
    assert b.get("/api/supervision/students").status_code == 403
    st = TestClient(c.app)
    r3 = st.post("/api/auth/login", json=dict(username="stu3", password=temp))
    assert r3.status_code == 200 and r3.json()["must_change_password"] is True
    assert st.post("/api/auth/change-password", json=dict(current_password=temp, new_password="stu3-is-weak-123", confirm_password="stu3-is-weak-123")).status_code == 400
    pol = st.post("/api/auth/password-policy", json=dict(password="Quiet-Harbour-Lamp-42")).json()
    assert pol["ok"] and pol["level"] == "strong"
    assert st.post("/api/auth/change-password", json=dict(current_password=temp, new_password="Quiet-Harbour-Lamp-42", confirm_password="Quiet-Harbour-Lamp-42")).status_code == 200
    assert st.get("/api/supervision/students").status_code == 403 and st.get("/api/admin/users").status_code == 403
    assert st.get("/api/campaigns").json()["campaigns"] == []                                                  # own empty workspace
    # legacy database (schema 1 without the new columns) migrates in place
    db = tmp_path / "legacy.sqlite3"
    import sqlite3
    con = sqlite3.connect(db)
    con.executescript("""CREATE TABLE users (username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'researcher', active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 1,
        session_version INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL, updated_at REAL, password_changed_at REAL,
        last_login_at REAL, created_by TEXT NOT NULL DEFAULT ''); PRAGMA user_version = 1;
        INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('old', 'Old', 'x', 1);""")
    con.commit(); con.close()
    store = UserStore(db)
    u = store.get("old")
    assert u.supervisor is None and u.can_supervise is False
    assert sqlite3.connect(db).execute("PRAGMA user_version").fetchone()[0] == 2


def test_version_label_hides_development_numbers():
    assert version.display_version() == ("Development build" if version.app_version().startswith("0.") else version.app_version())


# ---------------------------------------------------------------- geocoder providers
class _Resp:
    def __init__(self, body: bytes):
        self.body = body

    def read(self, n=-1):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_geocoder_providers(tmp_path):
    calls = []

    def fake(req, timeout=15):
        calls.append(req.full_url)
        if "photon" in req.full_url:
            return _Resp(json.dumps(dict(type="FeatureCollection", features=[dict(type="Feature", geometry=dict(type="Point", coordinates=[6.8, 47.51]),
                                                                                properties=dict(name="Montbéliard", country="France", osm_key="place", osm_value="town",
                                                                                                extent=[6.75, 47.55, 6.85, 47.47]))])).encode())
        return _Resp(json.dumps([dict(display_name="Montbéliard, France", lat="47.51", lon="6.80", boundingbox=["47.47", "47.55", "6.75", "6.85"],
                                      category="place", type="town")]).encode())
    nomi = Geocoder("https://nominatim.invalid/search", tmp_path / "a", opener=fake)
    assert nomi.describe() == dict(enabled=True, provider="nominatim", label="Nominatim", autocomplete=False, min_chars=2,
                                   attribution=nomi.spec["attribution"])
    r = nomi.search("Montbéliard")
    assert r["results"][0]["bbox"] == [47.47, 6.75, 47.55, 6.85] and not r["cached"]
    assert nomi.search("montbeliard ")["cached"] is False and nomi.search("Montbéliard")["cached"] is True
    photon = Geocoder("https://photon.invalid/api", tmp_path / "b", opener=fake, provider="photon")
    assert photon.describe()["autocomplete"] is True and photon.describe()["min_chars"] == 3
    with pytest.raises(ValueError):
        photon.search("Mo")
    p = photon.search("Montb")["results"][0]
    assert p["bbox"] == [47.47, 6.75, 47.55, 6.85] and p["name"].startswith("Montbéliard") and p["kind"] == "place/town"
    assert "limit=8" in calls[-1] and "format=jsonv2" not in calls[-1]
    with pytest.raises(ValueError):
        Geocoder("https://x.invalid", tmp_path, provider="google")
    off = Geocoder("off", tmp_path / "c", provider="photon")
    assert off.describe()["autocomplete"] is False
    with pytest.raises(SourceUnavailable):
        off.search("Montbéliard")


# ---------------------------------------------------------------- comparison candidates
def test_compatible_candidates(tmp_path):
    from geo_fixtures import BBOX, grid_overpass
    from move_openlab.geo.osm import NetworkStore
    from test_mobility import METHODS, profile, wait
    s = make_settings(tmp_path, "cmp")
    auth = Auth(s, UserStore(None))
    for u in ("alice", "bob"):
        auth.create_user(u, u.title(), password=PW[u])
        auth.store.set_password(u, hash_password(PW[u]), must_change=False)
    nid = NetworkStore(s.data_dir).save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")["network_id"]
    c = TestClient(create_app(s, auth)); login(c, "alice")

    def run(title, factor, seed=7):
        basis = dict(source="synthetic", network_id=nid, name=title, n_drivers=4, n_riders=5, seed=seed, start_s=25200, end_s=27000,
                     params=dict(max_detour_s=900, max_detour_ratio=1.5), min_trip_m=300,
                     vehicles=dict(profiles=[profile("petrol", "ICE"), profile("ev", "BEV", electricity_emission_factor_g_per_kwh=factor)],
                                   default="petrol", assignments={"D1": "ev"}))
        sc = c.post("/api/geo/scenarios/preview", json=basis).json()["scenario"]
        r = c.post("/api/lab/run", json=dict(title=title, methods=[list(m) for m in METHODS], repetitions=1, scenario=sc, basis=basis,
                                             emissions=dict(scope="operational-energy", baseline="everyone-drives-alone"))).json()
        wait(c, r["job"])
        return r["campaign_id"]
    a, b, other = run("Experiment A", 50.0), run("Experiment B", 400.0), run("Other scenario", 50.0, seed=8)
    c.post(f"/api/campaigns/{a}/lock")
    rep = c.post(f"/api/campaigns/{a}/reproduce").json()
    wait(c, c.post(f"/api/campaigns/{rep['campaign_id']}/execute").json())
    d = c.get(f"/api/lab/compatible?a={a}").json()
    by = {x["campaign_id"]: x for x in d["candidates"]}
    assert d["a"]["campaign_id"] == a and set(by) == {b, other, rep["campaign_id"]}
    assert by[rep["campaign_id"]]["relation"] == "Reproduction" and by[rep["campaign_id"]]["quality"] == "direct"
    assert by[b]["relation"] == "Same problem, other file" and by[b]["quality"] == "direct" and by[b]["emissions"] == "conditional"
    assert by[b]["overall"] == "direct" and any("vehicle parameters" in r for r in by[b]["reasons"])
    assert by[other]["relation"] == "Different scenario" and by[other]["overall"] == "incompatible"
    assert d["counts"]["incompatible"] == 1 and [x["campaign_id"] for x in d["candidates"]][-1] == other
    assert c.get(f"/api/lab/compatible?a={a}").json() == d                                                     # cached, stable
    draft = c.post("/api/campaigns", json=dict(problem_id="public-ride-matching", title="never run", scenario_params=dict(instance_hashes=[]),
                                               methods=[list(METHODS[0])]))
    assert draft.status_code in (400, 422)
    other_user = TestClient(c.app); login(other_user, "bob")
    assert other_user.get(f"/api/lab/compatible?a={a}").status_code == 404
