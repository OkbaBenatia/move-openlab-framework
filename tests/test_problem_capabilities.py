"""Problem presentation capabilities: what the interface may show (map, route playback, served-count semantics) comes
from the problem definition, never from a problem id hard-coded in the core or the interface."""
from move_openlab import registry
from move_openlab.problem import Problem, overrides

from test_api import login, make_client

RIDE = "public-ride-matching"
SYN = "synthetic-capacitated-bipartite-assignment"


class _Geographic(type(registry.get(SYN))):
    """A public test problem: the synthetic problem plus its own route playback."""
    def playback(self, instance, decisions):
        return dict(vehicles=[], unserved=[], t_min=0, t_max=0)


def test_presentation_of_the_public_problems():
    ride, syn = registry.get(RIDE), registry.get(SYN)
    assert ride.presentation() == dict(capabilities=["map", "playback"], participants="riders", served_label="Served riders", authoring_note=None)
    assert syn.presentation() == dict(capabilities=[], participants="passengers", served_label="Served passengers", authoring_note=None)
    assert ride.participant_properties({}) == {} and not ride.restricted and ride.archived_methods() == frozenset() and ride.ml_evaluations("x", {}) == []
    assert ride.describe()["presentation"] == ride.presentation()
    assert not overrides(ride, "playback")              # ride matching uses the built-in mobility planner


def test_implementing_playback_declares_playback_and_map():
    g = _Geographic()
    assert overrides(g, "playback") and g.presentation()["capabilities"] == ["map", "playback"]
    assert Problem.capabilities == frozenset() and Problem.participants is None


def test_scenario_summary_counts_and_served_denominator():
    p = registry.get(RIDE)
    assert p.scenario_summary(dict(drivers=[1, 2], riders=[1, 2, 3], pairs=[])) == dict(drivers=2, riders=3, pairs=0)
    assert p.scenario_summary(dict(riders=[1], served_denominator=7)) == dict(riders=1, served_of=7)
    for bad in (True, -1, 2.5, "7", None):               # only a non-negative integer is a denominator
        assert "served_of" not in p.scenario_summary(dict(riders=[1], served_denominator=bad))


def test_workspace_payload_and_playback_follow_the_capabilities(tmp_path, monkeypatch):
    c = make_client(tmp_path, "caps")
    login(c, "alice")
    r = c.post("/api/lab/demo").json()
    cid = r["root_campaign_id"]
    e = c.get(f"/api/lab/experiments/{cid}").json()
    assert e["problem"]["presentation"] == registry.get(RIDE).presentation()
    assert all("riders" in s and "served_of" not in s for s in e["scenarios"])      # ride matching: out of riders
    run = e["runs"][0]
    assert c.get(f"/api/geo/playback/{cid}/{run['run_id']}").json()["geometry"] == "road"   # built-in planner
    # a problem that draws its own routes is asked for them (here: the ride problem patched for this test)
    seen = {}

    def own(self, instance, decisions):
        seen["n"] = len(decisions)
        return dict(vehicles=[], unserved=[], t_min=0, t_max=0, geometry="own")
    monkeypatch.setattr(type(registry.get(RIDE)), "playback", own, raising=False)
    pb = c.get(f"/api/geo/playback/{cid}/{run['run_id']}").json()
    assert pb["geometry"] == "own" and pb["run_id"] == run["run_id"] and "metrics" in pb and "n" in seen

    def unavailable(self, instance, decisions):
        raise ValueError("no road geometry for this scenario")
    monkeypatch.setattr(type(registry.get(RIDE)), "playback", unavailable, raising=False)
    bad = c.get(f"/api/geo/playback/{cid}/{run['run_id']}")
    assert bad.status_code == 400 and "no road geometry" in bad.json()["detail"]
    # a problem without the capability: refused before any run is looked up
    monkeypatch.setattr(type(registry.get(RIDE)), "capabilities", frozenset(), raising=False)
    monkeypatch.delattr(type(registry.get(RIDE)), "playback", raising=False)
    no = c.get(f"/api/geo/playback/{cid}/{run['run_id']}")
    assert no.status_code == 400 and no.json()["detail"] == "route playback is not available for this problem"
    c.post("/api/auth/logout")
