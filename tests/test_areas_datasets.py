"""Geographic areas, road-network profiles, place search and trip datasets (CSV, GeoJSON, RPC coverage).

All data are synthetic (artificial grid at 10°N 20°E); external services are replaced by fakes.
"""
import io
import json
import time

import pytest
from fastapi.testclient import TestClient

from geo_fixtures import BBOX, grid_overpass, pt
from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.datasets import DatasetStore
from move_openlab.datasets import tabular as T
from move_openlab.geo import osm
from move_openlab.geo.areas import AreaStore
from move_openlab.geo.geocode import Geocoder
from move_openlab.geo.osm import NetworkStore, SourceUnavailable, build_network, validate_bbox
from move_openlab.integrations import rpc
from test_api import make_settings

USERS = {"alice": "Correct-Horse-Battery-9!", "bob": "Staple-Mountain-Rain-7!", "root": "Operator-Key-2026-xyz"}


def client(tmp_path, **settings):
    s = make_settings(tmp_path, "ad")
    if settings:
        s = type(s)(**{**s.__dict__, **settings})
    auth = Auth(s, UserStore(None))
    for u, pw in USERS.items():
        auth.create_user(u, u.title(), role="admin" if u == "root" else "researcher", password=pw)
        auth.store.set_password(u, hash_password(pw), must_change=False)
    prov = NetworkStore(s.data_dir).save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    return TestClient(create_app(s, auth)), s, prov


def signed(c, user):
    t = TestClient(c.app)
    assert t.post("/api/auth/login", json=dict(username=user, password=USERS[user])).status_code == 200
    return t


def wait(c, job):
    for _ in range(400):
        job = c.get(f"/api/jobs/{job['job_id']}").json()
        if job["state"] != "running":
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


# ---------------------------------------------------------------- profiles and areas
def test_profiles_select_roads_speeds_and_area_limits():
    car, main, peak = (build_network(grid_overpass(), p) for p in ("car", "car-main-roads", "car-peak"))
    assert len({car["network_id"], main["network_id"], peak["network_id"]}) == 3
    assert len(main["lat"]) == 7 and len(car["lat"]) > len(main["lat"])               # only the primary street
    t_car = {(u, v): t for u, v, _, t in car["edges"]}
    t_peak = {(u, v): t for u, v, _, t in peak["edges"]}
    k = next(iter(t_car))
    assert t_peak[k] == pytest.approx(t_car[k] / 0.7, rel=1e-3)
    big = [40.0, 2.0, 40.8, 2.8]                                                       # 0.64 deg²
    with pytest.raises(ValueError, match="too large"):
        validate_bbox(big, "car")
    assert validate_bbox(big, "car-main-roads")
    for bad in ([1, 2, 3], [10, 20, 9, 21], [89, 0, 89.5, 1], [10, 20, 10.0001, 20.0001]):
        with pytest.raises(ValueError):
            validate_bbox(bad)
    with pytest.raises(ValueError, match="unknown road-network profile"):
        build_network(grid_overpass(), "bicycle")


def test_network_cache_lookup_and_area_store(tmp_path):
    st = NetworkStore(tmp_path)
    prov = st.save(grid_overpass(), dict(name="g", bbox=BBOX), "fixture://", "car-main-roads")
    assert st.find(BBOX, "car-main-roads")["network_id"] == prov["network_id"]
    assert st.find(BBOX, "car") is None and st.find([b + 0.01 for b in BBOX], "car-main-roads") is None
    a = AreaStore(tmp_path / "ws")
    rec = a.create("Grid", BBOX, "car", network_id="x" * 24)
    assert a.update(rec["area_id"], name="Grid renamed")["network_id"] == "x" * 24        # same box: kept
    moved = a.update(rec["area_id"], bbox=[b + 0.001 for b in BBOX])
    assert moved["network_id"] is None                                                   # new box: detached
    with pytest.raises(KeyError):
        a.get("../../etc/passwd")
    with pytest.raises(ValueError):
        a.create("x", BBOX)


