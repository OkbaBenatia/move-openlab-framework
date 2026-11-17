"""ML evaluation from evidence: the metric mathematics against hand-computed values (ties, a single class, undefined
denominators, the threshold sweep), every refusal of the evidence format, the metric registry (including an adapter
that fails), the public synthetic example, and the HTTP workflow on an experiment with a learned method."""
import copy
import hashlib
import json
import math
import os
import shutil
import stat
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from move_openlab import registry
from move_openlab.analysis import ml_evaluation as ML
from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.methods import check_metadata
from move_openlab.plugins import read_plugin_metadata
from move_openlab.store import campaign_checksum
from test_api import PW, login, make_settings, wait

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "ml-evaluation"
RIDE = "public-ride-matching"
LEARNED = "example-scored-filter-greedy"
ROOT_PW = "Operator-Key-2026-xyz"
KNOWN = dict(tp=96, fn=24, fp=28, tn=252)                          # the synthetic example at its recorded threshold

# eight records computed by hand below: (label, score)
HAND = [(1, .9), (1, .8), (0, .8), (1, .6), (0, .5), (0, .4), (1, .3), (0, .1)]


def doc(records=None, **over) -> dict:
    d = dict(format=ML.FORMAT, method_id=LEARNED,
             model=dict(name="test scorer", version="1.0.0"),
             feature_pipeline=dict(name="two features", version="1.0.0", description="relative detour and pickup time"),
             dataset=dict(id="hand-set", split="test", population="eight hand-made records", unit="one candidate pair"),
             positive_label="the pair is used by the reference solution",
             decision=dict(rule="score>=threshold", threshold=0.5),
             records=records if records is not None else [dict(id=f"r{i}", label=y, score=s) for i, (y, s) in enumerate(HAND)],
             notes="made for the tests")
    d.update(over)
    return d


def evaluate(d: dict, threshold=None) -> dict:
    return ML.evaluate(ML.validate(d), threshold)


# ---------------------------------------------------------------------------------------------- metric mathematics
def test_confusion_and_metrics_match_hand_computed_values():
    """Threshold 0.5 keeps .9 .8 .8 .6 .5 -> TP 3 (.9 .8 .6), FP 2 (.8 .5), FN 1 (.3), TN 2 (.4 .1)."""
    ev = evaluate(doc())
    assert ev["confusion"] == dict(tp=3, fn=1, fp=2, tn=2)
    m = ev["metrics"]
    assert list(m) == list(ML.CORE)
    assert m["accuracy"] == pytest.approx(5 / 8) and m["precision"] == pytest.approx(3 / 5)
    assert m["recall"] == pytest.approx(3 / 4) and m["specificity"] == pytest.approx(2 / 4)
    assert m["balanced_accuracy"] == pytest.approx(0.625) and m["f1"] == pytest.approx(6 / 9)
    # ROC-AUC by pairs: .9 beats 4 negatives; .8 beats 3 and ties one (.8); .6 beats 3; .3 beats 1 -> 11.5 of 16
    assert m["roc_auc"] == pytest.approx(11.5 / 16)
    # average precision over distinct scores: .9 -> 1/1, .8 (tie of a positive and a negative) -> 2/3, .6 -> 3/4, .3 -> 4/7
    assert m["pr_auc"] == pytest.approx(0.25 * (1 + 2 / 3 + 3 / 4 + 4 / 7))
    assert ev["metric_reasons"] == {} and ev["positives"] == 4 and ev["prevalence_pct"] == 50.0 and ev["candidates"] == 8
    mcc = next(x for x in ev["extra_metrics"] if x["id"] == "mcc")
    assert mcc["value"] == pytest.approx(4 / math.sqrt(240)) and mcc["source"] == "builtin"
    assert ev["decision"] == "score >= 0.5" and ev["threshold_adjustable"] and not ev["exploratory"]
    assert ev["population"] == "eight hand-made records" and ev["split"] == "test" and ev["unit"] == "one candidate pair"
    assert ev["provenance"]["model"]["name"] == "test scorer" and ev["provenance"]["feature_pipeline"]["version"] == "1.0.0"


def test_ties_share_their_rank_and_are_taken_together():
    labels, scores = [1, 0, 1, 0], [0.5, 0.5, 0.5, 0.5]
    assert ML.roc_auc(labels, scores) == pytest.approx(0.5)          # every pair is a tie: one half each
    assert ML.average_precision(labels, scores) == pytest.approx(0.5)  # one group: precision 2/4 at recall 1
    assert ML.roc_auc([1, 1, 0, 0], [0.9, 0.8, 0.2, 0.1]) == 1.0 and ML.roc_auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]) == 0.0
    assert ML.roc_auc([1, 0, 0], [0.7, 0.7, 0.1]) == pytest.approx(0.75)   # a tie and a win
    # the order of tied records never changes a figure
    a = evaluate(doc([dict(id="a", label=1, score=.8), dict(id="b", label=0, score=.8), dict(id="c", label=0, score=.2)]))
    b = evaluate(doc([dict(id="b", label=0, score=.8), dict(id="a", label=1, score=.8), dict(id="c", label=0, score=.2)]))
    assert a["metrics"] == b["metrics"] and a["metrics"]["pr_auc"] == pytest.approx(0.5)


def test_the_lower_is_positive_rule_gives_the_same_figures_on_mirrored_scores():
    mirrored = doc([dict(id=f"r{i}", label=y, score=round(1 - s, 6)) for i, (y, s) in enumerate(HAND)],
                   decision=dict(rule="score<=threshold", threshold=0.5))
    a, b = evaluate(doc()), evaluate(mirrored)
    assert b["confusion"] == a["confusion"] and b["decision"] == "score <= 0.5"
    for k in ML.CORE:
        assert b["metrics"][k] == pytest.approx(a["metrics"][k])


