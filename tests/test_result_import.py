"""Results computed outside the platform: imported as data into a new, locked experiment, every record digest checked,
every decision set re-validated (declared values compared, never trusted), rejected records kept, existing
experiments untouched; the experiment travels in a bundle whose runs are re-validated again on import. Also the
presentation contracts the comparison uses: run facts with their aggregates and problem-supplied display names."""
import pytest

from move_openlab.analysis.compare import aggregate_facts, compare
from move_openlab.hashing import sha256
from move_openlab.methods import ContractError
from move_openlab.store import BenchError, Installation, IntegrityError

from conftest import A_B, PROBLEM_ID

EXACT = "exact-milp-highs"


@pytest.fixture
def ws(tmp_path):
    w = Installation(tmp_path / "a", None, "inst-A").workspace("r1", "Researcher 1")
    c = w.create_campaign(PROBLEM_ID, "computed here", dict(sizes=["small"], seeds=[1, 2]), A_B, repetitions=1)
    w.execute(c["campaign_id"])
    return w, w.lock(c["campaign_id"])


def _records(base, **change):
    out = []
    for r in base["runs"]:
        if r["method_id"] != EXACT:
            continue
        body = dict(instance_hash=r["instance_hash"], method_id=EXACT, decisions=r["decisions"], status_declared=r["status_declared"],
                    declared=dict(cost=r["validation"]["metrics"]["cost"]), solver_time_s=1.5, total_time_s=2.0,
                    method_metadata=dict(runner="external archive"), executed_at="2026-01-01T00:00:00+00:00")
        body.update(change)
        out.append(dict(body, record_sha256=sha256(body)))
    return out


def _import(w, base, records, **kw):
    return w.import_results(PROBLEM_ID, "imported", base["scenario_set"]["instance_hashes"], [(EXACT, "1.0.0")], records,
                            dict(name="external archive", executed_by="another machine"), **kw)


def test_imported_results_are_revalidated_and_kept_apart(ws):
    w, base = ws
    before = {c["campaign_id"]: c["checksum"] for c in w.list()}
    c = _import(w, base, _records(base))
    assert c["status"] == "locked" and c["checksum"]
    assert c["result_import"]["counts"] == dict(records=2, validated=2, rejected=0, declared_objective_mismatches=0, missing_cells=0)
    assert {r["origin"] for r in c["runs"]} == {"imported-external"} and {r["isolation"] for r in c["runs"]} == {"external"}
    assert all(r["accepted"] and r["validation"]["feasible"] for r in c["runs"])
    assert {k: w.get(k)["checksum"] for k in before} == before                # nothing else changed
    row = compare(w, c["campaign_id"])["rows"][0]
    assert row["origin"].startswith("imported results") and "not executed here" in row["origin"]


def test_tampered_or_undeclared_records_are_refused_without_side_effects(ws):
    w, base = ws
    n = len(w.list())
    recs = _records(base)
    recs[0]["declared"] = dict(cost=-1.0)                                # content changed, digest not
    with pytest.raises(IntegrityError, match="record_sha256"):
        _import(w, base, recs)
    with pytest.raises(BenchError, match="unknown fields"):
        _import(w, base, [dict(r, extra=1) for r in _records(base)])
    with pytest.raises(BenchError, match="same scenario and method"):
        _import(w, base, _records(base) * 2)
    with pytest.raises(ContractError, match="unknown method"):
        w.import_results(PROBLEM_ID, "x", base["scenario_set"]["instance_hashes"], [("no-such-method", "1.0.0")], _records(base), dict(name="x"))
    assert len(w.list()) == n


def test_wrong_declared_values_or_missing_decisions_are_rejected_not_dropped(ws):
    w, base = ws
    recs = _records(base)
    bad = dict(recs[0], declared=dict(cost=recs[0]["declared"]["cost"] + 1.0))
    empty = dict(recs[1], decisions=[])
    c = _import(w, base, [dict(bad, record_sha256=sha256({k: v for k, v in bad.items() if k != "record_sha256"})),
                          dict(empty, record_sha256=sha256({k: v for k, v in empty.items() if k != "record_sha256"}))])
    assert c["result_import"]["counts"]["rejected"] == 2 and c["result_import"]["counts"]["declared_objective_mismatches"] == 1
    assert len(c["runs"]) == 2 and not any(r["accepted"] for r in c["runs"])
    assert any("declared cost differs" in e for r in c["runs"] for e in r["output_errors"])


def test_an_imported_result_bundle_is_revalidated_on_import(ws, tmp_path):
    w, base = ws
    c = _import(w, base, _records(base))
    data, _ = w.export_bundle(c["campaign_id"])
    w2 = Installation(tmp_path / "b", None, "inst-B").workspace("r2", "Researcher 2")
    rep = w2.import_bundle(data)
    assert rep["revalidation"]["runs"] == rep["revalidation"]["confirmed"] == 2
    got = w2.get(c["campaign_id"])
    assert got["checksum"] == c["checksum"] and {r["origin"] for r in got["runs"]} == {"imported-external"}


def test_fact_aggregates():
    defs = [dict(id="n", aggregate="sum"), dict(id="m", aggregate="median"), dict(id="pct", aggregate="ratio", of=["k", "n"]),
            dict(id="status", aggregate="none"), dict(id="partial", aggregate="sum")]
    per = [dict(n=10, k=5, m=1.0, status="a", partial=1), dict(n=30, k=5, m=3.0, status="b"), dict(n=60, k=40, m=2.0, status="c", partial=2)]
    assert aggregate_facts(defs, per) == dict(n=100, m=2.0, pct=50.0, partial=None)   # none never aggregated; missing → None
    assert aggregate_facts(defs[:1], [dict(n=True)]) == dict(n=None)                    # booleans are not numbers


def test_display_names_and_facts_reach_the_comparison(ws, monkeypatch):
    w, base = ws
    cls = type(__import__("move_openlab.registry", fromlist=["get"]).get(PROBLEM_ID))
    monkeypatch.setattr(cls, "method_display_name", lambda self, mid, cfg: "Exact (display name)" if mid == EXACT else None)
    monkeypatch.setattr(cls, "run_fact_definitions", lambda self: [dict(id="t2", label="Twice the solver time", unit="s", kind="number",
                                                                         aggregate="sum", group="Runtime")])
    monkeypatch.setattr(cls, "run_facts", lambda self, run, inst: dict(t2=2 * (run.get("solver_time_s") or 0)))
    rows = {r["method_id"]: r for r in compare(w, base["campaign_id"])["rows"]}
    assert rows[EXACT]["name"] == "Exact (display name)" and rows[EXACT]["recorded_name"] != rows[EXACT]["name"]
    assert rows["greedy-min-cost"]["name"] == rows["greedy-min-cost"]["recorded_name"]   # no alias: the recorded name
    per = rows[EXACT]["per_scenario"]
    assert rows[EXACT]["facts"]["t2"] == pytest.approx(sum(c["facts"]["t2"] for c in per.values()), abs=1e-6)
