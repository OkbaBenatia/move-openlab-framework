"""Scenario packages (move-openlab-scenario/1): export → import round trip, every integrity refusal, road network
installed or not, account isolation, and the shipped sample scenario (packed to the published checksum, imported, run
with both built-in methods, every run accepted by the independent validator)."""
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from conftest import ROOT
from geo_fixtures import BBOX, grid_overpass
from move_openlab import registry, samples
from move_openlab import scenario_packages as SP
from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.geo import scenarios as SC
from move_openlab.geo.geometry import GeometryStore
from move_openlab.geo.osm import NetworkStore
from move_openlab.hashing import canonical, sha256_bytes, with_hash
from move_openlab.store import Installation, IntegrityError
from test_api import PW, login, make_settings

RIDE = "public-ride-matching"
METHODS = [("exact-matching-highs", "1.0.0"), ("greedy-min-detour", "1.0.0")]


def ws(tmp_path, name, network=False):
    inst = Installation(tmp_path / name, installation_id=f"inst-{name}")
    if network:
        NetworkStore(inst.data).save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    return inst.workspace(f"r-{name}", f"Researcher {name}")


def library_scenario(w):
    """A scenario saved in the library exactly as the wizard saves one (validated composition + built instance)."""
    nets = NetworkStore(w.inst.data)
    nid = nets.list()[0]["network_id"]
    net, prov = nets.load(nid), nets.provenance(nid)
    sc = SC.validate_scenario(SC.generate_synthetic(net, "grid sample", 5, 7, 3, 25200, 27000,
                                                    dict(max_detour_s=900, max_detour_ratio=1.5), 300))
    return w.save_scenario(registry.get(RIDE), sc, SC.build_instance(sc, net, prov, "geo-grid-sample"))


@pytest.fixture
def package(tmp_path):
    a = ws(tmp_path, "A", network=True)
    rec = library_scenario(a)
    data, meta = a.export_scenario_package(rec["instance_hash"], rec)
    return data, meta, rec


def members(data: bytes) -> dict[str, bytes]:
    z = zipfile.ZipFile(io.BytesIO(data))
    return {n: z.read(n) for n in z.namelist()}


