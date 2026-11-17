"""The demonstration ships the original road network its scenarios were built on, so that a fresh installation can edit
them without downloading anything: the exact network, checked against the frozen bundle, never rebuilt or replaced."""
import gzip
import hashlib
import json
import shutil

import pytest

from move_openlab import demo
from move_openlab.geo.osm import BUILDER, LICENCE, NetworkStore, _parse, build_network
from move_openlab.hashing import canonical, sha256

from test_api import login, make_client

REF = demo.network_ref()


def test_the_shipped_network_is_the_one_the_frozen_demonstration_references():
    net = gzip.decompress((demo.NETWORK / "network.json.gz").read_bytes())
    raw = gzip.decompress((demo.NETWORK / "overpass_raw.json.gz").read_bytes())
    prov = json.loads((demo.NETWORK / "provenance.json").read_text())
    assert REF["network_id"] == "2858421165cd47486a509d26"
    assert hashlib.sha256(net).hexdigest() == REF["network_sha256"]
    doc = json.loads(net)
    assert sha256({k: v for k, v in doc.items() if k != "network_id"})[:24] == doc["network_id"] == REF["network_id"]
    assert (len(doc["lat"]), len(doc["edges"])) == (REF["nodes"], REF["edges"])
    # provenance: the raw Overpass response it was built from, its query on the demonstration's box, licence and builder
    assert hashlib.sha256(raw).hexdigest() == REF["raw_sha256"] == prov["source"]["raw_sha256"]
    assert prov["source"]["osm_timestamp"] == REF["osm_timestamp"] and prov["area"]["bbox"] == REF["bbox"]
    assert "(47.42,6.66,47.6,6.96)" in prov["source"]["query"] and prov["profile"] == REF["profile"] == "car"
    assert prov["licence"] == REF["licence"] == LICENCE and LICENCE["id"] == "ODbL-1.0"
    assert "OpenStreetMap contributors" in LICENCE["attribution"]
    assert prov["builder"] == REF["builder"] == BUILDER
    # the network is exactly what the builder makes of that OpenStreetMap response (nothing edited by hand)
    assert canonical(build_network(_parse(raw), prov["profile"])) == net


def test_installed_once_unchanged_and_tampered_copies_are_refused(tmp_path, monkeypatch):
    st = NetworkStore(tmp_path)
    assert demo.install_network(st) == REF["network_id"]
    d = tmp_path / "networks" / REF["network_id"]
    assert hashlib.sha256((d / "network.json").read_bytes()).hexdigest() == REF["network_sha256"]
    st.load(REF["network_id"])                                           # passes its content hash
    assert st.find(REF["bbox"], "car")["network_id"] == REF["network_id"]
    assert sorted(p.name for p in (tmp_path / "networks").iterdir()) == [REF["network_id"]]   # no temporary left
    before = (d / "provenance.json").stat().st_mtime_ns
    assert demo.install_network(st) == REF["network_id"] and (d / "provenance.json").stat().st_mtime_ns == before
    # a shipped copy that does not match the bundle is never stored
    bad = tmp_path / "bad"
    shutil.copytree(demo.NETWORK, bad)
    doc = json.loads(gzip.decompress((bad / "network.json.gz").read_bytes()))
    doc["lat"][0] += 1e-5
    (bad / "network.json.gz").write_bytes(gzip.compress(canonical(doc)))
    monkeypatch.setattr(demo, "NETWORK", bad)
    other = NetworkStore(tmp_path / "other")
    with pytest.raises(ValueError):
        demo.install_network(other)
    assert not (tmp_path / "other" / "networks" / REF["network_id"]).exists()


def test_a_fresh_installation_can_edit_the_demonstration(tmp_path):
    c = make_client(tmp_path, "fresh")
    login(c, "alice")
    r = c.post("/api/lab/demo").json()
    area = next(a for a in c.get("/api/geo/areas").json()["areas"] if a["area_id"] == r["area_id"])
    assert area["network_id"] == REF["network_id"]                       # the original network, nothing downloaded
    e = c.get(f"/api/lab/experiments/{r['baseline_id']}").json()
    assert e["context"]["area"]["network_id"] == REF["network_id"] and e["context"]["area"].get("area_id") == r["area_id"]
    snap = c.get(f"/api/geo/networks/{REF['network_id']}/snap", params=dict(p="47.51,6.80"))
    assert snap.status_code == 200, snap.text                            # participants can be placed on it
    c.post("/api/auth/logout")
    login(c, "bob")                                                       # another researcher: the shared network is reused
    r2 = c.post("/api/lab/demo").json()
    assert next(a for a in c.get("/api/geo/areas").json()["areas"] if a["area_id"] == r2["area_id"])["network_id"] == REF["network_id"]


def test_a_demonstration_area_added_without_its_network_gets_it(tmp_path):
    """An area added by an earlier version (fresh installation, no network stored) is completed on the next visit."""
    c = make_client(tmp_path, "upgrade")
    login(c, "alice")
    r = c.post("/api/lab/demo").json()
    ws = next(p.parent for p in (tmp_path).rglob(f"{r['area_id']}.json"))
    rec = json.loads((ws / f"{r['area_id']}.json").read_text())
    rec["network_id"] = None
    (ws / f"{r['area_id']}.json").write_text(json.dumps(rec))
    assert c.get(f"/api/geo/areas/{r['area_id']}").json()["network_id"] is None
    c.get("/api/lab/state")
    assert c.get(f"/api/geo/areas/{r['area_id']}").json()["network_id"] == REF["network_id"]