def test_a_single_class_is_undefined_with_a_reason_never_zero():
    only_pos = evaluate(doc([dict(id="a", label=1, score=.9), dict(id="b", label=1, score=.2)]))
    m, why = only_pos["metrics"], only_pos["metric_reasons"]
    assert m["recall"] == 0.5 and m["precision"] == 1.0 and m["accuracy"] == 0.5
    assert m["specificity"] is None and m["balanced_accuracy"] is None and m["roc_auc"] is None
    assert "no negative" in why["specificity"] and "only one class" in why["balanced_accuracy"] and "only one class" in why["roc_auc"]
    only_neg = evaluate(doc([dict(id="a", label=0, score=.9), dict(id="b", label=0, score=.2)]))
    m, why = only_neg["metrics"], only_neg["metric_reasons"]
    assert m["specificity"] == 0.5 and m["precision"] == 0.0             # one predicted positive, none correct: a defined 0
    assert m["recall"] is None and m["f1"] is None and m["pr_auc"] is None and m["roc_auc"] is None
    assert "no positive" in why["recall"] and "recall is undefined" in why["f1"] and "no positive" in why["pr_auc"]
    assert next(x for x in only_neg["extra_metrics"] if x["id"] == "mcc")["value"] is None


def test_a_zero_denominator_is_undefined_and_a_true_zero_stays_zero():
    nothing_kept = evaluate(doc(decision=dict(rule="score>=threshold", threshold=0.95)))
    assert nothing_kept["confusion"] == dict(tp=0, fn=4, fp=0, tn=4)
    m, why = nothing_kept["metrics"], nothing_kept["metric_reasons"]
    assert m["precision"] is None and m["f1"] is None and m["recall"] == 0.0 and m["specificity"] == 1.0
    assert "no record is predicted positive" in why["precision"] and "precision is undefined" in why["f1"]
    all_wrong = ML.confusion_metrics(dict(tp=0, fn=2, fp=3, tn=0))[0]
    assert all_wrong["precision"] == 0.0 and all_wrong["recall"] == 0.0 and all_wrong["f1"] == 0.0 and all_wrong["accuracy"] == 0.0
    with pytest.raises(ValueError):
        ML.confusion([1, 0], [1])


def test_hard_predictions_without_scores_give_no_auc_and_no_threshold():
    recs = [dict(id="a", label=1, prediction=1), dict(id="b", label=1, prediction=0), dict(id="c", label=0, prediction=0),
            dict(id="d", label=0, prediction=1), dict(id="e", label=0, prediction=0)]
    ev = evaluate(doc(recs, decision=dict(rule="predictions", policy="top 2 per rider")), threshold=0.3)
    assert ev["confusion"] == dict(tp=1, fn=1, fp=1, tn=2) and ev["metrics"]["accuracy"] == pytest.approx(0.6)
    assert ev["metrics"]["pr_auc"] is None and ev["metrics"]["roc_auc"] is None
    assert "no score" in ev["metric_reasons"]["pr_auc"] and "no score" in ev["metric_reasons"]["roc_auc"]
    assert not ev["threshold_adjustable"] and not ev["exploratory"] and ev["sweep"] == [] and ev["threshold"] is None
    assert ev["decision"] == "hard predictions provided with the evidence (top 2 per rider)"
    # predictions with a score for every record: the scores give the two areas, the predictions give the matrix
    scored = [dict(r, score=s) for r, s in zip(recs, (.9, .4, .3, .8, .1))]
    ev = evaluate(doc(scored, decision=dict(rule="predictions")))
    assert ev["metrics"]["roc_auc"] == pytest.approx(5 / 6) and ev["confusion"]["tp"] == 1 and not ev["threshold_adjustable"]


def test_the_sweep_is_exact_at_each_threshold_and_bounded():
    labels, scores = [y for y, _ in HAND], [s for _, s in HAND]
    sw = ML.sweep(labels, scores)
    assert [p["threshold"] for p in sw] == [.1, .3, .4, .5, .6, .8, .9]
    at = {p["threshold"]: p for p in sw}
    assert at[.8] == dict(threshold=.8, precision=pytest.approx(2 / 3, abs=1e-6), recall=.5, f1=pytest.approx(4 / 7, abs=1e-6), kept_share=.375)
    assert at[.1]["kept_share"] == 1.0 and at[.1]["recall"] == 1.0 and at[.1]["precision"] == 0.5
    assert at[.5]["precision"] == 0.6 and at[.5]["recall"] == 0.75                    # the recorded decision of doc()
    beyond = ML.sweep(labels, scores, include=(0.95,))[-1]
    assert beyond["threshold"] == 0.95 and beyond["precision"] is None and beyond["f1"] is None and beyond["recall"] == 0.0
    low = ML.sweep(labels, [round(1 - s, 6) for s in scores], rule="score<=threshold")
    assert [p["kept_share"] for p in low] == sorted(p["kept_share"] for p in low)        # more is kept as the bound rises
    many = [i / 5000 for i in range(5000)]
    big = ML.sweep([i % 3 == 0 for i in range(5000)], many)
    assert len(big) == ML.MAX_SWEEP_POINTS and big[0]["threshold"] == many[0] and big[-1]["threshold"] == many[-1]
    assert [p["threshold"] for p in big] == sorted(p["threshold"] for p in big)
    assert [p["kept_share"] for p in big] == sorted((p["kept_share"] for p in big), reverse=True)
    ev = evaluate(doc())
    assert ev["sweep"] == sw and ev["score_range"] == [.1, .9]
    with pytest.raises(ValueError):
        ML.sweep(labels, scores, rule="predictions")


def test_an_exploratory_threshold_keeps_the_recorded_decision():
    ev = evaluate(doc(), threshold=0.8)
    assert ev["exploratory"] and ev["threshold"] == 0.8 and ev["confusion"] == dict(tp=2, fn=2, fp=1, tn=3)
    assert "exploratory" in ev["decision"] and ev["metrics"]["precision"] == pytest.approx(2 / 3)
    rec = ev["recorded_decision"]
    assert rec["threshold"] == 0.5 and rec["confusion"] == dict(tp=3, fn=1, fp=2, tn=2) and rec["decision"] == "score >= 0.5"
    assert rec["metrics"]["precision"] == pytest.approx(0.6)
    assert ev["metrics"]["roc_auc"] == rec["metrics"]["roc_auc"]                        # the areas do not depend on it
    assert not evaluate(doc(), threshold=0.5)["exploratory"]
    with pytest.raises(ML.EvidenceError):
        evaluate(doc(), threshold=float("nan"))


