"""ML evaluation from evidence: a confusion matrix and classification metrics computed from real predictions and
ground-truth labels that a researcher provides for one method of an experiment.

Nothing here looks at an optimization result: the only inputs are the records of an evidence document. A figure that
is mathematically undefined (only one class in the labels, a zero denominator, no scores) is ``None`` with a reason —
never zero.

**Evidence format** ``move-openlab/ml-evaluation-evidence@1`` (JSON)::

    {"format": "move-openlab/ml-evaluation-evidence@1",
     "method_id": "...",                                          the method of the experiment the evidence is about
     "model": {"name", "version", "sha256"?, "training_data"?},
     "feature_pipeline": {"name", "version", "description"},
     "dataset": {"id", "split", "population", "unit"},            population: its definition in words; unit: what one
                                                                  record is (a candidate pair, an arc, a trip ...)
     "positive_label": "...",                                     what label 1 means
     "decision": {"rule": "score>=threshold" | "score<=threshold" | "predictions", "threshold"?, "policy"?},
     "records": [{"id", "label": 0 | 1, "score"?, "prediction"?: 0 | 1}],
     "notes": "..." | ["...", ...]}

Rules of the records: identifiers are unique; a label is 0 or 1; a score is a finite number; with a threshold rule
every record has a score (a ``prediction`` given as well must agree with the rule); with the rule ``predictions`` every
record has a prediction, and scores are given for every record or for none (a higher score then means *more likely
positive*). The same records can be given as CSV (``id,label,score[,prediction]``) with the other fields as metadata
(:func:`from_csv`).

**Metrics.** Accuracy, balanced accuracy, precision, recall, specificity and F1 come from the confusion matrix of the
decision. ROC-AUC is rank-based (Mann-Whitney, tied scores share their average rank); PR-AUC is the average precision
(precision at each distinct score weighted by the recall gained there, ties taken together). Both exist only when
every record has a score. :func:`sweep` gives precision, recall, F1 and the share kept at a bounded number of
thresholds.

**Metric adapters.** Classification metrics are functions in a small registry. Another *installed* package can add
its own through the entry-point group ``move_openlab.ml_metrics`` (an entry point resolves to a
:class:`ClassificationMetric`, a list of them, or a function without argument returning either). Such code is trusted
like a problem package: it runs in the server process. A metric that raises, or returns anything but a finite number,
is reported as unavailable with its reason; it never breaks an evaluation and never replaces a built-in metric.
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
import threading
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from importlib.metadata import entry_points
from typing import Any, Callable

FORMAT = "move-openlab/ml-evaluation-evidence@1"
GROUP = "move_openlab.ml_metrics"
RULES = ("score>=threshold", "score<=threshold", "predictions")
THRESHOLD_RULES = RULES[:2]

# Limits of one evidence document (refused above them, before anything is stored).
MAX_EVIDENCE_BYTES = 8 * 1024 * 1024       # size of the uploaded file
MAX_RECORDS = 200_000                      # labelled records in one evaluation
MAX_ID_CHARS = 200                         # one record identifier
MAX_NAME_CHARS = 200                       # a name, a version, an identifier
MAX_TEXT_CHARS = 2000                      # a description, a population definition, one note
MAX_NOTES = 20
MAX_SWEEP_POINTS = 101                     # thresholds of a sweep (all distinct scores when there are fewer)

CORE = ("accuracy", "balanced_accuracy", "precision", "recall", "specificity", "f1", "pr_auc", "roc_auc")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_METRIC_ID = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
CSV_COLUMNS = ("id", "label", "score", "prediction")


class EvidenceError(ValueError):
    """Evidence that cannot be used; ``status`` is the HTTP status of the refusal (422, or 413 above a limit)."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------------------------- validation
def _text(value: Any, what: str, limit: int = MAX_NAME_CHARS, required: bool = True) -> str | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise EvidenceError(f"missing {what}")
        return None
    if not isinstance(value, str):
        raise EvidenceError(f"{what} must be text")
    value = " ".join(value.split())
    if len(value) > limit:
        raise EvidenceError(f"{what} is longer than {limit} characters")
    return value


