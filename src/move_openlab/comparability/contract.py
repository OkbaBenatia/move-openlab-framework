"""Claim-dependent comparability contract.

``check(problem, e1, e2, claim)`` returns a decision with

``status``          DIRECT | CONDITIONAL | INCOMPATIBLE — for this claim only
``incompatible``    dimensions that invalidate the claim
``qualifications``  conditions under which a CONDITIONAL comparison remains meaningful
``notes``           differences that were detected but do not affect the claim (e.g. non-binding changes)
``normalization``   the verified rule applied, if any
``evidence``        fingerprints and component-level differences (machine-readable)

Claims
  ``quality``  "method M2 obtains a better / equal / worse objective than M1 on the same optimization problem"
  ``runtime``  "method M2 is faster / slower than M1 on the same optimization problem"

Rules (the final status is the most restrictive one)
  quality   problem fingerprint differs (region, coefficients or objective)            -> INCOMPATIBLE
            invalid or infeasible result                                                -> INCOMPATIBLE
            evaluation contract differs and no verified transformation exists          -> INCOMPATIBLE
            evaluation contract differs only by a registered verified transformation   -> CONDITIONAL (normalised)
            time budget differs                                                         -> CONDITIONAL
            same method, different method options                                       -> CONDITIONAL
            environment differs                                                         -> note (results re-validated)
  runtime   problem fingerprint differs                                                 -> INCOMPATIBLE
            timing definitions differ                                                   -> INCOMPATIBLE
            environment descriptor differs                                              -> CONDITIONAL
            time budget or repetition count differs                                     -> CONDITIONAL
            metric definitions differ                                                   -> note
Different methods are never a reason to refuse a comparison: comparing methods is the purpose of a benchmark.
"""
from __future__ import annotations

from ..problem import Problem

DIRECT, CONDITIONAL, INCOMPATIBLE = "DIRECT", "CONDITIONAL", "INCOMPATIBLE"
ORDER = {DIRECT: 0, CONDITIONAL: 1, INCOMPATIBLE: 2}
CLAIMS = ("quality", "runtime")
CONTRACT_VERSION = "move-openlab-comparability/1.0.0"

# Verified transformations between evaluation contracts. Each states its proof; nothing else is normalised.
VERIFIED_TRANSFORMS = {
    "metric-positive-scaling": dict(
        applies="the two contracts are identical except the scale (and unit label) of one metric, both scales > 0",
        rule="canonical_value = reported_value / scale",
        proof="v -> k*v with k > 0 is strictly increasing and invertible: it preserves every order and tie between "
              "values of that metric, hence any lexicographic order using it, and v = (k*v)/k recovers the value.",
        verified_on_data="normalised values are checked against the validator-recomputed canonical values"),
}


def _worst(a: str, b: str) -> str:
    return a if ORDER[a] >= ORDER[b] else b


def problem_differences(problem: Problem, e1: dict, e2: dict) -> dict:
    f1, f2 = e1["P"]["fingerprint"], e2["P"]["fingerprint"]
    dims, nonbinding = [], []
    if f1["objective"] != f2["objective"]:
        dims.append(dict(dimension="objective", detail=f"{e1['P']['objective_id']} vs {e2['P']['objective_id']}"))
    elif e1["P"]["objective_id"] != e2["P"]["objective_id"]:
        nonbinding.append(dict(dimension="objective name", detail="different identifiers, identical objective definition"))
    ex = problem.explain_problem_differences(e1["_instance"], e2["_instance"])
    dims += ex.get("dimensions", [])
    nonbinding += ex.get("nonbinding", [])
    same = f1["problem"] == f2["problem"]
    if same != (not dims):
        # internal consistency guard: the fingerprint and the component analysis must agree
        raise RuntimeError(f"problem fingerprint and component analysis disagree for {problem.problem_id}")
    return dict(identical=same, dimensions=dims, nonbinding=nonbinding)


def evaluation_differences(e1: dict, e2: dict) -> dict:
    v1, v2 = e1["V"]["contract"], e2["V"]["contract"]
    if e1["V"]["fingerprint"] == e2["V"]["fingerprint"]:
        return dict(identical=True, timing_identical=True, fields=[], transform=None, metric=None)
    fields = []
    for k in sorted(set(v1) | set(v2)):
        if k == "metrics" and isinstance(v1.get(k), dict) and isinstance(v2.get(k), dict):
            for m in sorted(set(v1[k]) | set(v2[k])):
                a, b = v1[k].get(m) or {}, v2[k].get(m) or {}
                fields += [f"metrics.{m}.{s}" for s in sorted(set(a) | set(b)) if a.get(s) != b.get(s)]
        elif v1.get(k) != v2.get(k):
            fields.append(k)
    transform, metric = None, None
    touched = {f.split(".")[1] for f in fields if f.startswith("metrics.")}
    if len(touched) == 1 and all(f.startswith("metrics.") for f in fields):
        m = touched.pop()
        if set(fields) <= {f"metrics.{m}.scale", f"metrics.{m}.unit"} and f"metrics.{m}.scale" in fields:
            s1, s2 = v1["metrics"][m].get("scale"), v2["metrics"][m].get("scale")
            if isinstance(s1, (int, float)) and isinstance(s2, (int, float)) and s1 > 0 and s2 > 0:
                transform, metric = "metric-positive-scaling", m
    return dict(identical=False, timing_identical=v1.get("timing") == v2.get("timing"), fields=fields,
                transform=transform, metric=metric)