def test_area_network_download_job_quota_and_permission(tmp_path, monkeypatch):
    c, s, prov = client(tmp_path, daily_networks=1)
    from move_openlab.api import areas as A
    calls = []
    monkeypatch.setattr(A, "fetch_overpass", lambda bbox, url, profile_name=None: calls.append(profile_name) or grid_overpass())
    alice = signed(c, "alice")
    area = alice.post("/api/geo/areas", json=dict(name="grid main roads", bbox=BBOX, profile="car-main-roads")).json()
    assert area["network_id"] is None and area["cached_network"] is None
    r = alice.post(f"/api/geo/areas/{area['area_id']}/network", json={}).json()
    job = wait(alice, r["job"])
    assert job["state"] == "done", job
    a2 = alice.get(f"/api/geo/areas/{area['area_id']}").json()
    assert a2["network_id"] and a2["network_id"] != prov["network_id"] and calls == ["car-main-roads"]
    cov = alice.get(f"/api/geo/networks/{a2['network_id']}/coverage").json()
    assert cov["nodes"] == 7 and cov["road_km"] > 0 and cov["provenance"]["profile"] == "car-main-roads"
    other = alice.post("/api/geo/areas", json=dict(name="grid peak", bbox=BBOX, profile="car-peak")).json()
    assert alice.post(f"/api/geo/areas/{other['area_id']}/network", json={}).status_code == 429     # daily quota
    bob = signed(c, "bob")
    assert bob.get(f"/api/geo/areas/{area['area_id']}").status_code == 404                        # workspace areas
    assert bob.post("/api/geo/areas", json=dict(name="too big", bbox=[40, 2, 40.8, 2.8])).status_code == 400
    c2, _, _ = client(tmp_path / "x", external_fetch="admin")
    carol = signed(c2, "alice")
    a3 = carol.post("/api/geo/areas", json=dict(name="peak", bbox=BBOX, profile="car-peak")).json()
    assert carol.post(f"/api/geo/areas/{a3['area_id']}/network", json={}).status_code == 403


def test_service_errors_are_actionable(monkeypatch):
    import urllib.error

    def boom(*a, **k):
        raise urllib.error.HTTPError("u", 429, "Too Many Requests", {}, None)
    monkeypatch.setattr(osm.urllib.request, "urlopen", boom)
    with pytest.raises(SourceUnavailable, match="429"):
        osm.fetch_overpass(BBOX, "https://overpass.invalid/api")
    empty = json.dumps(dict(elements=[])).encode()
    with pytest.raises(ValueError, match="no routable road"):
        build_network(empty)


# ---------------------------------------------------------------- place search
class FakeService:
    def __init__(self):
        self.calls = []

    def __call__(self, req, timeout=0):
        self.calls.append((req.full_url, time.monotonic(), req.headers.get("User-agent")))
        body = json.dumps([dict(display_name="Gridtown", lat="10.01", lon="20.01", boundingbox=["10.0", "10.02", "20.0", "20.02"],
                                category="place", type="town")]).encode()
        return io.BytesIO(body)


def test_geocoder_caches_throttles_and_can_be_switched_off(tmp_path):
    fake = FakeService()
    g = Geocoder("https://geocoder.invalid/search", tmp_path, opener=fake)
    r = g.search("  Gridtown ")
    assert r["results"][0]["bbox"] == [10.0, 20.0, 10.02, 20.02] and not r["cached"]
    assert g.search("gridtown")["cached"] and len(fake.calls) == 1                     # normalised + cached
    g.search("other place")
    assert fake.calls[1][1] - fake.calls[0][1] >= 0.99                                 # one request per second
    assert "move-openlab" in fake.calls[0][2]
    with pytest.raises(ValueError):
        g.search("x")
    with pytest.raises(SourceUnavailable, match="switched off"):
        Geocoder("off", tmp_path).search("Gridtown")