def pack(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items():
            z.writestr(k, v)
    return buf.getvalue()


def resealed(files: dict[str, bytes], man_edit=None) -> bytes:
    """Recompute every digest after an edit (an inconsistent package that still passes its checksums)."""
    man = json.loads(files["manifest.json"])
    man["files"] = {k: sha256_bytes(v) for k, v in files.items() if k not in ("manifest.json", "manifest.sha256")}
    if man_edit:
        man_edit(man)
    mb = canonical(man)
    return pack(dict(files, **{"manifest.json": mb, "manifest.sha256": sha256_bytes(mb).encode()}))


# ---------------------------------------------------------------- round trip, network installed or not
def test_round_trip_rebuilt_where_the_network_is_installed(tmp_path, package):
    data, meta, rec = package
    assert meta["composition"] == "library" and meta["geometry"]
    names = set(members(data))
    assert names == {"manifest.json", "manifest.sha256", "instance.json", "scenario.json", "geometry.json"}
    b = ws(tmp_path, "B", network=True)
    rep = b.import_scenario_package(data)
    c = rep["composition"]
    assert rep["ok"] and c["network_installed"] and c["rebuilt"] and c["identical"] and rep["editable"]
    assert rep["scenario"]["instance_hash"] == rec["instance_hash"] and rep["editing_note"] is None
    assert rep["executable_code_in_package"] is False and rep["files_checked"] == 3 and rep["geometry"]["verified"]
    lib = b.scenario(rep["scenario_id"])
    assert lib["instance_hash"] == rec["instance_hash"] and lib["source"] == SP.IMPORTED
    prov = lib["scenario"]["provenance"]
    assert prov["package_sha256"] == sha256_bytes(data) and prov["original"] == rec["scenario"]["provenance"]
    assert prov["rebuilt_here"] is True
    # importing the same package again adds nothing
    again = b.import_scenario_package(data)
    assert again["already_present"] and again["scenario_id"] == rep["scenario_id"]
    assert len(b.scenarios(RIDE)) == 1
    # a real round trip: the imported scenario exports again (original provenance restored) to the same instance
    data2, meta2 = b.export_scenario_package(lib["instance_hash"], lib)
    assert meta2["composition"] == "library"
    assert json.loads(members(data2)["scenario.json"]) == json.loads(members(data)["scenario.json"])
    c2 = ws(tmp_path, "C2", network=True)
    assert c2.import_scenario_package(data2)["composition"]["identical"]


def test_round_trip_without_the_network_stores_the_verified_frozen_instance(tmp_path, package):
    data, _, rec = package
    c = ws(tmp_path, "C")
    rep = c.import_scenario_package(data)
    comp = rep["composition"]
    assert comp["included"] and comp["consistent"] and not comp["network_installed"] and not comp["rebuilt"]
    assert comp["identical"] is None and not rep["editable"] and "road network" in rep["editing_note"]
    assert c.inst.get_instance(rec["instance_hash"])["instance_hash"] == rec["instance_hash"]
    assert GeometryStore(c.root).get(rec["instance_hash"])["legs"]                  # replay without the network
    run = c.create_campaign(RIDE, "imported scenario", dict(instance_hashes=[rec["instance_hash"]]), METHODS, repetitions=1)
    c.execute(run["campaign_id"])
    assert all(r["accepted"] for r in c.get(run["campaign_id"])["runs"])


def test_export_of_an_experiment_frozen_scenario_recovers_the_composition(tmp_path, package):
    data, _, rec = package
    c = ws(tmp_path, "C")
    camp = c.create_campaign(RIDE, "frozen", dict(instance_hashes=[c.import_scenario_package(data)["scenario"]["instance_hash"]]),
                             METHODS, repetitions=1)
    d = ws(tmp_path, "D")                       # imports only the experiment's instance: no library record there
    d.inst.put_instance(registry.get(RIDE), c.inst.get_instance(rec["instance_hash"]))
    out, meta = d.export_scenario_package(rec["instance_hash"])
    assert meta["composition"] == "instance" and not meta["geometry"]          # no network, no geometry in D
    e = ws(tmp_path, "E", network=True)
    assert e.import_scenario_package(out)["composition"]["identical"]          # the recovered composition rebuilds
    assert camp["scenario_set"]["instance_hashes"] == [rec["instance_hash"]]


# ---------------------------------------------------------------- integrity refusals
def _swap_instance(files, edit):
    inst = json.loads(files["instance.json"])
    edit(inst)
    return dict(files, **{"instance.json": canonical(inst)})


def refusals(data: bytes, other_geometry: bytes):
    f = members(data)
    man = json.loads(f["manifest.json"])
    return {
        "file checksum mismatch": pack(dict(f, **{"instance.json": f["instance.json"].replace(b'"riders"', b'"riders" ', 1)})),
        "manifest digest mismatch": pack(dict(f, **{"manifest.json": f["manifest.json"].replace(b'"format"', b'"format" ', 1)})),
        "unsafe package member names": pack(dict(f, **{"../escape.json": b"{}"})),
        "unexpected member": pack(dict(f, **{"notes.txt": b"x"})),
        "unlisted files": pack(dict(f, **{"manifest.json": canonical(dict(man, files={k: v for k, v in man["files"].items() if k != "geometry.json"}))},
                                **{"manifest.sha256": sha256_bytes(canonical(dict(man, files={k: v for k, v in man["files"].items() if k != "geometry.json"}))).encode()})),
        "specification or validator differs": resealed(f, lambda m: m.update(validator_version="0.0.1")),
        "objective / constraint": resealed(f, lambda m: m["spec"].update(objective_spec_id="other/1.0.0")),
        "instance hash mismatch": resealed(_swap_instance(f, lambda i: i.update(name="renamed"))),
        "does not belong to the package's instance": resealed(dict(f, **{"geometry.json": other_geometry})),
        "composition does not match": resealed(dict(f, **{"scenario.json": canonical(dict(json.loads(f["scenario.json"]), params=dict(max_detour_s=60, max_detour_ratio=0.1)))})),
        "unsupported scenario package format": resealed(f, lambda m: m.update(format="move-openlab-scenario/9")),
        "member too large": pack(dict(f, **{"geometry.json": b"0" * (SP.MAX_MEMBER_BYTES + 1)})),
        "not a valid ZIP": b"PK not really a zip",
    }


def test_every_integrity_refusal(tmp_path, package):
    data, _, _ = package
    a2 = ws(tmp_path, "A2", network=True)
    nets = NetworkStore(a2.inst.data)
    nid = nets.list()[0]["network_id"]
    net, prov = nets.load(nid), nets.provenance(nid)
    sc = SC.validate_scenario(SC.generate_synthetic(net, "another", 4, 4, 9, 25200, 27000, None, 300))
    other = SC.build_instance(sc, net, prov, "other")
    from move_openlab.geo import geometry as G
    other_geo = canonical(G.build(other, net))
    b = ws(tmp_path, "B", network=True)
    for why, bad in refusals(data, other_geo).items():
        with pytest.raises(IntegrityError) as e:
            b.verify_scenario_package(bad)
        assert any(w in str(e.value) for w in why.split(" or ")) or why in str(e.value), (why, str(e.value))
        assert b.scenarios() == []                                             # nothing written by a refusal


def test_a_package_too_large_is_refused(tmp_path, package, monkeypatch):
    data, _, _ = package
    monkeypatch.setattr(SP, "MAX_PACKAGE_BYTES", len(data) - 1)
    with pytest.raises(IntegrityError, match="too large"):
        ws(tmp_path, "B").verify_scenario_package(data)


def test_tampered_travel_data_is_caught_by_the_rebuild_where_the_network_is_installed(tmp_path, package):
    """A consistent rewrite (every digest and the instance hash recomputed) that changes recorded travel data passes
    every structural check; only the rebuild on the installed road network detects it — and says so."""
    data, _, _ = package
    f = members(data)

    def edit(i):
        i["pairs"][0]["to_pickup_m"] = float(i["pairs"][0]["to_pickup_m"]) + 250.0
    inst = with_hash(json.loads(_swap_instance(f, edit)["instance.json"]))
    f2 = dict(f, **{"instance.json": canonical(inst)})
    f2.pop("geometry.json")                                                    # geometry names the old hash
    bad = resealed(f2, lambda m: m["scenario"].update(instance_hash=inst["instance_hash"]))
    with pytest.raises(IntegrityError, match="rebuilt here"):
        ws(tmp_path, "B", network=True).verify_scenario_package(bad)
    rep = ws(tmp_path, "C").verify_scenario_package(bad)                       # not detectable without the network
    assert not rep["composition"]["rebuilt"] and rep["editing_note"]


# ---------------------------------------------------------------- the shipped sample scenario
def test_shipped_samples_pack_to_the_published_checksums():
    sums = dict(reversed(line.split(maxsplit=1)) for line in (ROOT / "examples" / "SHA256SUMS").read_text().splitlines() if line.strip())
    assert sums == {samples.SCENARIO_FILENAME: sha256_bytes(samples.scenario_bytes()),
                    samples.EXPERIMENT_EXAMPLE: sha256_bytes(samples.bundle_bytes())}
    info = samples.scenario_info()
    assert samples.scenario_available() and info["packed_sha256"] == sums[samples.SCENARIO_FILENAME]
    assert info["packed_bytes"] == len(samples.scenario_bytes()) and samples.scenario_bytes() == SP_pack_again()
    assert sums[samples.EXPERIMENT_EXAMPLE] == samples.info()["packed_sha256"]     # the same bytes as the in-app bundle


def SP_pack_again() -> bytes:
    samples.scenario_bytes.cache_clear()
    return samples.scenario_bytes()


def test_sample_scenario_imports_and_runs_with_both_builtin_methods(tmp_path):
    w = ws(tmp_path, "S")
    rep = w.import_scenario_package(samples.scenario_bytes())
    info = samples.scenario_info()
    assert rep["scenario"]["instance_hash"] == info["instance_hash"]
    assert (rep["scenario"]["drivers"], rep["scenario"]["riders"]) == (20, 30)
    assert rep["composition"]["origin"] == "instance" and rep["composition"]["consistent"]
    assert not rep["composition"]["network_installed"] and not rep["editable"]  # a new installation has no network
    assert {lic["subject"] for lic in rep["licences"]} == {"participants", "road network, travel times and route geometry"}
    assert "Licence Ouverte" in rep["licences"][0]["statement"] and "OpenStreetMap" in rep["licences"][1]["statement"]
    lib = w.scenario(rep["scenario_id"])
    assert lib["scenario"]["provenance"]["original"]["source"] == "open-data"   # original provenance kept
    assert info["composition_check"]["composition_digest_prefix"] == info["instance_id"].rsplit("-", 1)[-1]
    c = w.create_campaign(RIDE, "sample scenario run", dict(instance_hashes=[rep["scenario"]["instance_hash"]]), METHODS,
                          repetitions=1)
    w.execute(c["campaign_id"])
    runs = w.get(c["campaign_id"])["runs"]
    problem, inst = registry.get(RIDE), w.inst.get_instance(rep["scenario"]["instance_hash"])
    assert {r["method_id"] for r in runs} == {m for m, _ in METHODS}
    assert runs and all(r["accepted"] for r in runs)
    assert all(problem.validate(inst, r["decisions"])["feasible"] for r in runs)  # independently re-validated here


# ---------------------------------------------------------------- HTTP: sample routes, inspect routing, isolation
def client(tmp_path):
    s = make_settings(tmp_path, "pk")
    auth = Auth(s, UserStore(None))
    for u in PW:
        auth.create_user(u, u.title(), password=PW[u])
        auth.store.set_password(u, hash_password(PW[u]), must_change=False)
    return TestClient(create_app(s, auth))


def test_http_sample_routes_inspect_routing_and_isolation(tmp_path):
    alice = client(tmp_path)
    login(alice, "alice")
    st = alice.get("/api/lab/state").json()["sample_scenario"]
    assert st["available"] and st["scenario_id"] is None and st["sha256"] == samples.scenario_info()["packed_sha256"]
    dl = alice.get("/api/lab/sample/scenario")
    assert dl.status_code == 200 and dl.content == samples.scenario_bytes()
    assert 'filename="sample_scenario.zip"' in dl.headers["content-disposition"]
    v = alice.post("/api/lab/sample/scenario/verify").json()
    assert v["ok"] and v["kind"] == "scenario" and v["in_library"] is None
    routed = alice.post("/api/lab/inspect", files=dict(file=("sample_scenario.zip", dl.content, "application/zip"))).json()
    assert routed["kind"] == "scenario" and routed["scenario"]["instance_hash"] == v["scenario"]["instance_hash"]
    bundle = alice.post("/api/lab/inspect", files=dict(file=("b.zip", samples.bundle_bytes(), "application/zip"))).json()
    assert "kind" not in bundle and bundle["campaigns_verified"]                  # an experiment bundle keeps its path
    imp = alice.post("/api/geo/scenario-packages/import", files=dict(file=("s.zip", dl.content, "application/zip")))
    assert imp.status_code == 200, imp.text
    sid, h = imp.json()["scenario_id"], imp.json()["scenario"]["instance_hash"]
    lib = alice.get("/api/geo/scenarios").json()["scenarios"]
    assert [s["category"] for s in lib if s["scenario_id"] == sid] == ["Imported"]
    assert alice.get("/api/lab/state").json()["sample_scenario"]["scenario_id"] == sid
    exp = alice.get(f"/api/geo/scenarios/{sid}/package")
    assert exp.status_code == 200 and exp.headers["x-package-sha256"] == sha256_bytes(exp.content)
    assert alice.get(f"/api/geo/instances/{h}/package").status_code == 200
    assert alice.post("/api/geo/scenario-packages/inspect", files=dict(file=("x.zip", b"junk", "application/zip"))).status_code == 422
    bob = TestClient(alice.app)
    login(bob, "bob")
    assert all(s["instance_hash"] != h for s in bob.get("/api/geo/scenarios").json()["scenarios"])
    assert bob.get(f"/api/geo/scenarios/{sid}").status_code == 404
    assert bob.get(f"/api/geo/scenarios/{sid}/package").status_code == 404
    assert bob.get(f"/api/geo/instances/{h}/package").status_code == 404
    assert bob.get("/api/lab/state").json()["sample_scenario"]["scenario_id"] is None