# ---------------------------------------------------------------------------------------------- evidence validation
def _set(path: str, value):
    def change(d):
        keys = path.split(".")
        cur = d
        for k in keys[:-1]:
            cur = cur[int(k)] if isinstance(cur, list) else cur[k]
        last = int(keys[-1]) if isinstance(cur, list) else keys[-1]
        if value is _DROP:
            del cur[last]
        else:
            cur[last] = value
    return change


_DROP = object()
REFUSALS = [
    (_set("records.2.label", 2), "label must be 0 or 1"),
    (_set("records.2.label", 0.5), "label must be 0 or 1"),
    (_set("records.2.label", True), "label must be 0 or 1"),
    (_set("records.2.label", "1"), "label must be 0 or 1"),
    (_set("records.2.label", _DROP), "has no label"),
    (_set("records.2.label", None), "has no label"),
    (_set("records.1.score", float("nan")), "not a finite number"),
    (_set("records.1.score", float("inf")), "not a finite number"),
    (_set("records.1.score", "0.4"), "score must be a number"),
    (_set("records.3.id", "r0"), "duplicate id 'r0'"),
    (_set("records.3.id", ""), "has no id"),
    (_set("records", []), "no record"),
    (_set("records", "x"), "records must be a list"),
    (_set("records.4.score", _DROP), "neither a score nor a prediction"),
    (_set("records.4.prediction", 2), "prediction must be 0 or 1"),
    (_set("records.0.prediction", 0), "contradicts the decision rule"),
    (_set("records.0.weight", 1), "unknown field"),
    (_set("decision.threshold", _DROP), "threshold is missing"),
    (_set("decision.threshold", float("nan")), "finite number"),
    (_set("decision.rule", "score>threshold"), "decision.rule must be one of"),
    (_set("decision", _DROP), "decision.rule must be one of"),
    (_set("dataset", _DROP), "missing dataset provenance: dataset.id, dataset.split, dataset.population, dataset.unit"),
    (_set("dataset.split", " "), "missing dataset provenance: dataset.split"),
    (_set("dataset.population", _DROP), "missing dataset provenance: dataset.population"),
    (_set("dataset.unit", _DROP), "missing dataset provenance: dataset.unit"),
    (_set("model", _DROP), "missing model provenance: model.name, model.version"),
    (_set("model.version", _DROP), "missing model provenance: model.version"),
    (_set("model.sha256", "abc"), "model.sha256 must be 64"),
    (_set("feature_pipeline", _DROP), "missing feature pipeline provenance"),
    (_set("feature_pipeline.description", ""), "missing feature pipeline provenance: feature_pipeline.description"),
    (_set("positive_label", _DROP), "missing positive_label"),
    (_set("method_id", _DROP), "missing method_id"),
    (_set("format", "something-else@1"), "format must be"),
    (_set("results", {}), "unknown field"),
    (_set("notes", 3), "notes must be"),
]


@pytest.mark.parametrize("change,message", REFUSALS, ids=[m for _, m in REFUSALS])
def test_invalid_evidence_is_refused_with_a_clear_message(change, message):
    d = doc()
    change(d)
    with pytest.raises(ML.EvidenceError, match=message.replace("(", r"\(")) as e:
        ML.validate(d)
    assert e.value.status == 422


def test_rule_specific_and_size_refusals(monkeypatch):
    preds = [dict(id="a", label=1, prediction=1), dict(id="b", label=0, score=0.2)]
    with pytest.raises(ML.EvidenceError, match="has no prediction"):
        ML.validate(doc(preds, decision=dict(rule="predictions")))
    partial = [dict(id="a", label=1, prediction=1, score=.9), dict(id="b", label=0, prediction=0)]
    with pytest.raises(ML.EvidenceError, match="scores are given for 1 of 2 records"):
        ML.validate(doc(partial, decision=dict(rule="predictions")))
    with pytest.raises(ML.EvidenceError, match="threshold is not used"):
        ML.validate(doc(partial[:1], decision=dict(rule="predictions", threshold=0.5)))
    with pytest.raises(ML.EvidenceError, match="has no score, and the decision rule"):
        ML.validate(doc([dict(id="a", label=1, prediction=1)]))
    with pytest.raises(ML.EvidenceError, match="must be a JSON object"):
        ML.validate([1, 2])
    # JSON text: NaN and Infinity literals are read, then refused; broken or empty files say so
    text = json.dumps(doc()).replace('"score": 0.9', '"score": NaN')
    with pytest.raises(ML.EvidenceError, match="not a finite number"):
        ML.validate(ML.parse_json(text.encode()))
    for raw, msg in ((b"", "empty file"), (b"  \n", "empty file"), (b"{not json", "not valid UTF-8 JSON"), (b"\xff\xfe{}", "not valid UTF-8 JSON")):
        with pytest.raises(ML.EvidenceError, match=msg):
            ML.parse_json(raw)
    monkeypatch.setattr(ML, "MAX_RECORDS", 5)
    with pytest.raises(ML.EvidenceError, match="too many records: 8") as e:
        ML.validate(doc())
    assert e.value.status == 413
    monkeypatch.setattr(ML, "MAX_EVIDENCE_BYTES", 100)
    with pytest.raises(ML.EvidenceError, match="file larger than") as e:
        ML.parse_json(json.dumps(doc()).encode())
    assert e.value.status == 413


def test_valid_evidence_is_normalised():
    d = doc([dict(id=7, label=1.0, score=1), dict(id=" b ", label=0, score=0.25, prediction=0)],
            notes=["  two   spaces ", ""], model=dict(name=" m ", version="2", sha256="a" * 64, training_data="none"))
    v = ML.validate(d)
    assert v["records"] == [dict(id="7", label=1, score=1.0), dict(id="b", label=0, score=0.25, prediction=0)]
    assert v["notes"] == ["two spaces"] and v["model"] == dict(name="m", version="2", sha256="a" * 64, training_data="none")
    assert ML.validate(copy.deepcopy(v)) == v                                        # validation is idempotent


CSV = "id,label,score\n" + "".join(f"r{i},{y},{s}\n" for i, (y, s) in enumerate(HAND))