# ---------------------------------------------------------------- CSV and GeoJSON uploads
def csv_bytes(rows, sep=";", enc="cp1252"):
    head = sep.join(["Départ lat", "Départ lon", "Arrivée lat", "Arrivée lon", "Heure", "Date", "Rôle"])
    return ("\n".join([head] + [sep.join(map(str, r)) for r in rows]) + "\n").encode(enc)


def good_rows(n=12):
    out = []
    for k in range(n):
        o, d = pt(k % 7, (k * 3) % 7), pt((k * 5) % 7, (k + 2) % 7)
        if o == d:
            d = pt(6, 6) if o != pt(6, 6) else pt(0, 0)
        out.append([str(o[0]).replace(".", ","), str(o[1]).replace(".", ","), str(d[0]).replace(".", ","),
                    str(d[1]).replace(".", ","), f"0{7 + k % 3}:{(k % 6) * 10:02d}", "03/08/2026",
                    "conducteur" if k % 2 else "passager"])
    return out


MAPPING = {"origin_lat": "Départ lat", "origin_lon": "Départ lon", "destination_lat": "Arrivée lat",
           "destination_lon": "Arrivée lon", "departure": "Heure", "date": "Date", "role": "Rôle"}


def test_csv_detection_mapping_validation_and_isolation(tmp_path):
    c, s, prov = client(tmp_path)
    alice = signed(c, "alice")
    bad = [["91,0", "20,0", "10,0", "20,0", "07:00", "03/08/2026", "passager"],          # latitude out of range
           [str(pt(1, 1)[0]), str(pt(1, 1)[1]), str(pt(2, 2)[0]), str(pt(2, 2)[1]), "25:00", "03/08/2026", "passager"],
           [str(pt(1, 1)[0]), str(pt(1, 1)[1]), str(pt(2, 2)[0]), str(pt(2, 2)[1]), "07:00", "03/08/2026", "pilot"]]
    raw = csv_bytes(good_rows() + bad)
    files = {"file": ("trips.csv", raw, "text/csv")}
    info = alice.post("/api/datasets/csv/inspect", files=files).json()
    assert info["encoding"] == "windows-1252" and info["delimiter"] == ";" and info["columns"][0] == "Départ lat"
    area = alice.post("/api/geo/areas", json=dict(name="grid", bbox=BBOX)).json()
    form = dict(mapping=json.dumps(MAPPING), name="Survey sample", date_format="DD/MM/YYYY", area_id=area["area_id"])
    rep = alice.post("/api/datasets/csv/import", files=files, data=form).json()["report"]
    assert rep["rows_valid"] == 12 and sum(rep["rejected"].values()) == 3
    assert rep["coverage"]["inside_area"] == 12 and rep["coverage"]["roles"] == {"driver": 6, "rider": 6}
    assert rep["parsing"]["time_format"] == "time" and rep["coverage"]["dates"] == ["2026-08-03", "2026-08-03"]
    assert {e["row"] for e in rep["examples"]} == {14, 15, 16}
    assert alice.post("/api/datasets/csv/import", files=files, data=dict(form, save="true")).status_code == 409
    saved = alice.post("/api/datasets/csv/import", files=files, data=dict(form, save="true", accept_rejections="true")).json()
    key = saved["report"]["dataset_key"]
    assert saved["saved"] and saved["report"]["source"]["sha256"] and "trips" not in saved["report"]
    assert [d["dataset_key"] for d in alice.get("/api/datasets").json()["mine"]] == [key]
    bob = signed(c, "bob")
    assert bob.get(f"/api/datasets/{key}").status_code == 404 and bob.get("/api/datasets").json()["mine"] == []
    assert bob.delete(f"/api/datasets/{key}").status_code == 404
    gen = alice.post("/api/geo/scenarios/from-dataset", json=dict(network_id=prov["network_id"], dataset_key=key,
                                                                  name="from survey", n_drivers=3, n_riders=4, seed=1,
                                                                  start_s=25200, end_s=36000))
    assert gen.status_code == 200, gen.text
    sc = alice.get(f"/api/geo/scenarios/{gen.json()['scenario_id']}").json()["scenario"]
    assert sc["provenance"]["source"] == "dataset" and "roles respected" in sc["provenance"]["method"]
    assert bob.post("/api/geo/scenarios/from-dataset", json=dict(network_id=prov["network_id"], dataset_key=key,
                                                                 name="stolen", n_drivers=1, n_riders=1, seed=1,
                                                                 start_s=0, end_s=86400)).status_code == 404
    assert alice.delete(f"/api/datasets/{key}").json()["deleted"] == key