def config_differences(e1: dict, e2: dict) -> dict:
    c1, c2 = e1["C"], e2["C"]
    same_method = (e1["M"]["method_id"], e1["M"]["version"]) == (e2["M"]["method_id"], e2["M"]["version"])
    return dict(budget=c1.get("time_budget_s") != c2.get("time_budget_s"),
                budgets=(c1.get("time_budget_s"), c2.get("time_budget_s")),
                repetitions=c1.get("repetitions") != c2.get("repetitions"), same_method=same_method,
                method_options=same_method and (c1.get("method_options") or {}) != (c2.get("method_options") or {}))


def env_differences(e1: dict, e2: dict) -> list[str]:
    a, b = e1["ENV"]["descriptor"], e2["ENV"]["descriptor"]
    return [k for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]


def check(problem: Problem, e1: dict, e2: dict, claim: str) -> dict:
    if claim not in CLAIMS:
        raise ValueError(f"unknown claim {claim!r}")
    pd, ed = problem_differences(problem, e1, e2), evaluation_differences(e1, e2)
    cd, envd = config_differences(e1, e2), env_differences(e1, e2)
    status, incompatible, qual, notes, norm = DIRECT, [], [], [], None
    notes += [f"{n['dimension']}: {n['detail']}" for n in pd["nonbinding"]]
    if not pd["identical"]:
        status = INCOMPATIBLE
        incompatible += [f"{d['dimension']}: {d['detail']}" for d in pd["dimensions"]]
    if claim == "quality":
        if not (e1["R"]["feasible"] and e2["R"]["feasible"]):
            status = INCOMPATIBLE
            incompatible.append("result validity: at least one result is infeasible")
        if not ed["identical"]:
            if ed["transform"]:
                status, norm = _worst(status, CONDITIONAL), ed["transform"]
                qual.append(f"evaluation contracts differ in {ed['fields']}: compared after the verified rule '{norm}'")
            else:
                status = INCOMPATIBLE
                incompatible.append(f"evaluation contract: {ed['fields']} differ and no verified equivalence rule exists")
        if cd["budget"]:
            status = _worst(status, CONDITIONAL)
            qual.append(f"time budgets differ {cd['budgets']}: quality differences cannot be attributed to the method alone")
            if e1["R"]["certified_optimal"] and e2["R"]["certified_optimal"]:
                notes.append("both results are certified optimal: the budget was not binding for them")
        if cd["method_options"]:
            status = _worst(status, CONDITIONAL)
            qual.append("same method run with different options")
        if envd:
            notes.append(f"environment differs in {envd}: objective values were re-validated independently and are unaffected")
    else:
        if not ed["timing_identical"]:
            status = INCOMPATIBLE
            incompatible.append("timing definitions differ")
        if envd:
            status = _worst(status, CONDITIONAL)
            qual.append(f"execution environments differ in {envd}: runtime differences are confounded with the environment")
        if cd["budget"]:
            status = _worst(status, CONDITIONAL)
            qual.append(f"time budgets differ {cd['budgets']}")
        if cd["repetitions"]:
            status = _worst(status, CONDITIONAL)
            qual.append("different numbers of repetitions behind the medians")
        if not ed["identical"] and ed["timing_identical"]:
            notes.append(f"metric definitions differ in {ed['fields']}: irrelevant to a runtime claim")
    supported = {"quality": "objective-quality comparison" + (" after normalisation" if norm else ""),
                 "runtime": "runtime comparison"}[claim]
    return dict(contract=CONTRACT_VERSION, claim=claim, status=status, incompatible=incompatible, qualifications=qual,
                notes=notes, normalization=dict(VERIFIED_TRANSFORMS[norm], name=norm, metric=ed["metric"]) if norm else None,
                supported_comparison=None if status == INCOMPATIBLE else supported,
                evidence=dict(
                    raw_artifact_hash_equal=e1["I"]["raw_artifact_hash"] == e2["I"]["raw_artifact_hash"],
                    problem_fingerprint_equal=pd["identical"],
                    problem_components_equal={k: e1["P"]["fingerprint"][k] == e2["P"]["fingerprint"][k]
                                              for k in ("region", "coefficients", "objective")},
                    evaluation_fingerprint_equal=ed["identical"], evaluation_fields_different=ed["fields"],
                    environment_fingerprint_equal=not envd, environment_fields_different=envd,
                    config=dict(cd, budgets=list(cd["budgets"])), methods=[e1["M"]["method_id"], e2["M"]["method_id"]]))


def check_all(problem: Problem, e1: dict, e2: dict) -> dict:
    return {c: check(problem, e1, e2, c) for c in CLAIMS}


def normalized_metric(e: dict, metric: str) -> float:
    """Value of a metric in canonical units, using only a verified transformation."""
    spec = e["V"]["contract"]["metrics"][metric]
    if spec.get("aggregation", "sum") != "sum":
        raise ValueError("no verified rule maps this aggregation to the canonical metric")
    return e["R"]["metrics"][metric] / spec["scale"]