def meta() -> dict:
    return {k: v for k, v in doc().items() if k not in ("records", "format")}


def test_csv_records_give_the_same_evaluation_as_json():
    ev = ML.evaluate(ML.validate(ML.from_csv(CSV.encode(), meta())))
    ref = evaluate(doc())
    assert ev["confusion"] == ref["confusion"] and ev["metrics"] == ref["metrics"] and ev["sweep"] == ref["sweep"]
    reordered = "﻿Score, Prediction ,ID,Label\r\n0.9,1,a,1\r\n\r\n0.2,0,b,0\r\n"
    v = ML.validate(ML.from_csv(reordered.encode(), meta()))
    assert v["records"] == [dict(id="a", label=1, score=.9, prediction=1), dict(id="b", label=0, score=.2, prediction=0)]
    hard = ML.validate(ML.from_csv(b"id,label,prediction\na,1,1\nb,0,1\n", dict(meta(), decision=dict(rule="predictions"))))
    assert ML.evaluate(hard)["confusion"] == dict(tp=1, fn=0, fp=1, tn=0)


@pytest.mark.parametrize("text,message", [
    ("", "empty file"), ("\n\n", "empty file"),
    ("id,label,score,weight\na,1,0.5,2\n", "unexpected CSV column"),
    ("id,score\na,0.5\n", "missing CSV column"),
    ("id,label\na,1\n", "needs a score column, a prediction column"),
    ("id,label,score\na,1\n", "CSV line 2: 2 values for 3 columns"),
    ("id,label,score\na,2,0.5\n", "CSV line 2: label must be 0 or 1"),
    ("id,label,score\na,yes,0.5\n", "CSV line 2: label must be 0 or 1"),
    ("id,label,score\na,1,high\n", "is not a number"),
    ("id,label,score\na,1,nan\n", "not a finite number"),
    ("id,label,score\na,1,inf\n", "not a finite number"),
    ("id,label,score\na,,0.5\n", "has no label"),
    ("id,label,score\na,1,\n", "neither a score nor a prediction"),
    ("id,label,score\na,1,0.5\na,0,0.4\n", "duplicate id 'a'"),
    ("id,label,score\n", "no record"),
    ("id,label,score,label\na,1,0.5,1\n", "appears twice"),
])
def test_invalid_csv_is_refused(text, message):
    with pytest.raises(ML.EvidenceError, match=message):
        ML.validate(ML.from_csv(text.encode(), meta()))


def test_csv_needs_its_metadata(monkeypatch):
    with pytest.raises(ML.EvidenceError, match="missing method_id"):
        ML.validate(ML.from_csv(CSV.encode(), {}))
    with pytest.raises(ML.EvidenceError, match="must be a JSON object"):
        ML.from_csv(CSV.encode(), "x")
    with pytest.raises(ML.EvidenceError, match="must not contain records"):
        ML.from_csv(CSV.encode(), dict(meta(), records=[]))
    with pytest.raises(ML.EvidenceError, match="not UTF-8"):
        ML.from_csv(b"id,label,score\n\xff,1,0.5\n", meta())
    monkeypatch.setattr(ML, "MAX_RECORDS", 3)
    with pytest.raises(ML.EvidenceError, match="too many records") as e:
        ML.from_csv(CSV.encode(), meta())
    assert e.value.status == 413


# ---------------------------------------------------------------------------------------------- metric registry
@pytest.fixture
def clean_registry(monkeypatch):
    monkeypatch.setattr(ML, "_extra", {})
    monkeypatch.setattr(ML, "_errors", {})
    monkeypatch.setattr(ML, "_loaded", True)                    # no installed adapter interferes with these tests


def test_registered_metrics_are_computed_and_a_failing_one_does_not_break_the_evaluation(clean_registry):
    def boom(ctx):
        raise RuntimeError("adapter bug")

    ML.register_metric(ML.ClassificationMetric("npv", "Negative predictive value", lambda c: c["tn"] / (c["tn"] + c["fn"])))
    ML.register_metric(dict(id="always_fails", label="Always fails", compute=boom))
    ML.register_metric(dict(id="not_a_number", label="Not a number", compute=lambda c: float("nan")))
    ML.register_metric(dict(id="says_why", label="Says why", compute=lambda c: (None, "needs at least 100 records")))
    ML.register_metric(dict(id="uses_scores", label="Mean score", compute=lambda c: sum(c["scores"]) / c["n"], needs_scores=True))
    ev = evaluate(doc())
    extra = {x["id"]: x for x in ev["extra_metrics"]}
    assert extra["npv"]["value"] == pytest.approx(2 / 3) and extra["npv"]["reason"] is None and extra["npv"]["source"] == "registered"
    assert extra["always_fails"]["value"] is None and "RuntimeError: adapter bug" in extra["always_fails"]["reason"]
    assert extra["not_a_number"]["value"] is None and "finite number" in extra["not_a_number"]["reason"]
    assert extra["says_why"] == dict(id="says_why", label="Says why", description="", source="registered", value=None,
                                     reason="needs at least 100 records")
    assert extra["uses_scores"]["value"] == pytest.approx(sum(s for _, s in HAND) / 8)
    assert ev["confusion"] == dict(tp=3, fn=1, fp=2, tn=2) and ev["metrics"]["accuracy"] == pytest.approx(5 / 8)   # untouched
    hard = evaluate(doc([dict(id="a", label=1, prediction=1), dict(id="b", label=0, prediction=0)], decision=dict(rule="predictions")))
    assert "no score" in {x["id"]: x for x in hard["extra_metrics"]}["uses_scores"]["reason"]
    for bad, msg in ((dict(id="accuracy", label="Mine", compute=len), "built in"), (dict(id="npv", label="Again", compute=len), "duplicate"),
                     (dict(id="Bad Id", label="x", compute=len), "metric id"), (dict(id="nolabel", label=" ", compute=len), "needs a label")):
        with pytest.raises(ValueError, match=msg):
            ML.register_metric(bad)
    with pytest.raises(TypeError):
        ML.register_metric("not a metric")
    assert set(ML.CORE) < set(ML.metric_registry()) and list(ev["metrics"]) == list(ML.CORE)