def test_csv_refuses_ambiguous_or_incompatible_data(tmp_path, monkeypatch):
    c, s, prov = client(tmp_path)
    alice = signed(c, "alice")
    mixed = csv_bytes([r[:4] + [t] + r[5:] for r, t in zip(good_rows(4), ["07:00", "2026-08-03T07:00", "07:10", "07:20"])])
    r = alice.post("/api/datasets/csv/import", files={"file": ("m.csv", mixed)}, data=dict(mapping=json.dumps(MAPPING)))
    assert r.status_code == 400 and "mixed timestamp formats" in r.json()["detail"]
    r = alice.post("/api/datasets/csv/import", files={"file": ("m.csv", csv_bytes(good_rows()))},
                   data=dict(mapping=json.dumps({"origin_lat": "Départ lat"})))
    assert r.status_code == 400 and "map these fields" in r.json()["detail"]
    far = alice.post("/api/geo/areas", json=dict(name="elsewhere", bbox=[45.0, 5.0, 45.1, 5.1])).json()
    r = alice.post("/api/datasets/csv/import", files={"file": ("t.csv", csv_bytes(good_rows()))},
                   data=dict(mapping=json.dumps(MAPPING), date_format="DD/MM/YYYY", area_id=far["area_id"], name="x y",
                             save="true", accept_rejections="true"))
    assert r.status_code == 400 and "inside the area" in r.json()["detail"]
    r = alice.post("/api/datasets/csv/inspect", files={"file": ("b.bin", b"\x00\x01\x02" * 100)})
    assert r.status_code == 400
    from move_openlab.api import datasets as D
    monkeypatch.setattr(D, "MAX_UPLOAD_BYTES", 100)
    assert alice.post("/api/datasets/csv/inspect", files={"file": ("t.csv", csv_bytes(good_rows()))}).status_code == 413
    assert alice.post("/api/datasets/xlsx/inspect", files={"file": ("t.csv", b"a,b\n1,2\n")}).status_code == 404


def feature(o, d, dep="2026-08-03T07:30:00", kind="LineString"):
    coords = [[o[1], o[0]], [d[1], d[0]]]
    return dict(type="Feature", geometry=dict(type=kind, coordinates=coords if kind != "Point" else coords[0]),
                properties=dict(departure=dep))