def _section(doc: dict, key: str, required: tuple[str, ...], optional: tuple[str, ...] = (), long: tuple[str, ...] = ()) -> dict:
    sec = doc.get(key)
    if sec is None:
        sec = {}
    if not isinstance(sec, dict):
        raise EvidenceError(f"{key} must be an object")
    unknown = sorted(set(sec) - set(required) - set(optional))
    if unknown:
        raise EvidenceError(f"{key} has unknown field(s): {', '.join(map(str, unknown))}")
    missing = [k for k in required if sec.get(k) is None or (isinstance(sec.get(k), str) and not sec[k].strip())]
    if missing:
        raise EvidenceError(f"missing {key.replace('_', ' ')} provenance: " + ", ".join(f"{key}.{k}" for k in missing))
    out = {}
    for k in (*required, *optional):
        v = _text(sec.get(k), f"{key}.{k}", MAX_TEXT_CHARS if k in long else MAX_NAME_CHARS, required=k in required)
        if v is not None:
            out[k] = v
    return out


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _bit(value: Any) -> int | None:
    """0 or 1 given as an integer (or as the float 0.0 / 1.0); anything else is not a binary value."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value not in (0, 1):
        return None
    return int(value)


def _where(index: int, rid: Any) -> str:
    return f"record {index + 1}" + (f" (id {str(rid)[:60]!r})" if rid not in (None, "") else "")


def validate(doc: Any) -> dict:
    """A normalised copy of an evidence document, or :class:`EvidenceError` saying what to correct."""
    if not isinstance(doc, dict):
        raise EvidenceError("the evidence must be a JSON object")
    if doc.get("format") != FORMAT:
        raise EvidenceError(f"format must be {FORMAT!r}")
    known = {"format", "method_id", "model", "feature_pipeline", "dataset", "positive_label", "decision", "records", "notes"}
    unknown = sorted(set(doc) - known)
    if unknown:
        raise EvidenceError(f"unknown field(s): {', '.join(map(str, unknown))}")
    method_id = _text(doc.get("method_id"), "method_id")
    model = _section(doc, "model", ("name", "version"), ("sha256", "training_data"), long=("training_data",))
    if "sha256" in model and not _HEX64.match(model["sha256"]):
        raise EvidenceError("model.sha256 must be 64 lowercase hexadecimal characters")
    pipeline = _section(doc, "feature_pipeline", ("name", "version", "description"), long=("description",))
    dataset = _section(doc, "dataset", ("id", "split", "population", "unit"), long=("population",))
    positive_label = _text(doc.get("positive_label"), "positive_label (what label 1 means)", MAX_TEXT_CHARS)

    dec = doc.get("decision")
    if not isinstance(dec, dict) or dec.get("rule") not in RULES:
        raise EvidenceError("decision.rule must be one of: " + ", ".join(RULES))
    unknown = sorted(set(dec) - {"rule", "threshold", "policy"})
    if unknown:
        raise EvidenceError(f"decision has unknown field(s): {', '.join(map(str, unknown))}")
    rule, threshold = dec["rule"], dec.get("threshold")
    if rule in THRESHOLD_RULES:
        if threshold is None:
            raise EvidenceError(f"decision.threshold is missing: the rule {rule!r} needs one")
        if not _finite(threshold):
            raise EvidenceError("decision.threshold must be a finite number")
        threshold = float(threshold)
    elif threshold is not None:
        raise EvidenceError("decision.threshold is not used with the rule 'predictions' (remove it, or describe the "
                            "policy in decision.policy)")
    decision = dict(rule=rule)
    if threshold is not None:
        decision["threshold"] = threshold
    policy = _text(dec.get("policy"), "decision.policy", MAX_TEXT_CHARS, required=False)
    if policy:
        decision["policy"] = policy

    notes = doc.get("notes")
    notes = [] if notes is None else [notes] if isinstance(notes, str) else notes
    if not isinstance(notes, list) or len(notes) > MAX_NOTES:
        raise EvidenceError(f"notes must be a text or a list of at most {MAX_NOTES} texts")
    notes = [n for n in (_text(x, "a note", MAX_TEXT_CHARS, required=False) for x in notes) if n]

    records = _records(doc.get("records"), rule, threshold)
    return dict(format=FORMAT, method_id=method_id, model=model, feature_pipeline=pipeline, dataset=dataset,
                positive_label=positive_label, decision=decision, records=records, notes=notes)


def _records(raw: Any, rule: str, threshold: float | None) -> list[dict]:
    if not isinstance(raw, list):
        raise EvidenceError("records must be a list")
    if not raw:
        raise EvidenceError("the evidence has no record (empty file)")
    if len(raw) > MAX_RECORDS:
        raise EvidenceError(f"too many records: {len(raw)} (at most {MAX_RECORDS})", 413)
    out, seen, scored = [], set(), 0
    for i, r in enumerate(raw):
        if not isinstance(r, dict):
            raise EvidenceError(f"record {i + 1} must be an object")
        unknown = sorted(set(r) - set(CSV_COLUMNS))
        if unknown:
            raise EvidenceError(f"{_where(i, r.get('id'))} has unknown field(s): {', '.join(map(str, unknown))}")
        rid = r.get("id")
        if isinstance(rid, int) and not isinstance(rid, bool):
            rid = str(rid)
        if not isinstance(rid, str) or not rid.strip():
            raise EvidenceError(f"record {i + 1} has no id")
        rid = rid.strip()
        if len(rid) > MAX_ID_CHARS:
            raise EvidenceError(f"record {i + 1}: id longer than {MAX_ID_CHARS} characters")
        if rid in seen:
            raise EvidenceError(f"duplicate id {rid[:60]!r} (record {i + 1}): every record needs its own id")
        seen.add(rid)
        if r.get("label") is None:
            raise EvidenceError(f"{_where(i, rid)} has no label")
        label = _bit(r["label"])
        if label is None:
            raise EvidenceError(f"{_where(i, rid)}: label must be 0 or 1 (binary classification), got {str(r['label'])[:40]!r}")
        rec = dict(id=rid, label=label)
        score, pred = r.get("score"), r.get("prediction")
        if score is not None:
            if isinstance(score, float) and not math.isfinite(score):
                raise EvidenceError(f"{_where(i, rid)}: score is not a finite number (NaN and infinity are refused)")
            if not _finite(score):
                raise EvidenceError(f"{_where(i, rid)}: score must be a number")
            rec["score"] = float(score)
            scored += 1
        if pred is not None:
            p = _bit(pred)
            if p is None:
                raise EvidenceError(f"{_where(i, rid)}: prediction must be 0 or 1, got {str(pred)[:40]!r}")
            rec["prediction"] = p
        if score is None and pred is None:
            raise EvidenceError(f"{_where(i, rid)} has neither a score nor a prediction")
        if rule in THRESHOLD_RULES:
            if score is None:
                raise EvidenceError(f"{_where(i, rid)} has no score, and the decision rule {rule!r} needs one for every record")
            if pred is not None and rec["prediction"] != _decide(rec["score"], rule, threshold):
                raise EvidenceError(f"{_where(i, rid)}: prediction {rec['prediction']} contradicts the decision rule "
                                    f"({_decision_text(rule, threshold)}, score {rec['score']:g})")
        elif pred is None:
            raise EvidenceError(f"{_where(i, rid)} has no prediction, and the decision rule 'predictions' needs one for every record")
        out.append(rec)
    if rule == "predictions" and 0 < scored < len(out):
        raise EvidenceError(f"scores are given for {scored} of {len(out)} records: give a score for every record or for none")
    return out


def parse_json(data: bytes) -> Any:
    """The JSON value of an uploaded evidence file (size and syntax checked; not yet validated)."""
    _check_size(data)
    try:
        return json.loads(data.decode("utf-8-sig"))
    except RecursionError:
        raise EvidenceError("the file is nested too deeply to be an evidence document") from None
    except (UnicodeDecodeError, ValueError) as e:
        raise EvidenceError(f"the file is not valid UTF-8 JSON ({str(e)[:120]})") from None


def _check_size(data: bytes) -> None:
    if not data or not data.strip():
        raise EvidenceError("empty file")
    if len(data) > MAX_EVIDENCE_BYTES:
        raise EvidenceError(f"file larger than {MAX_EVIDENCE_BYTES // 2**20} MB", 413)


def from_csv(data: bytes, metadata: Any) -> dict:
    """An evidence document from a CSV of records (``id,label,score[,prediction]``, header required, columns in any
    order) and the metadata fields of the format (everything but ``records``). Not yet validated."""
    _check_size(data)
    if not isinstance(metadata, dict):
        raise EvidenceError("the metadata of a CSV file must be a JSON object (method, model, feature pipeline, dataset, "
                            "positive label, decision)")
    if "records" in metadata:
        raise EvidenceError("the metadata of a CSV file must not contain records")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise EvidenceError("the CSV file is not UTF-8 text") from None
    try:
        rows = csv.reader(io.StringIO(text, newline=""))
        header = next(rows, None)
        if not header or not any(c.strip() for c in header):
            raise EvidenceError("empty file")
        cols = [c.strip().lower() for c in header]
        unknown = [c for c in cols if c not in CSV_COLUMNS]
        if unknown:
            raise EvidenceError(f"unexpected CSV column(s): {', '.join(unknown[:5])} (expected: id, label, score, prediction)")
        if len(set(cols)) != len(cols):
            raise EvidenceError("a CSV column appears twice")
        missing = [c for c in ("id", "label") if c not in cols]
        if missing:
            raise EvidenceError(f"missing CSV column(s): {', '.join(missing)}")
        if "score" not in cols and "prediction" not in cols:
            raise EvidenceError("the CSV needs a score column, a prediction column, or both")
        records = []
        for n, row in enumerate(rows, start=2):
            if not any(c.strip() for c in row):
                continue                                       # a blank line
            if len(row) != len(cols):
                raise EvidenceError(f"CSV line {n}: {len(row)} values for {len(cols)} columns")
            if len(records) >= MAX_RECORDS:
                raise EvidenceError(f"too many records (at most {MAX_RECORDS})", 413)
            cell = {c: v.strip() for c, v in zip(cols, row)}
            rec: dict = dict(id=cell["id"])
            rec["label"] = _csv_bit(cell["label"], "label", n) if cell["label"] else None
            if cell.get("score"):
                try:
                    rec["score"] = float(cell["score"])
                except ValueError:
                    raise EvidenceError(f"CSV line {n}: score {cell['score'][:40]!r} is not a number") from None
            if cell.get("prediction"):
                rec["prediction"] = _csv_bit(cell["prediction"], "prediction", n)
            records.append(rec)
    except csv.Error as e:
        raise EvidenceError(f"the CSV file cannot be read ({e})") from None
    return dict(metadata, format=metadata.get("format", FORMAT), records=records)


def _csv_bit(text: str, what: str, line: int) -> int:
    if text not in ("0", "1"):
        raise EvidenceError(f"CSV line {line}: {what} must be 0 or 1, got {text[:40]!r}")
    return int(text)


# ---------------------------------------------------------------------------------------------- confusion and metrics
def _decide(score: float, rule: str, threshold: float) -> int:
    return int(score >= threshold) if rule == "score>=threshold" else int(score <= threshold)


def _decision_text(rule: str, threshold: float | None, policy: str | None = None) -> str:
    text = ("hard predictions provided with the evidence" if rule == "predictions"
            else f"score {'>=' if rule == 'score>=threshold' else '<='} {threshold:g}")
    return f"{text} ({policy})" if policy else text


def confusion(labels: list[int], predictions: list[int]) -> dict:
    """``{tp, fn, fp, tn}`` of binary labels and binary predictions (1 = positive)."""
    if len(labels) != len(predictions):
        raise ValueError("labels and predictions differ in length")
    tp = sum(1 for y, p in zip(labels, predictions) if y == 1 and p == 1)
    fp = sum(1 for y, p in zip(labels, predictions) if y == 0 and p == 1)
    fn = sum(1 for y, p in zip(labels, predictions) if y == 1 and p == 0)
    return dict(tp=tp, fn=fn, fp=fp, tn=len(labels) - tp - fp - fn)


def _ratio(num: float, den: float, why: str) -> tuple[float | None, str | None]:
    return (num / den, None) if den else (None, why)


def confusion_metrics(c: dict) -> tuple[dict, dict]:
    """``(values, reasons)`` of the six metrics of a confusion matrix. An undefined metric is ``None`` and its reason
    is in ``reasons``. F1 is the harmonic mean of precision and recall: undefined when either is undefined, 0 when
    both are 0."""
    tp, fn, fp, tn = c["tp"], c["fn"], c["fp"], c["tn"]
    values: dict = {}
    reasons: dict = {}

    def put(key: str, pair: tuple[float | None, str | None]) -> float | None:
        values[key] = pair[0]
        if pair[0] is None:
            reasons[key] = pair[1]
        return pair[0]

    put("accuracy", _ratio(tp + tn, tp + fn + fp + tn, "no record"))
    precision = put("precision", _ratio(tp, tp + fp, "undefined: no record is predicted positive"))
    recall = put("recall", _ratio(tp, tp + fn, "undefined: the labels contain no positive"))
    specificity = put("specificity", _ratio(tn, tn + fp, "undefined: the labels contain no negative"))
    if recall is None or specificity is None:
        put("balanced_accuracy", (None, "undefined: the labels contain only one class"))
    else:
        put("balanced_accuracy", ((recall + specificity) / 2, None))
    if precision is None or recall is None:
        put("f1", (None, "undefined: " + ("precision" if precision is None else "recall") + " is undefined"))
    else:
        put("f1", (2 * precision * recall / (precision + recall) if precision + recall else 0.0, None))
    return values, reasons


def roc_auc(labels: list[int], scores: list[float]) -> float | None:
    """Area under the ROC curve from ranks (Mann-Whitney): the probability that a positive has a higher score than a
    negative, a tie counting one half. ``None`` when the labels contain only one class."""
    pos = sum(labels)
    neg = len(labels) - pos
    if not pos or not neg:
        return None
    order = sorted(range(len(scores)), key=scores.__getitem__)
    rank_sum, i = 0.0, 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        mean_rank = (i + j) / 2 + 1                            # tied scores share the average of their ranks
        rank_sum += mean_rank * sum(labels[order[k]] for k in range(i, j + 1))
        i = j + 1
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def average_precision(labels: list[int], scores: list[float]) -> float | None:
    """PR-AUC as average precision: over the distinct scores from the highest down, the precision reached there times
    the recall gained there (records with the same score are taken together). ``None`` without a positive label."""
    pos = sum(labels)
    if not pos:
        return None
    order = sorted(range(len(scores)), key=scores.__getitem__, reverse=True)
    ap, tp, seen, i = 0.0, 0, 0, 0
    while i < len(order):
        j, gained = i, 0
        while j < len(order) and scores[order[j]] == scores[order[i]]:
            gained += labels[order[j]]
            j += 1
        tp, seen = tp + gained, j
        ap += (gained / pos) * (tp / seen)
        i = j
    return ap


class _Ranked:
    """Records ordered by score, to read the confusion matrix of any threshold in logarithmic time."""

    def __init__(self, labels: list[int], scores: list[float], rule: str):
        order = sorted(range(len(scores)), key=scores.__getitem__)
        self.rule, self.n, self.scores = rule, len(scores), [scores[i] for i in order]
        self.prefix = [0]                                      # positives among the k lowest scores
        for i in order:
            self.prefix.append(self.prefix[-1] + labels[i])
        self.pos = self.prefix[-1]

    def confusion(self, threshold: float) -> dict:
        if self.rule == "score>=threshold":
            k = bisect_left(self.scores, threshold)            # records below the threshold: predicted negative
            kept, tp = self.n - k, self.pos - self.prefix[k]
        else:
            kept = bisect_right(self.scores, threshold)
            tp = self.prefix[kept]
        fp = kept - tp
        return dict(tp=tp, fn=self.pos - tp, fp=fp, tn=self.n - self.pos - fp)

    def distinct(self) -> list[float]:
        out: list[float] = []
        for s in self.scores:
            if not out or s != out[-1]:
                out.append(s)
        return out


def _sweep(ranked: _Ranked, include: tuple[float, ...] = (), max_points: int = MAX_SWEEP_POINTS) -> list[dict]:
    values = ranked.distinct()
    if len(values) > max_points:                               # bounded: evenly spaced over the distinct scores
        last = len(values) - 1
        values = [values[round(i * last / (max_points - 1))] for i in range(max_points)]
    out = []
    for t in sorted(set(values) | set(include)):
        c = ranked.confusion(t)
        m, _ = confusion_metrics(c)
        out.append(dict(threshold=t, precision=_r(m["precision"]), recall=_r(m["recall"]), f1=_r(m["f1"]),
                        kept_share=_r((c["tp"] + c["fp"]) / ranked.n)))
    return out


def sweep(labels: list[int], scores: list[float], rule: str = "score>=threshold", include: tuple[float, ...] = (),
          max_points: int = MAX_SWEEP_POINTS) -> list[dict]:
    """Threshold-dependent evaluation: ``[{threshold, precision, recall, f1, kept_share}]`` in increasing threshold
    order, at every distinct score, or at ``max_points`` of them evenly spaced when there are more; ``include`` adds
    thresholds (the recorded one). ``kept_share`` is the share of records predicted positive. Undefined is ``None``."""
    if rule not in THRESHOLD_RULES:
        raise ValueError("a sweep needs a threshold rule")
    return _sweep(_Ranked(labels, scores, rule), include, max_points)


def _r(v: float | None) -> float | None:
    return None if v is None else round(v, 6)


# ---------------------------------------------------------------------------------------------- metric registry
@dataclass(frozen=True)
class ClassificationMetric:
    """One classification metric. ``compute(ctx)`` returns a finite number, ``None`` (undefined), or ``(None, reason)``.

    ``ctx`` holds ``tp``, ``fn``, ``fp``, ``tn``, ``n``, ``positives``, ``negatives``, ``labels``, ``predictions``
    (tuples of 0/1, in record order), ``scores`` (a tuple oriented so that higher means *more likely positive*, or
    ``None`` when the evidence has none), ``rule`` and ``threshold``. With ``needs_scores`` the metric is not called
    when there are no scores."""
    id: str
    label: str
    compute: Callable[[dict], Any]
    description: str = ""
    needs_scores: bool = False
    source: str = "builtin"


def _from_confusion(key: str) -> Callable[[dict], Any]:
    def compute(ctx: dict):
        values, reasons = confusion_metrics(ctx)
        return values[key] if values[key] is not None else (None, reasons[key])
    return compute


def _roc(ctx: dict):
    v = roc_auc(list(ctx["labels"]), list(ctx["scores"]))
    return v if v is not None else (None, "undefined: the labels contain only one class")


def _ap(ctx: dict):
    v = average_precision(list(ctx["labels"]), list(ctx["scores"]))
    return v if v is not None else (None, "undefined: the labels contain no positive")


def _mcc(ctx: dict):
    tp, fn, fp, tn = ctx["tp"], ctx["fn"], ctx["fp"], ctx["tn"]
    den = (tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)
    if not den:
        return None, "undefined: one class is missing from the labels or from the predictions"
    return (tp * tn - fp * fn) / math.sqrt(den)


_BUILTIN: dict[str, ClassificationMetric] = {m.id: m for m in (
    ClassificationMetric("accuracy", "Accuracy", _from_confusion("accuracy"), "share of the records classified like their label"),
    ClassificationMetric("balanced_accuracy", "Balanced accuracy", _from_confusion("balanced_accuracy"), "mean of recall and specificity"),
    ClassificationMetric("precision", "Precision", _from_confusion("precision"), "share of the predicted positives that are positive"),
    ClassificationMetric("recall", "Recall", _from_confusion("recall"), "share of the positives that are predicted positive"),
    ClassificationMetric("specificity", "Specificity", _from_confusion("specificity"), "share of the negatives that are predicted negative"),
    ClassificationMetric("f1", "F1", _from_confusion("f1"), "harmonic mean of precision and recall"),
    ClassificationMetric("pr_auc", "PR-AUC", _ap, "average precision over the scores", needs_scores=True),
    ClassificationMetric("roc_auc", "ROC-AUC", _roc, "rank-based area under the ROC curve (ties share their rank)", needs_scores=True),
    ClassificationMetric("mcc", "Matthews correlation coefficient", _mcc,
                         "correlation between labels and predictions, from -1 to 1 (0: no better than chance)"),
)}
_lock = threading.Lock()
_extra: dict[str, ClassificationMetric] = {}
_errors: dict[str, str] = {}
_loaded = False


def _check_metric(metric: Any, source: str) -> ClassificationMetric:
    if isinstance(metric, dict):
        metric = ClassificationMetric(**{**metric, "source": source})
    if not isinstance(metric, ClassificationMetric):
        raise TypeError("a metric adapter must provide ClassificationMetric objects")
    if not isinstance(metric.id, str) or not _METRIC_ID.match(metric.id):
        raise ValueError(f"metric id {metric.id!r} must be 2-48 lowercase letters, digits and '_', starting with a letter")
    if not isinstance(metric.label, str) or not metric.label.strip() or not callable(metric.compute):
        raise ValueError(f"metric {metric.id!r} needs a label and a compute function")
    if metric.id in _BUILTIN:
        raise ValueError(f"metric {metric.id!r} is built in and cannot be replaced")
    return ClassificationMetric(metric.id, metric.label.strip()[:80], metric.compute, str(metric.description or "")[:400],
                                bool(metric.needs_scores), source)


def register_metric(metric: ClassificationMetric | dict, source: str = "registered") -> ClassificationMetric:
    """Explicit registration of an additional metric (tests, embedding applications). A built-in id is refused."""
    m = _check_metric(metric, source)
    with _lock:
        if m.id in _extra:
            raise ValueError(f"duplicate metric id {m.id!r}")
        _extra[m.id] = m
    return m


def _load() -> None:
    global _loaded
    with _lock:
        if _loaded:
            return
        _loaded = True
        for ep in entry_points(group=GROUP):
            try:
                obj = ep.load()
                if callable(obj) and not isinstance(obj, ClassificationMetric):
                    obj = obj()
                dist = getattr(getattr(ep, "dist", None), "name", None) or ep.name
                for item in (obj if isinstance(obj, (list, tuple)) else [obj]):
                    m = _check_metric(item, f"package {dist}")
                    if m.id in _extra:
                        raise ValueError(f"duplicate metric id {m.id!r}")
                    _extra[m.id] = m
            except Exception as e:                             # reported by metric_load_errors(), never hidden
                _errors[ep.name] = f"{type(e).__name__}: {str(e)[:200]}"


def metric_registry() -> dict[str, ClassificationMetric]:
    """Every classification metric: the built-in ones, then those added by installed packages or registered here."""
    _load()
    with _lock:
        return {**_BUILTIN, **_extra}


def metric_load_errors() -> dict[str, str]:
    _load()
    return dict(_errors)


def compute_metrics(ctx: dict) -> tuple[dict, dict, list[dict]]:
    """``(metrics, reasons, extra)``: the eight core figures by id (``None`` when undefined, with its reason in
    ``reasons``), and the other registered metrics as ``[{id, label, description, source, value, reason}]``. A metric
    that fails is unavailable with its reason; the others are not affected."""
    metrics: dict = {}
    reasons: dict = {}
    extra: list[dict] = []
    for m in metric_registry().values():
        value, reason = None, None
        if m.needs_scores and ctx.get("scores") is None:
            reason = "not available: the evidence has no score for every record"
        else:
            try:
                got = m.compute(ctx)
                if isinstance(got, tuple):
                    value, reason = (got + (None, None))[:2]
                    reason = None if reason is None else str(reason)[:300]
                else:
                    value = got
                if value is not None and not _finite(value):
                    value, reason = None, "unavailable: the metric did not return a finite number"
                elif value is None and not reason:
                    reason = "undefined for this evidence"
            except Exception as e:                             # a third-party metric must never break an evaluation
                value, reason = None, f"unavailable: the metric failed ({type(e).__name__}: {str(e)[:160]})"
        if m.id in CORE:
            metrics[m.id] = None if value is None else float(value)
            if value is None:
                reasons[m.id] = reason
        else:
            extra.append(dict(id=m.id, label=m.label, description=m.description, source=m.source,
                              value=None if value is None else float(value), reason=reason))
    return {k: metrics[k] for k in CORE}, reasons, extra


# ---------------------------------------------------------------------------------------------- evaluation
def evaluate(evidence: dict, threshold: float | None = None) -> dict:
    """The evaluation of a validated evidence document (:func:`validate`), in the shape of
    :meth:`move_openlab.problem.Problem.ml_evaluations` plus its provenance, the sweep and the recorded decision.

    ``threshold`` recomputes a threshold-rule evaluation at an exploratory threshold: ``exploratory`` is then true,
    ``confusion`` and ``metrics`` are those of that threshold, and ``recorded_decision`` still holds the decision,
    matrix and metrics recorded with the evidence. It is ignored for hard predictions (``threshold_adjustable``
    false)."""
    recs, dec = evidence["records"], evidence["decision"]
    rule, recorded_t, policy = dec["rule"], dec.get("threshold"), dec.get("policy")
    labels = [r["label"] for r in recs]
    has_scores = all("score" in r for r in recs)
    raw = [r["score"] for r in recs] if has_scores else None
    adjustable = rule in THRESHOLD_RULES
    if threshold is not None and not _finite(threshold):
        raise EvidenceError("threshold must be a finite number")
    n, pos = len(recs), sum(labels)

    def figures(t: float | None) -> tuple[dict, dict, dict, list[dict]]:
        preds = [_decide(s, rule, t) for s in raw] if adjustable else [r["prediction"] for r in recs]
        c = confusion(labels, preds)
        oriented = None if raw is None else tuple(-s for s in raw) if rule == "score<=threshold" else tuple(raw)
        m, why, extra = compute_metrics(dict(c, n=n, positives=pos, negatives=n - pos, labels=tuple(labels),
                                             predictions=tuple(preds), scores=oriented, rule=rule, threshold=t))
        return c, m, why, extra

    rec_c, rec_m, rec_why, rec_extra = figures(recorded_t)
    recorded = dict(rule=rule, threshold=recorded_t, policy=policy, decision=_decision_text(rule, recorded_t, policy),
                    confusion=rec_c, metrics=rec_m, metric_reasons=rec_why)
    exploratory = adjustable and threshold is not None and float(threshold) != recorded_t
    eff_t = float(threshold) if exploratory else recorded_t
    c, m, why, extra = figures(eff_t) if exploratory else (rec_c, rec_m, rec_why, rec_extra)
    points, score_range = [], None
    if adjustable:
        ranked = _Ranked(labels, raw, rule)
        points = _sweep(ranked, (recorded_t,))
        score_range = [ranked.scores[0], ranked.scores[-1]]
    decision_text = (_decision_text(rule, eff_t) + " — exploratory threshold, not the recorded decision") if exploratory \
        else recorded["decision"]
    scores_basis = ("the scores of the evidence (independent of the threshold)" if has_scores
                    else "not available: the evidence has no score for every record")
    return dict(
        population=evidence["dataset"]["population"], split=evidence["dataset"]["split"], unit=evidence["dataset"]["unit"],
        graphs=None, candidates=n, records=n, positives=pos, prevalence_pct=round(100 * pos / n, 4),
        decision=decision_text, positive_label=evidence["positive_label"],
        convention="label 1 = positive; " + ("predicted positive when " + _decision_text(rule, eff_t) if adjustable
                                             else "predictions as provided (1 = positive)"),
        confusion=c, metrics=m, metric_reasons=why, extra_metrics=extra,
        metric_basis=dict(roc_auc=scores_basis, other=decision_text),
        notes=list(evidence["notes"]),
        provenance=dict(dataset=dict(evidence["dataset"]), model=dict(evidence["model"]),
                        feature_pipeline=dict(evidence["feature_pipeline"]), decision=dict(dec), method_id=evidence["method_id"]),
        has_scores=has_scores, threshold_adjustable=adjustable, threshold=eff_t, exploratory=bool(exploratory),
        recorded_decision=recorded, sweep=points, score_range=score_range)