def test_metric_adapters_are_loaded_from_the_entry_point_group(monkeypatch, clean_registry):
    def ep(name, obj, dist="acme-metrics"):
        def load():
            if isinstance(obj, Exception):
                raise obj
            return obj
        return types.SimpleNamespace(name=name, load=load, dist=types.SimpleNamespace(name=dist))

    fpr = ML.ClassificationMetric("fpr", "False positive rate", lambda c: c["fp"] / (c["fp"] + c["tn"]))
    asked = []
    monkeypatch.setattr(ML, "entry_points", lambda group: asked.append(group) or [
        ep("one", fpr), ep("factory", lambda: [dict(id="fnr", label="Miss rate", compute=lambda c: c["fn"] / c["positives"])]),
        ep("broken", ImportError("no module named acme")), ep("override", dict(id="recall", label="My recall", compute=len)),
        ep("wrong", lambda: 42)])
    monkeypatch.setattr(ML, "_loaded", False)
    reg = ML.metric_registry()
    assert asked == [ML.GROUP] == ["move_openlab.ml_metrics"]
    assert reg["fpr"].source == "package acme-metrics" and reg["fnr"].label == "Miss rate"
    assert reg["recall"].source == "builtin"                                      # a built-in metric is never replaced
    errors = ML.metric_load_errors()
    assert set(errors) == {"broken", "override", "wrong"} and "ImportError" in errors["broken"] and "built in" in errors["override"]
    extra = {x["id"]: x["value"] for x in evaluate(doc())["extra_metrics"]}
    assert extra["fpr"] == pytest.approx(0.5) and extra["fnr"] == pytest.approx(0.25)
    ML.metric_registry()
    assert asked == [ML.GROUP]                                                    # loaded once


# ---------------------------------------------------------------------------------------------- public example, plugin
def test_the_public_synthetic_example_is_reproducible_and_has_its_known_matrix():
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_ml_example", ROOT / "scripts" / "build_ml_evaluation_example.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    built = mod.build()
    sums = dict(reversed(line.split("  ")) for line in (EXAMPLE / "SHA256SUMS").read_text().splitlines())
    assert set(sums) == set(built) == {"synthetic-binary-evidence.json", "synthetic-binary-evidence.csv"}
    readme = (ROOT / "examples" / "README.md").read_text()
    for name, data in built.items():
        assert (EXAMPLE / name).read_bytes() == data and hashlib.sha256(data).hexdigest() == sums[name]
        assert sums[name] in readme and f"{len(data):,}".replace(",", "\u202f") in readme.replace(" ", "\u202f")
    assert "SYNTHETIC" in readme and "not the output of any real model" in readme and "not a mobility result" in readme
    raw = json.loads((EXAMPLE / "synthetic-binary-evidence.json").read_text())
    ev = ML.evaluate(ML.validate(raw))
    assert ev["confusion"] == KNOWN == mod.CELLS and ev["candidates"] == 400 and ev["positives"] == 120
    m = ev["metrics"]
    assert m["accuracy"] == pytest.approx(0.87) and m["precision"] == pytest.approx(96 / 124) and m["recall"] == pytest.approx(0.8)
    assert m["specificity"] == pytest.approx(0.9) and m["f1"] == pytest.approx(192 / 244) and 0.5 < m["roc_auc"] < 1 and 0.3 < m["pr_auc"] < 1
    csv_ev = ML.evaluate(ML.validate(ML.from_csv((EXAMPLE / "synthetic-binary-evidence.csv").read_bytes(),
                                                 {k: v for k, v in raw.items() if k != "records"})))
    assert csv_ev["confusion"] == KNOWN and csv_ev["metrics"] == m
    # it says what it is, and names no existing method
    assert "SYNTHETIC" in raw["dataset"]["population"] and "not a model" in raw["model"]["name"] and raw["method_id"] == "synthetic-example-classifier"
    assert all("synthetic" in n.lower() or "SYNTHETIC" in n for n in raw["notes"][:1])


def test_a_plugin_may_declare_a_learned_kind():
    ride = registry.get(RIDE)
    m = check_metadata(read_plugin_metadata(ROOT / "plugins" / "example_scored_filter" / "plugin.py"), ride)
    assert m.kind == "learned" and m.method_id == LEARNED and "not a trained model" in m.description
    assert check_metadata(dict(m.to_dict(), kind="hybrid"), ride).kind == "hybrid"


# ---------------------------------------------------------------------------------------------- HTTP workflow
class Lab:
    pass


@pytest.fixture(scope="module")
def lab(tmp_path_factory):
    """One installation for the module: the public demonstration, the example learned plugin registered by an
    administrator in trusted-process mode (no sandbox needed), run as an extension of the demonstration and locked."""
    tmp = tmp_path_factory.mktemp("mleval")
    plugins = tmp / "plugins"
    shutil.copytree(ROOT / "plugins" / "example_scored_filter", plugins / "example_scored_filter")
    s = make_settings(tmp, "ml", plugin_dir=plugins, plugin_mode="trusted-process")
    auth = Auth(s, UserStore(None))
    for u, role in (("alice", "researcher"), ("root", "admin")):
        auth.create_user(u, u.title(), role=role, password=PW.get(u, ROOT_PW))
        auth.store.set_password(u, hash_password(PW.get(u, ROOT_PW)), must_change=False)
    out = Lab()
    out.settings, out.root = s, TestClient(create_app(s, auth))
    assert out.root.post("/api/auth/login", json=dict(username="root", password=ROOT_PW)).status_code == 200
    out.alice = TestClient(out.root.app)
    login(out.alice, "alice")
    c = out.root
    out.base = c.post("/api/lab/demo").json()["baseline_id"]
    r = c.post(f"/api/problems/{RIDE}/methods/register", json=dict(plugin="example_scored_filter"))
    assert r.status_code == 200 and r.json()["kind"] == "learned", r.text
    out.cid = c.post(f"/api/campaigns/{out.base}/extend", json=dict(methods=[[LEARNED, "1.0.0"]])).json()["campaign_id"]
    wait(c, c.post(f"/api/campaigns/{out.cid}/execute").json())
    out.before_any_import = c.get(f"/api/lab/experiments/{out.cid}/evaluation", params=dict(method_id=LEARNED)).json()
    out.checksum = c.post(f"/api/campaigns/{out.cid}/lock").json()["checksum"]
    out.record = s.data_dir / "workspaces" / "root" / "campaigns" / out.cid / "campaign.json"
    out.url = f"/api/lab/experiments/{out.cid}/evaluation"
    return out


