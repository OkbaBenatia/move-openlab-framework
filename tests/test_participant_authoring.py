"""Participant and vehicle authoring: the seeded generator ("Randomize"), the checks of one participant placed by hand,
and the path editor payload -> stored scenario -> solver run -> independently validated result."""
import copy

import pytest

from geo_fixtures import BBOX, grid_overpass, pt
from move_openlab import registry
from move_openlab.geo import scenarios as SC
from move_openlab.geo.osm import NetworkStore
from move_openlab.mobility import authoring as AU
from test_api import login
from test_mobility import METHODS, client, profile, wait

RIDE = "public-ride-matching"
PETROL, HYBRID, ELECTRIC = profile("petrol", "ICE"), profile("hybrid", "HEV"), profile("electric", "BEV")
BASE = dict(n_drivers=10, n_riders=15, seed=7, min_trip_m=300, departure=[27000, 28800])


@pytest.fixture(scope="module")
def net(tmp_path_factory):
    st = NetworkStore(tmp_path_factory.mktemp("networks"))
    prov = st.save(grid_overpass(), dict(name="grid", bbox=BBOX), "fixture://")
    return st.load(prov["network_id"])


def fleet(**shares):
    return dict(shares=shares, profiles=[PETROL, HYBRID, ELECTRIC])


# ---------------------------------------------------------------- generation
def test_generation_is_reproducible_and_seeded(net):
    a, b = AU.generate(net, dict(BASE, **fleet(combustion=50, electric=50))), AU.generate(net, dict(BASE, **fleet(combustion=50, electric=50)))
    assert a == b                                                        # same inputs and seed: the same scenario
    c = AU.generate(net, dict(BASE, seed=8, **fleet(combustion=50, electric=50)))
    assert [x["origin"] for x in c["drivers"] + c["riders"]] != [x["origin"] for x in a["drivers"] + a["riders"]]
    # a participant's draw depends on the seed, the area, its role and its rank only
    more = AU.generate(net, dict(BASE, n_riders=40))
    assert more["drivers"] == [dict(d) for d in a["drivers"]] and more["riders"][:15] == a["riders"]
    prov = a["provenance"]
    assert prov["source"] == "generator" and prov["generator"] == AU.GENERATOR and prov["seed"] == 7
    assert prov["n_drivers"] == 10 and prov["n_riders"] == 15 and prov["window"] == [27000, 28800] and prov["area"] is None
    assert prov["parameters"]["vehicle_counts"] == dict(combustion=5, electric=5)


def test_generated_participants_are_valid_and_on_the_network(net):
    box = [10.0, 20.0, 10.0125, 20.0125]                                 # the south-west quarter of the grid
    sc = AU.generate(net, dict(BASE, n_drivers=6, n_riders=9, bbox=box, driver_window_s=600, rider_window_s=1500))
    assert [d["id"] for d in sc["drivers"]] == [f"D{k}" for k in range(1, 7)]
    assert [r["id"] for r in sc["riders"]] == [f"R{k}" for k in range(1, 10)]
    nodes = set(zip(net.lat, net.lon))
    for a in sc["drivers"] + sc["riders"]:
        for p in (a["origin"], a["destination"]):
            assert tuple(p) in nodes and box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]
        assert a["origin"] != a["destination"] and 27000 <= a["earliest"] <= 28800 and a["earliest"] % 300 == 0
    assert {d["latest"] - d["earliest"] for d in sc["drivers"]} == {600}
    assert {r["latest"] - r["earliest"] for r in sc["riders"]} == {1500}
    assert sc["provenance"]["area"] == box and "vehicles" not in sc
    inst = SC.build_instance(SC.validate_scenario(sc), net, dict(licence=dict(attribution="fixture", id="ODbL-1.0"), source={}), "t")
    assert len(inst["drivers"]) == 6 and len(inst["riders"]) == 9 and max(max(a["snap_m"]) for a in inst["drivers"] + inst["riders"]) == 0
    one = AU.generate(net, dict(BASE, departure=27000))                  # one departure time instead of an interval
    assert {a["earliest"] for a in one["drivers"] + one["riders"]} == {27000}


