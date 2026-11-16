"""Study views: methods of several locked experiments shown together on the same scenarios, without merging records."""
from fastapi.testclient import TestClient

from test_api import PID, login, make_client, wait

P = dict(sizes=["small"], seeds=[1, 2])


def _locked(c, title, methods, params=P):
    cid = c.post("/api/campaigns", json=dict(problem_id=PID, title=title, scenario_params=params, methods=methods, repetitions=1)).json()["campaign_id"]
    wait(c, c.post(f"/api/campaigns/{cid}/execute").json())
    assert c.post(f"/api/campaigns/{cid}/lock").status_code == 200
    return cid


def test_study_shows_methods_of_two_experiments_with_their_provenance(tmp_path):
    c = make_client(tmp_path, "a"); login(c, "alice")
    a = _locked(c, "exact only", [["exact-milp-highs", "1.0.0"]])
    b = _locked(c, "greedy only", [["greedy-min-cost", "1.0.0"]])
    other = _locked(c, "other scenarios", [["greedy-min-cost", "1.0.0"]], dict(sizes=["small"], seeds=[3]))
    before = {x: c.get(f"/api/campaigns/{x}/record.json").content for x in (a, b)}
    h = c.get(f"/api/campaigns/{a}").json()["campaign"]["scenario_set"]["instance_hashes"]
    body = dict(title="Exact and greedy", members=[dict(campaign_id=a, method_id="exact-milp-highs"),
                                                   dict(campaign_id=b, method_id="greedy-min-cost", label="Greedy", note="second experiment")],
                featured_instance=h[1])
    # refused: scenarios that do not match, a method without results, an unknown featured scenario
    assert c.put("/api/lab/studies", json=dict(body, members=body["members"] + [dict(campaign_id=other, method_id="greedy-min-cost")])).status_code == 400
    assert c.put("/api/lab/studies", json=dict(body, members=[dict(campaign_id=a, method_id="greedy-min-cost")])).status_code == 400
    assert c.put("/api/lab/studies", json=dict(body, featured_instance="0" * 64)).status_code == 400
    st = c.put("/api/lab/studies", json=body).json()
    assert st["members"][1]["experiment"] == "greedy only" and st["members"][0]["locked"] is True
    for cid in (a, b):                                           # either member experiment opens in the study view
        e = c.get(f"/api/lab/experiments/{cid}").json()
        assert e["view"]["mode"] == "study" and e["view"]["study"]["featured_instance"] == h[1]
        rows = e["results"]["rows"]
        assert [(r["campaign_id"], r["method_id"]) for r in rows] == [(a, "exact-milp-highs"), (b, "greedy-min-cost")]
        assert rows[1]["name"] == "Greedy" and rows[1]["note"] == "second experiment" and rows[1]["experiment"] == "greedy only"
        assert rows[1]["method_name"] != "Greedy"                # the record keeps its own name
        assert rows[1]["gap_pct"] is not None                    # compared with the reference of the other experiment
        assert {(r["campaign_id"], r["method_id"]) for r in e["runs"]} == {(a, "exact-milp-highs"), (b, "greedy-min-cost")}
        assert any("different experiments" in x for x in e["results"]["warnings"])
    rec = c.get(f"/api/lab/experiments/{b}", params=dict(view="records")).json()
    assert rec["view"]["mode"] == "records" and [r["campaign_id"] for r in rec["results"]["rows"]] == [b]
    assert rec["view"]["studies"] == [dict(study_id=st["study_id"], title="Exact and greedy")]
    # nothing was written into the frozen records
    assert before == {x: c.get(f"/api/campaigns/{x}/record.json").content for x in (a, b)}
    # another account sees neither the study nor its members
    bob = TestClient(c.app); login(bob, "bob")
    assert bob.get("/api/lab/studies").json()["studies"] == []
    assert bob.put("/api/lab/studies", json=body).status_code == 404
    # update in place, then delete: the experiments stay
    st2 = c.put("/api/lab/studies", json=dict(body, study_id=st["study_id"], title="Renamed study")).json()
    assert st2["study_id"] == st["study_id"] and len(c.get("/api/lab/studies").json()["studies"]) == 1
    assert c.delete(f"/api/lab/studies/{st['study_id']}").json()["ok"] and c.delete(f"/api/lab/studies/{st['study_id']}").status_code == 404
    assert c.get(f"/api/lab/experiments/{a}").json()["view"]["mode"] == "records"