def upload(client, url, d=None, name="evidence.json", raw=None, **form):
    data = raw if raw is not None else json.dumps(d).encode()
    return client.post(url, files=dict(file=(name, data, "application/octet-stream")), data=form)


def tagged(tag: str, **over) -> dict:
    """The synthetic example retargeted to the test experiment's learned method (a distinct document per test)."""
    d = json.loads((EXAMPLE / "synthetic-binary-evidence.json").read_text())
    d["method_id"] = LEARNED
    d["dataset"]["id"] = f"synthetic-binary-example-v1/{tag}"
    d.update(over)
    return d


def evaluations(client, url, sha=None, **params) -> list[dict]:
    r = client.get(url, params=dict(method_id=LEARNED, **params))
    assert r.status_code == 200, r.text
    return [e for e in r.json()["evaluations"] if sha is None or e.get("evidence_sha256") == sha]


def test_a_learned_method_without_evidence_says_what_is_needed(lab):
    r = lab.before_any_import
    assert r["available"] is False and r["evaluations"] == [] and r["can_import"] is True and r["kind"] == "learned"
    assert r["reason"].startswith("Not available: labelled predictions are needed")


def test_import_evidence_then_read_the_evaluation(lab):
    d = tagged("import")
    raw = json.dumps(d, indent=1).encode()
    r = upload(lab.root, lab.url, raw=raw, name="my evidence.json")
    assert r.status_code == 200, r.text
    got = r.json()
    sha = got["evidence_sha256"]
    assert got["created"] is True and got["records"] == 400 and got["method_id"] == LEARNED and sha == hashlib.sha256(raw).hexdigest()
    assert got["source"] == dict(name="my evidence.json", sha256=sha, bytes=len(raw), kind="json")
    res = lab.root.get(lab.url, params=dict(method_id=LEARNED)).json()
    assert res["available"] is True and res["reason"] is None and res["evidence_errors"] == []
    (ev,) = [e for e in res["evaluations"] if e.get("evidence_sha256") == sha]
    assert ev["origin"] == "imported" and ev["confusion"] == KNOWN and ev["candidates"] == 400
    assert ev["metrics"]["accuracy"] == pytest.approx(0.87) and ev["metrics"]["f1"] == pytest.approx(192 / 244)
    assert set(ev["metrics"]) == set(ML.CORE) and ev["source"] == dict(name="my evidence.json", sha256=sha)
    assert ev["imported_by"] == "Root" and ev["imported_at"] and ev["evidence_format"] == ML.FORMAT
    assert ev["provenance"]["dataset"]["split"] == "synthetic" and ev["provenance"]["model"]["version"] == "1.0.0"
    assert ev["provenance"]["decision"] == dict(rule="score>=threshold", threshold=0.5)
    assert ev["threshold_adjustable"] and not ev["exploratory"] and 2 <= len(ev["sweep"]) <= ML.MAX_SWEEP_POINTS + 1
    assert all(set(p) == {"threshold", "precision", "recall", "f1", "kept_share"} for p in ev["sweep"])
    # stored content-addressed in an owner-only file; the download is the same bytes
    f = lab.settings.data_dir / "workspaces" / "root" / "ml_evaluations" / lab.cid / f"{sha}.json"
    assert f.read_bytes() == raw and stat.S_IMODE(f.stat().st_mode) == 0o600
    assert stat.S_IMODE(f.parent.stat().st_mode) == 0o700 and stat.S_IMODE((f.parent / "index.json").stat().st_mode) == 0o600
    dl = lab.root.get(f"{lab.url}/evidence/{sha}")
    assert dl.status_code == 200 and dl.content == raw and dl.headers["x-evidence-sha256"] == sha
    assert "attachment" in dl.headers["content-disposition"]
    assert lab.root.get(f"{lab.url}/evidence/{'0' * 64}").status_code == 404 and lab.root.get(f"{lab.url}/evidence/nothex").status_code == 404
    log = [json.loads(x) for x in (lab.settings.data_dir / "audit.log").read_text().splitlines()]
    assert dict(actor="root", action="import_ml_evidence", target=f"{lab.cid}:{LEARNED}:{sha}") in [
        {k: e[k] for k in ("actor", "action", "target")} for e in log]
    # the same document again is not stored or listed twice
    again = upload(lab.root, lab.url, raw=raw).json()
    assert again["created"] is False and again["evidence_sha256"] == sha and len(evaluations(lab.root, lab.url, sha)) == 1


def test_a_locked_experiment_keeps_its_record_and_checksum(lab):
    before = lab.record.read_bytes()
    assert upload(lab.root, lab.url, tagged("locked")).status_code == 200
    assert lab.record.read_bytes() == before
    c = lab.root.get(f"/api/campaigns/{lab.cid}").json()["campaign"]         # every read re-verifies the checksum
    assert c["checksum"] == lab.checksum and c["status"] == "locked" and campaign_checksum(c) == lab.checksum
    assert "evidence" not in json.dumps(c) and "ml_evaluation" not in json.dumps(c)
    # the imported, read-only demonstration is not modified either (its exact method takes no evidence at all)
    base_record = lab.settings.data_dir / "workspaces" / "root" / "campaigns" / lab.base / "campaign.json"
    base_before = base_record.read_bytes()
    assert upload(lab.root, f"/api/lab/experiments/{lab.base}/evaluation", tagged("x", method_id="exact-matching-highs")).status_code == 422
    assert base_record.read_bytes() == base_before


