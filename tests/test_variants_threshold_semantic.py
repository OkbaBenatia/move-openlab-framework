"""Controlled variants, semantic comparability decisions and candidate-pruning threshold studies."""
import pytest

from conftest import baseline
from move_openlab.analysis.semantic import semantic_compare
from move_openlab.analysis.threshold import threshold_report
from move_openlab.benchmarks.synthetic_assignment import generator, variants
from move_openlab.store import BenchError


def _ws(installations):
    return installations[0].workspace("researcher1", "Researcher 1")


@pytest.mark.parametrize("variant,quality", [("capacity-binding", "INCOMPATIBLE"), ("capacity-nonbinding", "DIRECT"),
                                              ("temporal-tightening", "INCOMPATIBLE"), ("metadata-only", "DIRECT"),
                                              ("time-budget-1s", "CONDITIONAL")])
def test_variant_semantic_decisions(installations, variant, quality):
    w = _ws(installations)
    base = baseline(w, reps=1)
    v = w.create_variant(base["campaign_id"], variant)
    assert v["parent"]["checksum"] == base["checksum"] and v["kind"] == "variant"
    w.execute(v["campaign_id"])
    d = semantic_compare(w, base["campaign_id"], v["campaign_id"])
    cand = [r for r in d["rows"] if r["side"] == "candidate campaign"]
    assert cand and {r["quality"]["status"] for r in cand} == {quality}
    if variant in ("capacity-nonbinding", "metadata-only"):
        assert all(not r["raw_hash_equal"] and r["problem_fingerprint"]["reference"] == r["problem_fingerprint"]["candidate"]
                   for r in cand)                                  # file changed, problem unchanged
        assert all(r["quality"]["notes"] for r in cand)
    assert w.get(base["campaign_id"]) == base


def test_variant_operators_preserve_or_change_the_feasible_set_as_claimed(problem):
    from move_openlab.comparability.model import problem_fingerprint
    for seed in generator.SEEDS:
        inst = generator.generate("medium", seed)
        fp = problem_fingerprint(problem, inst, problem.objective_spec_id)["problem"]
        for vid, same in (("capacity-nonbinding", True), ("temporal-nonbinding", True), ("metadata-only", True),
                          ("capacity-binding", False), ("temporal-tightening", False)):
            child = variants.variants()[vid].apply(inst)
            if child is None:
                continue
            assert problem.check_instance(child) == []
            assert (problem_fingerprint(problem, child, problem.objective_spec_id)["problem"] == fp) is same, (vid, seed)


def test_runtime_claim_across_installations_is_conditional_only_if_environment_differs(installations):
    instA, instB = installations
    r1 = instA.workspace("researcher1", "Researcher 1"); r2 = instB.workspace("researcher2", "Researcher 2")
    base = baseline(r1, reps=1)
    data, _ = r1.export_bundle(base["campaign_id"])
    r2.import_bundle(data)
    repro = r2.create_reproduction(base["campaign_id"]); r2.execute(repro["campaign_id"])
    d = semantic_compare(r2, base["campaign_id"], repro["campaign_id"])
    assert {r["quality"]["status"] for r in d["rows"]} == {"DIRECT"}       # same machine: same environment descriptor


def test_threshold_study(installations):
    w = _ws(installations)
    base = baseline(w, reps=1)
    st = w.create_threshold_study(base["campaign_id"], ("exact-milp-highs", "1.0.0"), "relative-cost", [0.9, 0.5, 0.0])
    assert st["threshold_study"]["thresholds"] == [0.0, 0.5, 0.9]
    w.execute(st["campaign_id"])
    rep = threshold_report(w, st["campaign_id"])
    by_t = {s["threshold"]: s for s in rep["summary"]}
    assert by_t[0.0]["mean_kept_share"] == 1.0 and by_t[0.0]["equal_objective"] == by_t[0.0]["cells"] == 4
    assert by_t[0.9]["mean_kept_share"] < by_t[0.5]["mean_kept_share"] <= 1.0
    assert all(s["feasible_on_original"] == s["cells"] for s in rep["summary"])   # pruning never breaks feasibility
    assert all(r["final_level_gap_pct"] is None or r["final_level_gap_pct"] >= 0 for r in rep["rows"])
    with pytest.raises(BenchError):
        w.create_threshold_study(base["campaign_id"], ("exact-milp-highs", "1.0.0"), "unknown", [0.5])
    with pytest.raises(BenchError):
        w.create_threshold_study(base["campaign_id"], ("exact-milp-highs", "1.0.0"), "relative-cost", [float("nan")])