def test_vehicle_type_shares_and_capacity(net):
    sc = AU.generate(net, dict(BASE, **fleet(combustion=60, hybrid=10, electric=30)))
    v = sc["vehicles"]
    of = lambda d: v["assignments"].get(d["id"], v["default"])           # noqa: E731
    count = {pid: sum(1 for d in sc["drivers"] if of(d) == pid) for pid in ("petrol", "hybrid", "electric")}
    assert count == dict(petrol=6, hybrid=1, electric=3) and v["default"] == "petrol"
    assert AU.split_counts(10, [60, 10, 30]) == [6, 1, 3] and AU.split_counts(3, [50, 50]) == [2, 1]
    assert AU.split_counts(7, [100]) == [7] and sum(AU.split_counts(9, [33.4, 33.3, 33.3])) == 9
    # the shares decide how many, the seed decides who
    other = AU.generate(net, dict(BASE, seed=9, **fleet(combustion=60, hybrid=10, electric=30)))["vehicles"]["assignments"]
    assert sorted(other.values()) == sorted(v["assignments"].values()) and other != v["assignments"]
    # a default capacity other than the profile's gives a derived profile that names its source
    cap = AU.generate(net, dict(BASE, capacity=2, **fleet(combustion=100)))["vehicles"]
    assert [(p["id"], p["passenger_capacity"], p["provenance"]["derived_from"]) for p in cap["profiles"]] == [("petrol-2p", 2, "petrol")]
    assert cap["default"] == "petrol-2p" and cap["assignments"] == {}
    same = AU.generate(net, dict(BASE, capacity=4, **fleet(combustion=100)))["vehicles"]
    assert [p["id"] for p in same["profiles"]] == ["petrol"]             # the profile's own capacity: no copy
    again = AU.with_capacity(cap["profiles"][0], 3)                      # a variant of a variant keeps the original source
    assert again["id"] == "petrol-3p" and again["provenance"]["derived_from"] == "petrol"
    chosen = AU.generate(net, dict(BASE, shares=dict(combustion=100), profiles=[PETROL, profile("diesel", "ICE")],
                                   vehicles=dict(combustion="diesel")))["vehicles"]
    assert chosen["default"] == "diesel"


@pytest.mark.parametrize("change, message", [
    (dict(bbox=[10.0005, 20.0005, 10.0035, 20.0035]), "the rectangle contains no road node"),
    (dict(bbox=[40.0, 2.0, 41.0, 3.0]), "the rectangle contains no road node"),
    (dict(bbox=[10.0, 20.0, 10.0045, 20.0045], min_trip_m=1500), "the rectangle is too small for trips of at least 1500 m"),
    (dict(bbox=[10.02, 20.02, 10.0, 20.0]), "the generation rectangle is empty"),
    (dict(min_trip_m=20_000), "the working area is too small for trips of at least 20000 m"),
    (fleet(combustion=60, electric=30), "the vehicle shares add up to 90 %, not 100 %"),
    (fleet(combustion=120, electric=-20), "the combustion share must be between 0 and 100 %"),
    (dict(shares=dict(combustion=50, hybrid=50), profiles=[PETROL, ELECTRIC]), "no hybrid vehicle is available"),
    (dict(shares=dict(combustion=100), profiles=[PETROL], vehicles=dict(combustion="other")), "is not a combustion vehicle"),
    (dict(capacity=0, **fleet(combustion=100)), "the vehicle capacity must be at least 1 seat (got 0)"),
    (dict(capacity=61, **fleet(combustion=100)), "at most 60 seats"),
    (dict(capacity=2.5, **fleet(combustion=100)), "whole number of seats"),
    (dict(n_drivers=0), "the number of drivers must be between 1 and 100 (got 0)"),
    (dict(n_riders=101), "the number of riders must be between 1 and 100 (got 101)"),
    (dict(seed=-1), "the random seed must be between 0 and 1000000"),
    (dict(departure=[28800, 27000]), "the departure interval ends (07:30) before it starts (08:00)"),
    (dict(departure=[0, 200_000]), "the last departure must be between 0 and 172800"),
    (dict(driver_window_s=-60), "the driver departure window must be between 0 and 240 minutes"),
    (dict(rider_window_s=20_000), "the rider pick-up window must be between 0 and 240 minutes"),
    (dict(departure=[170_000, 172_000], rider_window_s=1200), "would end after 48:00"),
    (dict(max_detour_s=9000), "the maximum detour must be between 0 and 7200"),
    (dict(max_detour_ratio=6), "the maximum detour ratio must be between 0 and 5"),
    (dict(surprise=1), "unknown generation parameter"),
])
def test_generation_refuses_with_a_message_that_says_what_to_change(net, change, message):
    with pytest.raises(ValueError) as e:
        AU.generate(net, dict(BASE, **change))
    assert message in str(e.value), str(e.value)