def test_exact_and_heuristic_methods_are_not_applicable(lab):
    url = f"/api/lab/experiments/{lab.base}/evaluation"
    for mid in ("exact-matching-highs", "greedy-min-detour"):
        r = lab.root.get(url, params=dict(method_id=mid)).json()
        assert r["available"] is False and r["can_import"] is False and r["reason"].startswith("Not applicable")
        refused = upload(lab.root, url, tagged("exact", method_id=mid))
        assert refused.status_code == 422 and refused.json()["detail"].startswith("Not applicable")
    assert not (lab.settings.data_dir / "workspaces" / "root" / "ml_evaluations" / lab.base).exists()
    assert lab.root.get(url, params=dict(method_id="no-such-method")).status_code == 404
    unknown = upload(lab.root, lab.url, tagged("unknown", method_id="no-such-method"))
    assert unknown.status_code == 422 and "not a method of this experiment" in unknown.json()["detail"]
    other = upload(lab.root, lab.url, tagged("mismatch", method_id="synthetic-example-classifier"), method_id=LEARNED)
    assert other.status_code == 422 and "it can only be imported for the method it names" in other.json()["detail"]


def test_another_account_gets_404_everywhere(lab):
    sha = upload(lab.root, lab.url, tagged("isolation")).json()["evidence_sha256"]
    assert lab.alice.get(lab.url, params=dict(method_id=LEARNED)).status_code == 404
    assert upload(lab.alice, lab.url, tagged("intruder")).status_code == 404
    assert lab.alice.get(f"{lab.url}/evidence/{sha}").status_code == 404
    assert lab.alice.post(f"{lab.url}/evidence/{sha}/withdraw").status_code == 404
    assert not (lab.settings.data_dir / "workspaces" / "alice" / "ml_evaluations").exists()
    assert len(evaluations(lab.root, lab.url, sha)) == 1                              # untouched for its owner
    anonymous = TestClient(lab.root.app)
    assert anonymous.get(lab.url, params=dict(method_id=LEARNED)).status_code == 401
    assert upload(anonymous, lab.url, tagged("anonymous")).status_code == 401


def test_a_restricted_problem_hides_the_evaluation_like_the_experiment(lab, monkeypatch):
    sha = upload(lab.root, lab.url, tagged("restricted")).json()["evidence_sha256"]
    monkeypatch.setattr(registry.get(RIDE), "restricted", True, raising=False)
    assert lab.root.get(f"/api/lab/experiments/{lab.cid}").status_code == 404
    assert lab.root.get(lab.url, params=dict(method_id=LEARNED)).status_code == 404
    assert upload(lab.root, lab.url, tagged("restricted-2")).status_code == 404
    assert lab.root.get(f"{lab.url}/evidence/{sha}").status_code == 404
    assert lab.root.post(f"{lab.url}/evidence/{sha}/withdraw").status_code == 404


def test_csv_records_with_metadata_fields(lab):
    d = tagged("csv")
    csv_raw = (EXAMPLE / "synthetic-binary-evidence.csv").read_bytes()
    md = {k: v for k, v in d.items() if k not in ("records", "format", "method_id")}
    r = upload(lab.root, lab.url, raw=csv_raw, name="records.csv", method_id=LEARNED, metadata=json.dumps(md))
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["source"] == dict(name="records.csv", sha256=hashlib.sha256(csv_raw).hexdigest(), bytes=len(csv_raw), kind="csv")
    (ev,) = evaluations(lab.root, lab.url, got["evidence_sha256"])
    assert ev["confusion"] == KNOWN and ev["source"]["name"] == "records.csv" and ev["origin"] == "imported"
    stored = lab.root.get(f"{lab.url}/evidence/{got['evidence_sha256']}").content
    assert hashlib.sha256(stored).hexdigest() == got["evidence_sha256"]
    assert ML.validate(json.loads(stored))["dataset"]["id"].endswith("/csv") and len(json.loads(stored)["records"]) == 400
    # refusals of the CSV path, in place and with their reason
    for kwargs, status, msg in (
            (dict(raw=csv_raw, name="r.csv", method_id=LEARNED), 422, "missing model provenance"),
            (dict(raw=csv_raw, name="r.csv", metadata=json.dumps(md)), 422, "missing method_id"),
            (dict(raw=csv_raw, name="r.csv", method_id=LEARNED, metadata="{broken"), 422, "metadata must be a JSON object"),
            (dict(raw=csv_raw, name="r.csv", method_id=LEARNED, metadata=json.dumps(dict(md, method_id="other"))), 422, "differ"),
            (dict(raw=b"id,label,score\nrec-1,1,nan\n", name="r.csv", method_id=LEARNED, metadata=json.dumps(md)), 422, "not a finite number"),
            (dict(raw=b"", name="r.csv", method_id=LEARNED, metadata=json.dumps(md)), 422, "empty file"),
            (dict(d=d, name="e.json", metadata=json.dumps(md)), 422, "carries its own metadata")):
        bad = upload(lab.root, lab.url, **kwargs)
        assert bad.status_code == status and msg in bad.json()["detail"], bad.text


def test_refusals_over_http_store_nothing(lab, monkeypatch):
    folder = lab.settings.data_dir / "workspaces" / "root" / "ml_evaluations" / lab.cid
    before = sorted(p.name for p in folder.iterdir()) if folder.exists() else []
    dup = tagged("dup")
    dup["records"][1]["id"] = dup["records"][0]["id"]
    nan = json.dumps(tagged("nan")).replace('"score": 0.132', '"score": NaN', 1).encode()
    for kwargs, status, msg in ((dict(d=dup), 422, "duplicate id"), (dict(raw=nan), 422, "not a finite number"),
                                (dict(raw=b"{}"), 422, "format must be"), (dict(raw=b"[1]", name="x.json"), 422, "must be a JSON object"),
                                (dict(d=tagged("nothr", decision=dict(rule="score>=threshold"))), 422, "threshold is missing"),
                                (dict(d=tagged("nods", dataset=dict(id="x"))), 422, "missing dataset provenance")):
        r = upload(lab.root, lab.url, **kwargs)
        assert r.status_code == status and msg in r.json()["detail"], r.text
    monkeypatch.setattr(ML, "MAX_RECORDS", 100)
    assert upload(lab.root, lab.url, tagged("many")).status_code == 413
    monkeypatch.setattr(ML, "MAX_EVIDENCE_BYTES", 1000)
    big = upload(lab.root, lab.url, tagged("big"))
    assert big.status_code == 413 and "larger than" in big.json()["detail"]
    assert (sorted(p.name for p in folder.iterdir()) if folder.exists() else []) == before


