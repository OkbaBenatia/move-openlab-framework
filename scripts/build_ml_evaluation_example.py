#!/usr/bin/env python3
"""Build the public example of ML evaluation evidence: SYNTHETIC binary-classification records in the two accepted
forms (a JSON evidence document and a CSV of records). Deterministic (fixed seed): running it again writes the same
bytes.

The records are artificial. They are not a mobility result, they were not produced by any model, and they describe no
method of MOVE OpenLab or of anyone else: labels and scores are drawn from a seeded random generator so that the
confusion matrix at the recorded threshold (score >= 0.5) is known by construction:

    TP = 96   FN = 24   FP = 28   TN = 252      (400 records, 120 positives)

Their only purpose is to try the import and the computation (docs/ML_INTEGRATION.md): the figures obtained from them
say nothing about any method.

    python scripts/build_ml_evaluation_example.py        # writes examples/ml-evaluation/
"""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "examples" / "ml-evaluation"
JSON_NAME, CSV_NAME = "synthetic-binary-evidence.json", "synthetic-binary-evidence.csv"
FORMAT = "move-openlab/ml-evaluation-evidence@1"
SEED, THRESHOLD = 20261116, 0.5
CELLS = dict(tp=96, fn=24, fp=28, tn=252)                 # the confusion matrix built into the records
METHOD_ID = "synthetic-example-classifier"                # a placeholder: no such method exists


def records() -> list[dict]:
    """400 records: scores have three decimals (so some are tied), above or below the threshold as their cell says."""
    rng = random.Random(SEED)

    def high() -> float:                                   # a score in [0.500, 0.999], denser near the top
        return round(0.5 + 0.499 * max(rng.random(), rng.random()), 3)

    def low() -> float:                                    # a score in [0.000, 0.499], denser near the bottom
        return round(0.499 * min(rng.random(), rng.random()), 3)

    def middle_high() -> float:                            # the errors lie closer to the threshold
        return round(0.5 + 0.499 * min(rng.random(), rng.random()), 3)

    def middle_low() -> float:
        return round(0.499 * max(rng.random(), rng.random()), 3)

    rows = ([(1, high()) for _ in range(CELLS["tp"])] + [(1, middle_low()) for _ in range(CELLS["fn"])]
            + [(0, middle_high()) for _ in range(CELLS["fp"])] + [(0, low()) for _ in range(CELLS["tn"])])
    for i in range(len(rows) - 1, 0, -1):                  # Fisher-Yates with the seeded generator
        j = int(rng.random() * (i + 1))
        rows[i], rows[j] = rows[j], rows[i]
    return [dict(id=f"rec-{k + 1:04d}", label=label, score=score) for k, (label, score) in enumerate(rows)]


def evidence(recs: list[dict]) -> dict:
    return {
        "format": FORMAT,
        "method_id": METHOD_ID,
        "model": {"name": "SYNTHETIC score generator (not a model)", "version": "1.0.0",
                  "training_data": "none: the scores are drawn from a seeded random generator"},
        "feature_pipeline": {"name": "none (synthetic)", "version": "1.0.0",
                             "description": "No features: every score is drawn at random by scripts/build_ml_evaluation_example.py."},
        "dataset": {"id": "synthetic-binary-example-v1", "split": "synthetic",
                    "population": "SYNTHETIC — 400 artificial records with random labels and scores; not a mobility "
                                  "result and not the output of any model",
                    "unit": "one artificial record"},
        "positive_label": "label 1 of the synthetic generator (it has no real-world meaning)",
        "decision": {"rule": "score>=threshold", "threshold": THRESHOLD},
        "records": recs,
        "notes": ["SYNTHETIC EXAMPLE. These figures describe artificial records only; they evaluate no method.",
                  "Built by scripts/build_ml_evaluation_example.py (seed 20261116). Confusion matrix at score >= 0.5 "
                  "by construction: TP 96, FN 24, FP 28, TN 252."],
    }


def build() -> dict[str, bytes]:
    recs = records()
    doc = json.dumps(evidence(recs), indent=1, ensure_ascii=False) + "\n"
    table = "id,label,score\n" + "".join(f"{r['id']},{r['label']},{r['score']:.3f}\n" for r in recs)
    return {JSON_NAME: doc.encode("utf-8"), CSV_NAME: table.encode("utf-8")}


def main() -> None:
    recs = records()
    got = dict(tp=sum(r["label"] == 1 and r["score"] >= THRESHOLD for r in recs), fn=sum(r["label"] == 1 and r["score"] < THRESHOLD for r in recs),
               fp=sum(r["label"] == 0 and r["score"] >= THRESHOLD for r in recs), tn=sum(r["label"] == 0 and r["score"] < THRESHOLD for r in recs))
    if got != CELLS:                                       # nothing is written unless the records give the announced matrix
        raise SystemExit(f"the records give {got}, not {CELLS}")
    OUT.mkdir(parents=True, exist_ok=True)
    files = build()
    for name, data in files.items():
        (OUT / name).write_bytes(data)
    sums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(files.items()))
    (OUT / "SHA256SUMS").write_text(sums)
    print(f"wrote {len(recs)} synthetic records to {OUT.relative_to(ROOT)}: {got}")
    print(sums, end="")


if __name__ == "__main__":
    main()