def test_geojson_import(tmp_path):
    c, s, prov = client(tmp_path)
    alice = signed(c, "alice")
    feats = [feature(pt(k % 7, 0), pt(6 - k % 7, 6)) for k in range(8)]
    feats += [feature(pt(1, 1), pt(2, 2), kind="Point"),
              dict(type="Feature", geometry=dict(type="MultiPoint", coordinates=[[20, 10], [20.01, 10.01], [20.02, 10.02]]),
                   properties=dict(departure="2026-08-03T07:00:00"))]
    doc = json.dumps(dict(type="FeatureCollection", features=feats)).encode()
    info = alice.post("/api/datasets/geojson/inspect", files={"file": ("t.geojson", doc)}).json()
    assert info["geometry_types"] == {"LineString": 8, "Point": 1, "MultiPoint": 1}
    assert info["suggested_mapping"] == {"departure": "departure"}
    rep = alice.post("/api/datasets/geojson/import", files={"file": ("t.geojson", doc)},
                     data=dict(mapping=json.dumps(info["suggested_mapping"]))).json()["report"]
    assert rep["rows_valid"] == 8 and rep["parsing"]["time_format"] == "iso" and len(rep["rejected"]) == 2
    assert rep["coverage"]["extent"][0] >= BBOX[0]                                     # [lon, lat] read correctly
    projected = json.dumps(dict(type="FeatureCollection", crs=dict(type="name", properties=dict(
        name="urn:ogc:def:crs:EPSG::3857")), features=feats[:2])).encode()
    r = alice.post("/api/datasets/geojson/import", files={"file": ("p.geojson", projected)},
                   data=dict(mapping=json.dumps({"departure": "departure"})))
    assert r.status_code == 400 and "not supported" in r.json()["detail"]
    r = alice.post("/api/datasets/geojson/inspect", files={"file": ("x.geojson", b'{"type": "Feature"}')})
    assert r.status_code == 400 and "FeatureCollection" in r.json()["detail"]


def test_tabular_parsing_rules():
    assert T.parse_time("2026-08-03T07:40:00+02:00", "iso") == ("2026-08-03", 27600)
    assert T.parse_time("1785739200", "epoch")[0] == "2026-08-03"
    assert T.parse_date("03/08/2026", "DD/MM/YYYY") == "2026-08-03" == T.parse_date("08/03/2026", "MM/DD/YYYY")
    assert T.number("48,85") == 48.85 and T.number("nan") is None and T.number("") is None
    with pytest.raises(T.DatasetError):
        T.detect_time_format(["tomorrow", "soon"])


# ---------------------------------------------------------------- RPC coverage and download safety
def test_rpc_covers_france_only_and_downloads_from_data_gouv_only():
    assert rpc.france_region([48.80, 2.22, 48.91, 2.47]) == "metropolitan France"
    assert rpc.france_region([-21.2, 55.4, -21.0, 55.6]) == "La Réunion"
    assert rpc.france_region([40.38, -3.75, 40.47, -3.62]) is None                     # Madrid
    assert rpc.check_download_url("https://static.data.gouv.fr/resources/x/2026-08.csv")
    for bad in ("http://static.data.gouv.fr/x.csv", "https://evil.example/x.csv", "file:///etc/passwd",
                "https://static.data.gouv.fr.evil.example/x.csv"):
        with pytest.raises(ValueError):
            rpc.check_download_url(bad)


def test_dataset_store_rejects_traversal(tmp_path):
    st = DatasetStore(tmp_path)
    for k in ("../x", "2026-08_abc", "u-../../etc"):
        with pytest.raises(KeyError):
            st.load(k)


# ---------------------------------------------------------------- review regressions
def test_cross_user_writes_are_refused(tmp_path):
    c, s, prov = client(tmp_path)
    alice, bob = signed(c, "alice"), signed(c, "bob")
    a = alice.post("/api/geo/areas", json=dict(name="alice area", bbox=BBOX)).json()["area_id"]
    assert bob.put(f"/api/geo/areas/{a}", json=dict(name="hijacked")).status_code == 404
    assert bob.delete(f"/api/geo/areas/{a}").status_code == 404
    assert bob.post(f"/api/geo/areas/{a}/network", json={}).status_code == 404
    assert bob.post("/api/datasets/rpc/ingest", json=dict(release="2026-08", area_id=a)).status_code == 404
    assert alice.get(f"/api/geo/areas/{a}").json()["name"] == "alice area"
    assert alice.post("/api/datasets/rpc/ingest", json=dict(release="2026-08", area_id="")).status_code == 422