def test_exploratory_threshold_over_http(lab):
    sha = upload(lab.root, lab.url, tagged("threshold")).json()["evidence_sha256"]
    (ev,) = evaluations(lab.root, lab.url, sha, threshold=0.7)
    assert ev["exploratory"] is True and ev["threshold"] == 0.7 and ev["confusion"] == dict(tp=79, fn=41, fp=11, tn=269)
    assert ev["metrics"]["precision"] == pytest.approx(79 / 90) and "exploratory" in ev["decision"]
    assert ev["recorded_decision"]["confusion"] == KNOWN and ev["recorded_decision"]["threshold"] == 0.5
    assert ev["recorded_decision"]["metrics"]["accuracy"] == pytest.approx(0.87)
    (plain,) = evaluations(lab.root, lab.url, sha)
    assert plain["exploratory"] is False and plain["confusion"] == KNOWN and plain["metrics"]["roc_auc"] == ev["metrics"]["roc_auc"]
    (same,) = evaluations(lab.root, lab.url, sha, threshold=0.5)
    assert same["exploratory"] is False
    for bad in ("nan", "inf", "abc"):
        assert lab.root.get(lab.url, params=dict(method_id=LEARNED, threshold=bad)).status_code == 422


def test_adapter_evaluations_come_first_and_are_unchanged(lab, monkeypatch):
    sha = upload(lab.root, lab.url, tagged("adapter")).json()["evidence_sha256"]
    provided = dict(population="held-out scenarios", split="test", graphs=4, candidates=10, positives=4, prevalence_pct=40.0,
                    decision="score >= 0.5", positive_label="used by the reference", convention="positive = keep",
                    confusion=dict(tp=3, fn=1, fp=2, tn=4), metrics=dict(accuracy=0.7, precision=0.6, recall=0.75),
                    source=dict(name="file of the problem package", sha256="f" * 64), notes=[])
    monkeypatch.setattr(type(registry.get(RIDE)), "ml_evaluations", lambda self, mid, cfg: [dict(provided)] if mid == LEARNED else [])
    evs = evaluations(lab.root, lab.url, threshold=0.7)
    assert evs[0] == dict(provided, origin="adapter", threshold_adjustable=False, exploratory=False)
    assert all(e["origin"] == "imported" for e in evs[1:]) and sha in [e["evidence_sha256"] for e in evs[1:]]

    def unreadable(self, mid, cfg):
        raise OSError("gone")
    monkeypatch.setattr(type(registry.get(RIDE)), "ml_evaluations", unreadable)
    res = lab.root.get(lab.url, params=dict(method_id=LEARNED)).json()
    assert res["available"] is True and "could not be read (OSError)" in res["adapter_error"]
    assert all(e["origin"] == "imported" for e in res["evaluations"])


def test_withdrawn_evidence_is_hidden_kept_and_audited(lab):
    raw = json.dumps(tagged("withdraw")).encode()
    sha = upload(lab.root, lab.url, raw=raw).json()["evidence_sha256"]
    f = lab.settings.data_dir / "workspaces" / "root" / "ml_evaluations" / lab.cid / f"{sha}.json"
    count = lab.root.get(lab.url, params=dict(method_id=LEARNED)).json()["withdrawn"]
    r = lab.root.post(f"{lab.url}/evidence/{sha}/withdraw")
    assert r.status_code == 200 and r.json()["withdrawn"]["by"] == "Root"
    assert evaluations(lab.root, lab.url, sha) == [] and f.read_bytes() == raw                      # hidden, never deleted
    assert lab.root.get(lab.url, params=dict(method_id=LEARNED)).json()["withdrawn"] == count + 1
    assert lab.root.get(f"{lab.url}/evidence/{sha}").content == raw
    assert lab.root.post(f"{lab.url}/evidence/{sha}/withdraw").status_code == 200                   # idempotent
    log = [json.loads(x) for x in (lab.settings.data_dir / "audit.log").read_text().splitlines()]
    assert sum(e["action"] == "withdraw_ml_evidence" and e["target"].endswith(sha) for e in log) == 1
    assert lab.root.request("DELETE", f"{lab.url}/evidence/{sha}").status_code == 405                # there is no delete
    again = upload(lab.root, lab.url, raw=raw).json()
    assert again["evidence_sha256"] == sha and len(evaluations(lab.root, lab.url, sha)) == 1         # imported again: shown again


def test_a_modified_stored_file_is_reported_not_evaluated(lab):
    sha = upload(lab.root, lab.url, tagged("tamper")).json()["evidence_sha256"]
    f = lab.settings.data_dir / "workspaces" / "root" / "ml_evaluations" / lab.cid / f"{sha}.json"
    original = f.read_bytes()
    try:
        os.chmod(f, 0o600)
        f.write_bytes(original.replace(b'"label": 1', b'"label": 0', 1))
        res = lab.root.get(lab.url, params=dict(method_id=LEARNED)).json()
        assert sha not in [e.get("evidence_sha256") for e in res["evaluations"]]
        assert [e for e in res["evidence_errors"] if e["evidence_sha256"] == sha and "fails its checksum" in e["reason"]]
        assert lab.root.get(f"{lab.url}/evidence/{sha}").status_code == 422
    finally:
        f.write_bytes(original)
    assert len(evaluations(lab.root, lab.url, sha)) == 1


def test_an_unreadable_stored_file_is_reported_without_the_server_path(lab):
    sha = upload(lab.root, lab.url, tagged("unreadable")).json()["evidence_sha256"]
    f = lab.settings.data_dir / "workspaces" / "root" / "ml_evaluations" / lab.cid / f"{sha}.json"
    try:
        os.chmod(f, 0)                                           # reading it now fails with an OSError naming the path
        res = lab.root.get(lab.url, params=dict(method_id=LEARNED)).json()
        why = [e["reason"] for e in res["evidence_errors"] if e["evidence_sha256"] == sha]
        assert why and why[0].startswith("Not available: the stored file could not be read (")
        assert str(lab.settings.data_dir) not in json.dumps(res)
    finally:
        os.chmod(f, 0o600)