def test_top_k_selection_is_per_group():
    from move_openlab.scoring import select
    cands = [dict(id=f"{d}|{p}", groups=[f"D:{d}", f"P:{p}"]) for d in "AB" for p in "xyz"]
    scores = {"A|x": .9, "A|y": .8, "A|z": .1, "B|x": .2, "B|y": .3, "B|z": .05}
    assert select(cands, scores, None, 1) == {"A|x", "B|y", "A|y", "A|z"}            # best of each driver and passenger
    assert select(cands, scores, 0.25, None) == {"A|x", "A|y", "B|y"}
    assert select(cands, {k: None for k in scores}, 0.99, 1) == set(scores)          # unscored -> kept


def test_dynamic_share_thresholds_and_reduction_metrics(installations):
    w = _ws(installations)
    base = baseline(w, reps=1)
    st = w.create_threshold_study(base["campaign_id"], ("exact-milp-highs", "1.0.0"), "relative-cost", [0.5, 1.0], mode="share")
    assert st["threshold_study"]["mode"] == "share"
    cells = st["threshold_study"]["cells"]
    half = [c for c in cells if c["threshold"] == 0.5]
    assert all(c["candidates_kept"] >= c["candidates_total"] / 2 for c in half)          # ties at the cut-off are kept
    assert all(c["effective_threshold"] is not None for c in half)
    assert all(c["candidates_kept"] == c["candidates_total"] for c in cells if c["threshold"] == 1.0)
    w.execute(st["campaign_id"])
    rep = threshold_report(w, st["campaign_id"])
    s_half = next(s for s in rep["summary"] if s["threshold"] == 0.5)
    assert 0 < s_half["mean_reduction_pct"] <= 50 and s_half["effective_threshold"]["n"] == 4
    assert set(s_half["optimality_scope"]) == {"optimal for the reduced instance only"}  # never a full-problem proof
    with pytest.raises(BenchError):
        w.create_threshold_study(base["campaign_id"], ("exact-milp-highs", "1.0.0"), "relative-cost", [1.5], mode="share")


def test_optimality_scope_labels(installations):
    from move_openlab.analysis.common import SCOPE_FULL, SCOPE_HEURISTIC, scope_counts
    from move_openlab.analysis.compare import compare
    w = _ws(installations)
    base = baseline(w, reps=1)
    sc = scope_counts(w, base)
    assert sc == {"exact-milp-highs": {SCOPE_FULL: 4}, "greedy-min-cost": {SCOPE_HEURISTIC: 4}}
    rows = {r["method_id"]: r for r in compare(w, base["campaign_id"])["rows"]}
    assert rows["exact-milp-highs"]["optimality_scope"] == {SCOPE_FULL: 4}


def test_select_share_keeps_ties_and_unscored():
    from move_openlab.scoring import select_share
    cands = [dict(id=x) for x in "abcde"]
    keep, cut = select_share(cands, {"a": .9, "b": .5, "c": .5, "d": .1, "e": None}, 0.25)
    assert cut == 0.9 and keep == {"a", "e"}
    keep, cut = select_share(cands, {"a": .9, "b": .5, "c": .5, "d": .1, "e": None}, 0.5)
    assert cut == 0.5 and keep == {"a", "b", "c", "e"}                                    # tie at the cut-off kept