# ---------------------------------------------------------------- one participant placed by hand
def test_a_participant_is_snapped_checked_and_refused_with_reasons(net):
    a = dict(id="D1", origin=[10.0001, 20.0002], destination=pt(4, 4), earliest=27000, latest=27900)
    r = AU.resolve_participant(net, "driver", a, BBOX)
    assert r["origin"] == pt(0, 0) and r["destination"] == pt(4, 4) and r["snap_m"][0] > 0 and r["snap_m"][1] == 0
    assert r["direct_s"] > 0 and r["arrival"] == [27000 + r["direct_s"], 27900 + r["direct_s"]] and r["latest"] == 27900
    # a latest arrival tightens the latest departure, and is refused when the direct trip cannot make it
    tight = AU.resolve_participant(net, "driver", dict(a, arrive_by=27000 + r["direct_s"] + 120), BBOX)
    assert tight["latest"] == 27120 and tight["arrival"][1] == 27000 + r["direct_s"] + 120
    loose = AU.resolve_participant(net, "rider", dict(a, id="R1", arrive_by=40000), BBOX)
    assert loose["latest"] == 27900
    refusals = [
        (dict(a, arrive_by=27000 + r["direct_s"] - 60), "the latest arrival 07:3", "is earlier than the direct travel time allows"),
        (dict(a, latest=26000), "the latest departure (07:13) is before the earliest departure (07:30)", "choose 07:30 or later"),
        (dict(a, destination=[10.0002, 20.0001]), "at the same road node", "place them further apart"),
        (dict(a, destination=[10.06, 20.06]), "D1: the destination is outside the working area", "place it inside the area"),
        (dict(a, origin=[48.8, 2.3]), "D1: the start is outside the working area", "place it inside the area"),
        (dict(a, id="1 bad"), "invalid identifier", "start with a letter"),
        (dict(a, earliest="07:30"), "times of day", "HH:MM"),
        (dict(a, origin=None), "the start must be placed on the map", ""),
    ]
    for body, *parts in refusals:
        with pytest.raises(ValueError) as e:
            AU.resolve_participant(net, "driver", body, BBOX)
        assert all(p in str(e.value) for p in parts), str(e.value)
    with pytest.raises(ValueError, match="R1: the latest arrival .*earliest pick-up 07:30"):
        AU.resolve_participant(net, "rider", dict(a, id="R1", arrive_by=27010), BBOX)
    assert AU.snap_point(net, 10.0081, 20.0079, BBOX)["point"] == pt(2, 2)
    with pytest.raises(ValueError, match="outside the working area"):
        AU.snap_point(net, 10.03, 20.03, BBOX)


