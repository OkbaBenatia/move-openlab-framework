"""Experiment descriptors and the four fingerprints. Each answers a different question:

``raw_artifact_hash``       are the stored instance files (canonically) identical?  — integrity only
``problem fingerprint``     is it the same optimization problem?  — computed by the problem definition from the data
                            that define the feasible region, the objective coefficients and the objective
                            *definition*; bookkeeping fields, labels and non-binding data are excluded
``evaluation fingerprint``  are the reported metrics defined identically?  — metric definitions, units, aggregation,
                            scale, ranking rule, validator, timing definitions
``environment fingerprint`` were runtimes measured under the same hardware/software?  — installation ids and
                            timestamps excluded

Scope: equal problem fingerprints imply the same feasible set and objective *within the problem's schema*. They do
not detect relabelled (isomorphic) instances.
"""
from __future__ import annotations

from ..hashing import canonical, sha256
from ..problem import Problem

ENV_KEYS = ("python", "implementation", "os", "os_release", "machine", "cpu_model_sha256", "cpu_count")


def raw_artifact_hash(instance: dict) -> str:
    return sha256(instance)


def problem_fingerprint(problem: Problem, instance: dict, objective_id: str) -> dict:
    comp = problem.problem_components(instance, objective_id)
    parts = {k: sha256(comp[k]) for k in ("region", "coefficients", "objective")}
    return dict(parts, problem=sha256(parts))


def evaluation_fingerprint(evaluation: dict) -> str:
    return sha256(evaluation)


def environment_descriptor(env: dict, problem: Problem) -> dict:
    """Runtime-relevant environment fields (bookkeeping such as the installation id is excluded)."""
    extra = sorted(problem.environment())
    return {k: env.get(k) for k in (*ENV_KEYS, *extra)}


def cell(problem: Problem, *, experiment_id: str, researcher: str, instance: dict, objective_id: str, evaluation: dict,
         config: dict, environment: dict, method: dict, runs: list[dict], origin: str, installation_id: str = "",
         domain: dict | None = None) -> dict:
    """One comparable unit: one method on one instance, under one configuration and environment, with its runs.
    Every run is re-validated independently; stored verdicts are never trusted. ``domain`` is the problem's domain
    descriptor (e.g. the emission configuration the figures depend on), compared under its own claim."""
    vals = [problem.validate(instance, r["decisions"]) for r in runs]
    metrics = [problem.metric_values(v, instance, r["decisions"], evaluation) for v, r in zip(vals, runs)]
    sols = {canonical(problem.canonical_decisions(r["decisions"])) for r in runs}

    def med(k):
        v = sorted(r[k] for r in runs if isinstance(r.get(k), (int, float)))
        return v[len(v) // 2] if v and len(v) == len(runs) else None
    statuses = sorted({r.get("status_declared") or "ERROR" for r in runs})
    return dict(
        experiment_id=experiment_id, researcher=researcher, origin=origin, instance_id=instance["instance_id"],
        installation_id=installation_id,
        I=dict(raw_artifact_hash=raw_artifact_hash(instance), instance_hash=instance["instance_hash"]),
        P=dict(objective_id=objective_id, fingerprint=problem_fingerprint(problem, instance, objective_id)),
        C=config, M=method,
        V=dict(contract=evaluation, fingerprint=evaluation_fingerprint(evaluation)),
        ENV=dict(descriptor=environment, fingerprint=sha256(environment)),
        E=domain,
        R=dict(repetitions=len(runs), feasible=bool(vals) and all(v["feasible"] for v in vals),
               canonical_metrics=vals[0]["metrics"] if vals else None, metrics=metrics[0] if metrics else None,
               repetitions_identical=len(sols) == 1, statuses=statuses,
               certified_optimal=statuses == ["OPTIMAL"] and method.get("kind") == "exact",
               median_solver_time_s=med("solver_time_s"), median_total_time_s=med("total_time_s")),
        _instance=instance)                                 # kept in memory for explanations, never serialised