def test_malformed_uploads_are_client_errors(tmp_path):
    c, s, prov = client(tmp_path)
    alice = signed(c, "alice")
    m = dict(mapping=json.dumps({"departure": "departure"}))
    bad = [b'{"type":"FeatureCollection","crs":"EPSG:3857","features":[1]}',
           b'{"type":"FeatureCollection","features":[1, "x", {"geometry": "line", "properties": [1]}]}',
           b"[" * 100000, b"\xff\xfe\x00junk"]
    for raw in bad:
        for route in ("inspect", "import"):
            r = alice.post(f"/api/datasets/geojson/{route}", files={"file": ("x.geojson", raw)}, data=m)
            assert r.status_code == 400, (raw[:40], route, r.status_code, r.text)
    long_field = ("a,b,c\n" + "x" * 200_000 + ",1,2\n").encode()
    assert alice.post("/api/datasets/csv/inspect", files={"file": ("l.csv", long_field)}).status_code == 400
    with pytest.raises(ValueError):
        T.parse_date("2026-08-03garbage", "YYYY-MM-DD")
    assert T.number(True) is None


def test_request_bodies_are_capped_before_reading(tmp_path):
    c, s, prov = client(tmp_path)
    alice = signed(c, "alice")
    r = alice.post("/api/geo/areas", content=b"{}", headers={"content-type": "application/json",
                                                              "content-length": str(50 * 2**20)})
    assert r.status_code == 413
    r = alice.post("/api/datasets/csv/inspect", content=b"x", headers={"content-length": str(200 * 2**20),
                                                                       "content-type": "multipart/form-data; boundary=b"})
    assert r.status_code == 413


def test_redirects_must_stay_on_data_gouv():
    import urllib.request
    h = rpc._CheckedRedirect()
    req = urllib.request.Request("https://static.data.gouv.fr/x.csv")
    with pytest.raises(ValueError):
        h.redirect_request(req, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data")
    assert h.redirect_request(req, None, 302, "Found", {}, "https://object.files.data.gouv.fr/x.csv") is not None


def test_download_is_not_attached_to_an_edited_area_and_quota_is_refunded(tmp_path, monkeypatch):
    c, s, prov = client(tmp_path)
    from move_openlab.api import areas as A
    import threading
    gate = threading.Event()

    def slow(bbox, url, profile_name=None):
        gate.wait(5)
        return grid_overpass()
    monkeypatch.setattr(A, "fetch_overpass", slow)
    alice = signed(c, "alice")
    a = alice.post("/api/geo/areas", json=dict(name="moving", bbox=BBOX, profile="car-peak")).json()["area_id"]
    job = alice.post(f"/api/geo/areas/{a}/network", json={}).json()["job"]
    assert alice.post(f"/api/geo/areas/{a}/network", json={}).status_code == 409        # same area already running
    alice.put(f"/api/geo/areas/{a}", json=dict(profile="car-main-roads"))
    gate.set()
    done = wait(alice, job)
    assert done["state"] == "done" and any("not attached" in e["message"] for e in alice.get(f"/api/jobs/{job['job_id']}").json()["events"])
    assert alice.get(f"/api/geo/areas/{a}").json()["network_id"] is None
    q = c.app.state.quotas["networks"]
    assert len(q._hits["alice"]) == 1                                                     # the refused request was refunded


def test_geocoder_cache_hits_do_not_use_the_quota(tmp_path):
    c, s, prov = client(tmp_path, daily_searches=1)
    fake = FakeService()
    from move_openlab.geo.geocode import Geocoder as G
    c.app.state.geocoder = G("https://geocoder.invalid/search", tmp_path / "gc", opener=fake)
    alice = signed(c, "alice")
    assert alice.get("/api/geo/geocode", params=dict(q="Gridtown")).status_code == 200
    assert alice.get("/api/geo/geocode", params=dict(q="gridtown")).json()["cached"] is True
    assert alice.get("/api/geo/geocode", params=dict(q="x")).status_code == 400
    assert alice.get("/api/geo/geocode", params=dict(q="Elsewhere")).status_code == 429
    assert len(fake.calls) == 1