# ---------------------------------------------------------------- HTTP: editor payload -> stored scenario -> validated run
def test_editor_payload_to_stored_scenario_to_validated_result(tmp_path):
    c, nid = client(tmp_path)
    login(c, "alice")
    params = dict(n_drivers=6, n_riders=8, seed=11, min_trip_m=300, departure=[27000, 27600], driver_window_s=900,
                  rider_window_s=1500, max_detour_s=1200, max_detour_ratio=1.5, capacity=3,
                  shares=dict(combustion=50, electric=50), profiles=[PETROL, ELECTRIC])
    basis = dict(source="manual", network_id=nid, name="authored scenario", drivers=[], riders=[], authoring=params)
    pv = c.post("/api/geo/scenarios/preview", json=basis)
    assert pv.status_code == 200, pv.text
    pv = pv.json()
    sc = pv["scenario"]
    assert pv["summary"]["drivers"] == 6 and pv["summary"]["riders"] == 8 and pv["summary"]["max_snap_m"] == 0
    assert sc["provenance"]["source"] == "generator" and sc["provenance"]["seed"] == 11
    assert sorted(p["id"] for p in sc["vehicles"]["profiles"]) == ["electric-3p", "petrol-3p"]
    assert c.post("/api/geo/scenarios/preview", json=basis).json()["scenario"] == sc           # reproducible over HTTP
    assert c.get("/api/geo/scenarios").json()["scenarios"] == []                               # nothing stored yet
    # every refusal reaches the editor as a message
    bad = c.post("/api/geo/scenarios/preview", json=dict(basis, authoring=dict(params, shares=dict(combustion=50, electric=30))))
    assert bad.status_code == 400 and "add up to 80 %, not 100 %" in bad.json()["detail"]
    bad = c.post("/api/geo/scenarios/preview", json=dict(basis, authoring=dict(params, bbox=[10.0005, 20.0005, 10.0035, 20.0035])))
    assert bad.status_code == 400 and "contains no road node" in bad.json()["detail"]
    # the editor then changes participants by hand: a rider's pick-up window (checked by the server), a driver moved
    # onto the road network, one more rider, another capacity for one vehicle
    edited = copy.deepcopy(sc)
    r1 = c.post(f"/api/geo/networks/{nid}/participant", json=dict(role="rider", participant=dict(edited["riders"][0], latest=edited["riders"][0]["latest"] + 600)))
    assert r1.status_code == 200, r1.text
    edited["riders"][0] = {k: r1.json()[k] for k in ("id", "origin", "destination", "earliest", "latest")}
    snap = c.get(f"/api/geo/networks/{nid}/snap", params=dict(p="10.0081,20.0079"))
    assert snap.status_code == 200 and snap.json()["point"] == pt(2, 2) and snap.json()["snap_m"] > 0
    edited["drivers"][1]["origin"] = snap.json()["point"]
    out = c.get(f"/api/geo/networks/{nid}/snap", params=dict(p="10.06,20.06"))
    assert out.status_code == 400 and "outside the working area" in out.json()["detail"]
    late = c.post(f"/api/geo/networks/{nid}/participant", json=dict(role="driver", participant=dict(edited["drivers"][0], arrive_by=edited["drivers"][0]["earliest"] + 1)))
    assert late.status_code == 400 and "earlier than the direct travel time allows" in late.json()["detail"]
    assert c.post(f"/api/geo/networks/{nid}/participant", json=dict(role="pilot", participant={})).status_code == 422
    edited["riders"].append(dict(id="R9", origin=pt(1, 1), destination=pt(5, 4), earliest=27000, latest=28200))
    two = AU.with_capacity(next(p for p in edited["vehicles"]["profiles"] if p["id"] == "petrol-3p"), 2)
    edited["vehicles"]["profiles"].append(two)
    edited["vehicles"]["assignments"]["D1"] = two["id"]
    edited["emissions"] = dict(scope="tailpipe", baseline="everyone-drives-alone")
    # Save & Run: the scenario is stored with the generator's provenance (recomputed by the server) and the hand edits
    run = c.post("/api/lab/run", json=dict(title="authored experiment", methods=[list(m) for m in METHODS], repetitions=1,
                                           scenario={k: v for k, v in edited.items() if k != "provenance"}, basis=basis))
    assert run.status_code == 200, run.text
    run = run.json()
    wait(c, run["job"])
    rec = next(s for s in c.get("/api/geo/scenarios").json()["scenarios"] if s["instance_hash"] == run["scenario"]["instance_hash"])
    full = c.get(f"/api/geo/scenarios/{rec['scenario_id']}").json()
    prov = full["scenario"]["provenance"]
    assert prov["source"] == "generator" and prov["generator"] == AU.GENERATOR and prov["seed"] == 11
    assert prov["parameters"]["vehicle_shares"] == dict(combustion=50, electric=50) and prov["parameters"]["capacity"] == 3
    assert prov["edited_agents"] == ["D2", "R9", "R1"] and prov["edited_in"] == "wizard"
    inst = full["instance"]
    assert len(inst["drivers"]) == 6 and len(inst["riders"]) == 9
    assert inst["drivers"][0]["vehicle"]["id"] == "petrol-2p" and inst["drivers"][0]["vehicle"]["passenger_capacity"] == 2
    assert inst["drivers"][1]["origin"] == pt(2, 2)
    # the stored result: every run accepted by the platform's validator, and again by a validation done here from the
    # stored instance and decisions alone
    e = c.get(f"/api/lab/experiments/{run['campaign_id']}").json()
    assert e["validation"]["runs"] == len(METHODS) and e["validation"]["accepted"] == e["validation"]["runs"]
    campaign = c.get(f"/api/campaigns/{run['campaign_id']}").json()
    runs = campaign["campaign"]["runs"]
    problem = registry.get(RIDE)
    for r in runs:
        assert r["instance_hash"] == inst["instance_hash"]
        check = problem.validate(inst, r["decisions"])
        assert check["feasible"] is True and check["metrics"] == r["validation"]["metrics"], check
        pairs = {(p["driver"], p["rider"]) for p in inst["pairs"]}
        chosen = [(d[0], d[1]) for d in r["decisions"]]
        assert set(chosen) <= pairs and len({d for d, _ in chosen}) == len(chosen) == len({x for _, x in chosen})
    assert c.get("/api/geo/scenarios").json()["scenarios"][0]["category"] == "Generated"
