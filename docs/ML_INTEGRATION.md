# Integrating a learned method

A learned method uses a model — a classifier, a ranker, a scorer — to decide or to prepare a decision. In MOVE
OpenLab it is a method like any other ([SOLVER_INTEGRATION.md](SOLVER_INTEGRATION.md)): it returns decisions, and the
problem's validator recomputes everything. What this page adds is specific to learning: candidate scoring and
thresholds, the candidate-reduction view and its preview, the ML evaluation contract, and two rules that keep
learned results honest.

The framework ships **no trained model and no learned scorer**. The two public problems provide transparent,
non-learned scorers so that the mechanism can be studied; a learned scorer or a learned method comes with a problem
package that carries its own model, or as a plug-in a researcher adds
([an ML-assisted method without a problem package](#an-ml-assisted-method-without-a-problem-package)).

## Two rules

1. **No metric is invented.** Accuracy, precision, recall, F1, PR-AUC and ROC-AUC are shown only from real predictions
   and real labels on a named population: provided by the problem package, or imported by a researcher as
   [evaluation evidence](#importing-evaluation-evidence). They are never derived from solver outcomes, never
   estimated, never filled with zero. Without labelled predictions the interface shows the reason.
2. **A learned method states where it cannot run.** A model is valid on the kind of data it was trained for. A method
   says so in its `description`; a scenario outside that domain carries a note (`Problem.scenario_notes`); and when
   the data a method needs is missing, it fails explicitly — the run is kept as rejected with its error — instead of
   returning a silent fallback.

## Kinds of method

| `kind` | Meaning | What an `OPTIMAL` status proves |
|---|---|---|
| `learned` | the model produces the decisions | nothing: shown as *feasible, optimality not proven* |
| `hybrid` | a learned reduction of the candidates, then an exact solver on what is left | optimality **of the reduced model** only, never of the full problem |

A hybrid method does its reduction inside `solve`. A reduction applied by the platform, outside the method, is a
threshold study (below).

## An ML-assisted method without a problem package

A plug-in declares its kind in `METADATA` like any method ([ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md)): `"kind":
"learned"` or `"kind": "hybrid"` is all it takes for the platform to treat it as a method that makes predictions —
its results are never reported as proven optimal for the full problem, and the ML evaluation is offered for it.

`plugins/example_scored_filter/` is a worked example for the public ride-matching problem, registered through *Add
method* like the other example plug-ins:

- it scores every compatible driver–rider pair from two features known before solving, removes the pairs scored
  below a threshold, then matches greedily on the pairs that are left;
- **it is an example of the interface, not a trained model**: the "model" is a linear score with two weights written
  by hand. Replace its `score` function with your own model to make it a real learned method;
- **no evaluation figure ships with it.** Its card in *ML evaluation* says *Not available — import evaluation
  evidence* until evidence about it is imported.

```bash
.venv/bin/move-openlab method check plugins/example_scored_filter
```

To evaluate such a method you produce the evidence yourself: run your scorer on scenarios you name, write one record
per candidate with the score your method gave it and the label you define (for example *the pair is used by the exact
method's validated solution on that scenario*), and import the file (next section). The platform computes the figures;
what the records are is your statement.

## Candidate scoring

A problem may expose **candidate decisions** — the options a solution is built from, for example the compatible
pairs of an assignment — and **scorers** that give each candidate a score.

| Hook of `Problem` | Returns |
|---|---|
| `supports_candidates()` | `True` when the problem exposes candidates |
| `candidates(instance)` | `[{"id": str, "groups": [str, ...], "features": {...}}]` |
| `decision_candidate(decision)` | the candidate id a decision uses |
| `restrict(instance, keep, derivation)` | a new instance that keeps only the given candidates, with `derivation` recorded and a new hash |
| `scorers()` | `{scorer id: Scorer}` |

A scorer subclasses `move_openlab.scoring.Scorer` (`id`, `label`, `description`, `learned`) and implements
`score(instance, candidates)`, returning `{candidate id: score or None}`. It sees the instance only — information
available before solving — never a solution.

Selection rules (`move_openlab.scoring`):

- **Absolute threshold**: a candidate is kept when its score is at least the threshold and, when `top_k` is set, it
  is among the `top_k` best-scored candidates of at least one of its groups.
- **Share**: the best-scored share of the scored candidates of each instance is kept; the effective threshold is the
  score of the last kept candidate, and every candidate tied at that score is kept.
- **Unscored candidates are always kept**, so a scorer never removes what it did not evaluate.
- Ties are broken by candidate id: the selection is deterministic.

Shipped scorers, both transparent and not learned: `relative-detour` (ride matching) and `relative-cost` (synthetic
assignment), next to `keep-all`.

## Threshold studies

A threshold study answers: how far can candidates be pruned before solution quality degrades?

```
POST /api/campaigns/{id}/threshold-study
{"method": ["exact-matching-highs", "1.0.0"], "scorer": "relative-detour", "thresholds": [0.25, 0.5, 0.75, 1], "mode": "absolute"}
```

`mode` is `absolute` (fixed thresholds, optional `top_k`) or `share` (values in (0, 1], no `top_k`); at most twelve
values. The study is a new experiment derived from its parent: for every scenario and value it builds a pruned copy
of the instance (`Problem.restrict`) and runs the one method on it. The parent's runs of the same method on the full
instances are the reference — a reference, not a ground truth.

`GET /api/campaigns/{id}/threshold-report` gives, per scenario and value:

| Figure | Meaning |
|---|---|
| `kept_share` | candidates kept ÷ candidates of the full instance |
| `feasible_on_original` | the pruned solution re-validated on the original instance |
| `equal_objective` | every objective level equals the full-instance run |
| `final_level_gap_pct` | relative gap on the last level where the earlier levels are equal (positive = worse) |
| `level1_shortfall` | deficit on the first level (positive = worse) |
| `reference_recall` | share of the full-instance solution's decisions still available after pruning |
| `time_ratio` | median total time pruned ÷ full |

Results on pruned instances are labelled *optimal for the reduced instance only*. In the interface a threshold study
is created and read from an experiment's record under *Library › Experiments*.

## Thresholds as method settings

A hybrid method exposes its own threshold — and any protection rule — as settings in `config_schema`, like a solver
time limit. They are then validated, recorded with the experiment and with every run, and a change creates a new
experiment version ([SOLVER_INTEGRATION.md](SOLVER_INTEGRATION.md#settings-a-researcher-may-choose)).
`Problem.method_display_name(method_id, config)` may give the method a name that depends on those settings (for
example which policy a threshold selects); the recorded name stays in the record.

## Candidate view and preview

Two optional hooks let the Workspace show what a reduction did, or would do, on the map
([MAPS.md](MAPS.md#routes-and-logical-candidate-edges)).

| Hook | Declares | Served by | Shows |
|---|---|---|---|
| `candidate_view(instance, run)` | the capability `candidates` | `GET /api/geo/candidates/{campaign}/{run}` | for a recorded run: every candidate (**Before**), retained, removed and kept by a structural rule (**After**), and the candidates the validated solution uses (**Solution**) |
| `candidate_preview(instance, method, config)` | the capability `candidate-preview` | `POST /api/geo/candidates/preview` | the reduction a method **would** apply to the shown scenario with the settings being edited: nothing is solved, nothing is stored |

`candidate_view` returns `{stops, vehicles, edges, removed, protected, selected, counts, policy, checks, sources,
geometry}` built from recorded data only — it is never recomputed. `candidate_preview` returns the same shape plus
`preview: true`, `timings` (for example the inference time) and `provenance` (model, policy, feature pipeline). Both
raise `ValueError` when the data behind the request is not available; the interface shows that message.

The preview's settings are validated against the method's schema before the problem is called. The Workspace offers
*Preview reduction* for a method of the open experiment whose settings include one named `threshold`, when the
problem declares `candidate-preview`.

## ML evaluation

```python
def ml_evaluations(self, method_id: str, config: dict) -> list[dict]:
    return [{
        "population": "held-out scenarios", "split": "test", "graphs": 40, "candidates": 12000,
        "positives": 900, "prevalence_pct": 7.5,
        "decision": "score >= 0.5", "positive_label": "candidate used by the reference solution",
        "convention": "positive = keep",
        "confusion": {"tp": 0, "fn": 0, "fp": 0, "tn": 0},
        "metrics": {"accuracy": 0.0, "balanced_accuracy": 0.0, "precision": 0.0, "recall": 0.0,
                    "specificity": 0.0, "f1": 0.0, "pr_auc": 0.0, "roc_auc": 0.0},
        "source": {"name": "evaluation file shipped with the problem package", "sha256": "..."},
        "notes": [],
    }]
```

The values above only show the shape: a problem returns the figures of its own evaluation files, with the SHA-256 of
the file they were read from. `decision` says which score and threshold or policy produced the confusion matrix. A
problem returns `[]` when no labelled evaluation exists.

`GET /api/lab/experiments/{id}/evaluation?method_id=…` answers for one method of an experiment:

| Case | `available` | `reason` |
|---|---|---|
| The method is `exact` or `heuristic` | `false` | *Not applicable: this method makes no predictions (it has no learned classifier).* |
| Neither the problem nor imported evidence gives an evaluation | `false` | *Not available: labelled predictions are needed (true labels and the method's predictions on a named evaluation population). None are provided for this method.* |
| The problem's evaluation data cannot be read, and nothing was imported | `false` | *Not available: the evaluation data could not be read (…).* |
| Evaluations exist | `true` | — |

`evaluations` lists the evaluations the problem provides first (`origin: "adapter"`, exactly as the problem returned
them), then those computed from imported evidence (`origin: "imported"`). The answer also carries `can_import`
(false for an exact or heuristic method), `withdrawn` (how many imported evidences are hidden), `adapter_error` and
`evidence_errors` (a stored file that no longer verifies is named with its reason, never evaluated).

In the interface: **Compare → Methods → ML evaluation** shows one card per method: the confusion matrix (TP, FN, FP,
TN, each named), a tile per classification figure, and where the evaluation comes from — a badge *provided by the
problem package* or *imported evidence*, the dataset, split and population, the decision rule and threshold, the
model, the feature pipeline and the SHA-256 of the evidence. An exact or heuristic method shows *Not applicable*
with the reason; a learned method without evidence shows *Not available — import evaluation evidence* and the
button to import some; neither shows a number. In *Choose metrics*, the ML evaluation group lists Accuracy,
Precision, Recall, F1, PR-AUC and ROC-AUC when the experiment has a learned or hybrid method; they are figures of an
evaluation population, so they are shown for *All scenarios* and not for one scenario, and they always use the
recorded decision.

The share of a reference solution's candidates that a run retained is a different measure: it describes one run on
one scenario and belongs to the run facts ([METRICS.md](METRICS.md#run-facts)), not to the ML evaluation.

## Importing evaluation evidence

A researcher can give the evidence for a learned or hybrid method of one of their experiments: the method's real
predictions and the ground-truth labels, record by record. MOVE OpenLab validates the file, stores it and computes
the confusion matrix and the metrics (`move_openlab.analysis.ml_evaluation`). It cannot check that the records are
the method's real predictions: importing them is the researcher's statement, shown with their name and the date.

In the interface: *ML evaluation* → **Import evaluation evidence** on the method's card → choose a JSON or CSV file.
A refusal is shown in the dialog with its reason, and nothing is stored.

### The evidence format

`move-openlab/ml-evaluation-evidence@1`, a JSON document:

```json
{
  "format": "move-openlab/ml-evaluation-evidence@1",
  "method_id": "my-learned-method",
  "model": {"name": "pair scorer", "version": "2.1.0", "sha256": "<64 hex, optional>", "training_data": "optional"},
  "feature_pipeline": {"name": "pair features", "version": "1.0.0", "description": "relative detour, time to pickup"},
  "dataset": {"id": "held-out-2026-10", "split": "test",
              "population": "all compatible pairs of the 40 held-out scenarios", "unit": "one driver-rider pair"},
  "positive_label": "the pair is used by the exact method's validated solution",
  "decision": {"rule": "score>=threshold", "threshold": 0.5, "policy": "optional text"},
  "records": [{"id": "s01:D3:R7", "label": 1, "score": 0.83}, {"id": "s01:D3:R9", "label": 0, "score": 0.12}],
  "notes": "optional text, or a list of texts"
}
```

| Field | Meaning |
|---|---|
| `method_id` | the method of the experiment the evidence is about; it must be a learned or hybrid method of that experiment |
| `model`, `feature_pipeline` | what produced the scores: name and version are required, the digest of the weights is recommended |
| `dataset` | `id` and `split`; `population` — its definition in words; `unit` — what one record is |
| `positive_label` | what label 1 means |
| `decision.rule` | `score>=threshold` (a higher score means positive), `score<=threshold` (a lower score means positive), or `predictions` (the records carry the decisions) |
| `records` | `id` (unique), `label` (0 or 1), `score` (a finite number) and / or `prediction` (0 or 1) |

With a threshold rule every record needs a score, and a `prediction` given as well must agree with the rule. With
`predictions` every record needs a prediction; scores are then given for every record or for none, and a higher
score means *more likely positive*.

**CSV.** The records alone can be a CSV file with a header: `id,label,score` and, optionally, `prediction` (columns in
any order). The other fields are typed in the dialog — or sent as the form field `metadata`, a JSON object — and are
stored with the records.

**Refused, with the reason** (HTTP 422; 413 above a limit): a label that is missing or not 0 or 1; a score that is
not a finite number (NaN and infinity included); a duplicate `id`; an empty file; a record with neither a score nor a
prediction; a threshold rule without a threshold; missing `dataset`, `split`, `population`, `unit`, `model` or
`feature_pipeline` provenance; an unknown field; a method that is not in the experiment, or that is exact or
heuristic (*Not applicable*). Limits: 8 MB per file and 200 000 records.

### What is computed

| Figure | Definition | Undefined when |
|---|---|---|
| Confusion matrix | TP, FN, FP, TN of the labels against the decision | — |
| Accuracy | (TP + TN) ÷ records | — |
| Precision | TP ÷ (TP + FP) | no record is predicted positive |
| Recall | TP ÷ (TP + FN) | the labels contain no positive |
| Specificity | TN ÷ (TN + FP) | the labels contain no negative |
| Balanced accuracy | mean of recall and specificity | the labels contain only one class |
| F1 | harmonic mean of precision and recall (0 when both are 0) | precision or recall is undefined |
| ROC-AUC | rank-based (Mann–Whitney): tied scores share their average rank | no score for every record, or only one class |
| PR-AUC | average precision: precision at each distinct score, weighted by the recall gained there | no score for every record, or no positive |
| Matthews correlation coefficient | (TP·TN − FP·FN) ÷ √((TP+FP)(TP+FN)(TN+FP)(TN+FN)) | a class is missing from the labels or the predictions |

An undefined figure is *Not available* with its reason (`metrics[id]` is `null`, the reason is in
`metric_reasons[id]`) — never zero.

**Threshold.** For a threshold rule the answer carries `threshold_adjustable: true`, the range of the scores and a
`sweep`: precision, recall, F1 and the share of records predicted positive at every distinct score, or at 101 of them
evenly spaced when there are more. The card draws them as a curve with a number field and a slider.
`GET …/evaluation?method_id=…&threshold=0.7` recomputes the matrix and the metrics at that threshold from the stored
records: the answer is flagged `exploratory: true` and still carries the recorded decision with its own matrix and
metrics (`recorded_decision`). Nothing is stored, and the Results table keeps the recorded decision. The two areas do
not depend on the threshold.

### Storage, and what it does not change

```
POST /api/lab/experiments/{id}/evaluation                          file (+ method_id, metadata for a CSV)
GET  /api/lab/experiments/{id}/evaluation/evidence/{sha256}        the stored document, byte for byte
POST /api/lab/experiments/{id}/evaluation/evidence/{sha256}/withdraw
```

- The evidence is stored in the researcher's own workspace, in an owner-only file named by its SHA-256
  (`<data>/workspaces/<user>/ml_evaluations/<experiment>/<sha256>.json`): a JSON file exactly as uploaded, a CSV as
  the JSON document built from it. The file is checked against its name at every read.
- **The experiment record is not modified.** Evidence is kept beside the experiment, so a locked experiment keeps its
  checksum, and an imported, read-only experiment can receive evidence too.
- Access is the experiment's: another account, or an account without the grant of a restricted problem, gets 404.
- Importing and withdrawing are written to the audit log. The same file imported twice is stored once.
- **Nothing is deleted.** *Withdraw this evidence…* hides it from the evaluation; the file stays, and importing the
  same file again shows it again.
- **Evidence can travel with the experiment bundle** (section `ml_evaluations/`, see below). Withdrawn evidence
  never travels; evaluations a problem package provides itself are not exported (they come from the package installed
  at the other end).

### Evidence in an experiment bundle

*Export* lists the imported evidence of the records it exports and offers three choices:

| Choice (`ml_evidence=`) | What the bundle carries | What the receiver can do |
|---|---|---|
| **Include the evidence** (`full`, default) | each evidence document (predictions, labels, provenance) as `ml_evaluations/<sha256>.json`, and `ml_evaluations/index.json` | the import re-validates every document, recomputes the confusion matrix and every metric, and refuses the bundle if a figure differs from the recorded one; the threshold can be explored as at the source |
| **References only** (`reference`) | `ml_evaluations/index.json` only: evaluation population, dataset id and split, positive label, decision (rule, threshold, policy), model and feature-pipeline metadata, metric definitions, the recorded matrix and metrics, the evidence SHA-256 | the evaluation is shown with *reference received with a bundle* and *not recomputable here*; there is no threshold curve and no download. Use it when predictions or labels may not be redistributed |
| **Leave out** (`none`) | nothing | no evaluation for these records |

The index (`move-openlab/ml-evaluation-section@1`) names, for every entry, the record and the method; the method must
be a learned or hybrid method of that record. Every file of the section is listed with its SHA-256 in the manifest, and
an evidence document must be named by its own SHA-256; an unreferenced file is refused. Received documents are stored
beside the imported experiment exactly like a manual import (source: the bundle and its SHA-256); the experiment
record is unchanged. Evidence received as a reference can only be passed on as a reference.

An installation older than this version reads bundles without this section only: it refuses one with the section and
says that a newer version wrote it — nothing is imported. An experiment without imported evidence gives the same bundle
whatever the choice.

### A synthetic file to try it

[`examples/ml-evaluation/`](../examples/README.md#c-ml-evaluation-evidence--synthetic-example) holds 400 synthetic
records in both forms, with the confusion matrix they give at their recorded threshold. They are artificial: they
describe no model and no method.

## Metric adapters

Classification metrics are functions in a small registry (`ml_evaluation.metric_registry()`). An installed package
adds its own through the entry-point group `move_openlab.ml_metrics`:

```toml
[project.entry-points."move_openlab.ml_metrics"]
my-metrics = "my_package.metrics:METRICS"
```

```python
from move_openlab.analysis.ml_evaluation import ClassificationMetric

def false_positive_rate(ctx):
    if not ctx["negatives"]:
        return None, "undefined: the labels contain no negative"
    return ctx["fp"] / ctx["negatives"]

METRICS = [ClassificationMetric("false_positive_rate", "False positive rate", false_positive_rate,
                                description="share of the negatives predicted positive")]
```

`ctx` holds `tp`, `fn`, `fp`, `tn`, `n`, `positives`, `negatives`, `labels`, `predictions`, `scores` (oriented so that
higher means more likely positive, or `None`), `rule` and `threshold`. A metric returns a finite number, `None`, or
`(None, reason)`; with `needs_scores=True` it is not called when the evidence has no scores. Additional metrics are
listed under the tiles with the package they come from (`extra_metrics`).

A metric that raises, or returns anything but a finite number, is reported as unavailable with its reason: it never
breaks an evaluation, and it cannot replace a built-in metric. A metric adapter is installed code, trusted like a
problem package (it runs in the server process); it is not a sandboxed plug-in.

## What a learned method records with each run

Through `Problem.run_fact_definitions()` and `run_facts(run, instance)`, a problem shows what a method recorded:
candidates removed, time spent in inference before solving, the solver's own status or gap. A fact may be placed in
the ML group (`category: "ml"`), and one time fact may be flagged `speedup: true` so that *reference ÷ this* is
offered as a speed-up. Facts come from the recorded run, never from a new computation.

## Models, weights and reproducibility

- Bundles carry records, never code and never a model. A colleague who wants to re-run a learned method installs the
  same problem package, with the same model.
- This repository accepts no archive and no binary model file (the public-safety check refuses, among others,
  `.pkl`, `.joblib`, `.onnx`, `.npz` and any file above 1 MB). A model ships with the problem package that uses it.
- Declare `deterministic` truthfully. Workers run with a fixed `PYTHONHASHSEED` and one OpenMP thread; a
  reproduction compares validated metrics cell by cell and reports any difference.
- Record what identifies the model (name, version, a digest of the weights) in the run's `metadata` or
  `diagnostics`, so that two runs can be told apart.
