"""The same public experiment gives every authorized account the same scientific figures. What a result view shows
depends on the experiment, the metrics its problem declares and the validated results — never on the account's role.
The shipped Montbéliard demonstration is opened by an administrator and by a researcher of one installation: metric
availability, validated totals and the CO₂ summary (baseline, emissions, avoided, reduction %, per served rider) are
identical, and the request context changes nothing for a public experiment."""
from fastapi.testclient import TestClient

from move_openlab import demo
from test_admin import admin_client
from test_api import login

ROOT_PW = "Operator-Key-2026-xyz"
CO2 = ("scope", "baseline", "basis", "complete", "baseline_g", "solution_g", "avoided_g", "avoided_pct", "per_served_request_g",
       "per_vehicle_g", "vehicle_km", "vehicles_used")


def _baseline(c, headers=None):
    c.post("/api/lab/demo", headers=headers)
    exps = c.get("/api/lab/experiments", headers=headers).json()["experiments"]
    cid = next(e["campaign_id"] for e in exps if e["demo"] and e["kind"] == "baseline")
    return c.get(f"/api/lab/experiments/{cid}", headers=headers).json()


def _science(e):
    """Everything a result view reads, without what is per account or measured per execution (ids, dates, runtimes)."""
    rows = []
    for r in e["results"]["rows"]:
        per = {h: dict(metrics=c["metrics"], feasible=c["feasible"], accepted=c["accepted"], repetitions=c["repetitions"], optimality=c["optimality"],
                       gap=c["gap_pct"], domain={k: (c["domain"] or {}).get(k) for k in CO2})
               for h, c in sorted(r["per_scenario"].items())}
        rows.append(dict(method=r["method_id"], kind=r["kind"], totals=r["totals"], valid=r["valid"], proven_optimal=r["proven_optimal"], gap=r["gap_pct"],
                         domain={k: (r["domain"] or {}).get(k) for k in CO2}, per_scenario=per))
    p = e["problem"]
    return dict(problem=dict(metrics=p["metrics"], objective=p["objective"], domain_metrics=p["domain_metrics"], facts=p.get("facts"), presentation=p.get("presentation")),
                emissions=e["campaign"]["emissions"], validation=e["validation"], scenarios=[s["instance_hash"] for s in e["scenarios"]], rows=rows)


def test_admin_and_researcher_get_identical_metrics_for_the_public_demonstration(tmp_path):
    if not demo.available():
        import pytest
        pytest.skip("the demonstration bundle is not shipped in this tree")
    root, _auth, _s = admin_client(tmp_path)
    assert root.post("/api/auth/login", json=dict(username="root", password=ROOT_PW)).status_code == 200
    alice = TestClient(root.app)
    login(alice, "alice")
    a, r = _science(_baseline(root)), _science(_baseline(alice))
    assert a == r                                                    # availability and values, cell by cell
    # the CO₂ summary is there for both, with real figures (never an empty or zero placeholder)
    for side in (a, r):
        assert side["emissions"] == dict(scope="operational-energy", baseline="everyone-drives-alone")
        for row in side["rows"]:
            d = row["domain"]
            assert d["complete"] is True and d["baseline_g"] > d["solution_g"] > 0 and d["avoided_g"] > 0 and 0 < d["avoided_pct"] < 100
            assert d["per_served_request_g"] > 0 and abs(d["baseline_g"] - d["solution_g"] - d["avoided_g"]) < 1.0
    # the request context of the public Workspace changes nothing for a public experiment, for either account
    pub = {"X-Move-Context": "public"}
    assert _science(_baseline(root, pub)) == a and _science(_baseline(alice, pub)) == a
    # the administrator of a public installation is an ordinary administrator: no restricted problem, no study
    assert all(not p.get("restricted") for p in root.get("/api/info").json()["problems"])
    assert root.get("/api/lab/studies").json()["studies"] == []
