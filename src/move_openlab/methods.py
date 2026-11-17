"""Method extension contract: ``register_method(method_metadata, solve_function)``.

A method is a pure function ``solve(instance, config) -> dict``:

* ``instance`` is a deep read-only view of the scenario (``MappingProxyType`` / tuples): it cannot be modified;
* ``config`` is the read-only execution configuration (the method's declared defaults overlaid with campaign settings);
* the return value follows the output contract:

  ==============  ==========================================================================
  ``decisions``   list of decisions in the problem's own format (required)
  ``status``      one of :data:`STATUSES` (required, self-declared)
  ``declared``    ``{metric_id: number}`` (optional, self-declared — never trusted)
  ``metadata``    JSON object, execution metadata (e.g. ``solver_time_s``, solver version)
  ``diagnostics`` JSON object, method-specific
  ==============  ==========================================================================

The platform validates the output schema, then recomputes feasibility and every metric with the problem's
independent validator. A method is compatible with a problem only if it declares the problem id and the objective
specification of that problem.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from types import MappingProxyType
from typing import Any, Callable

from .problem import Problem

STATUSES = ("OPTIMAL", "FEASIBLE", "HEURISTIC", "TIME_LIMIT", "INFEASIBLE", "ERROR")
KINDS = ("exact", "heuristic", "learned", "hybrid")
OUTPUT_FIELDS = {"decisions", "status", "declared", "metadata", "diagnostics"}
METHOD_ID = re.compile(r"^[a-z][a-z0-9-]{2,63}\Z")
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
MAX_OUTPUT_BYTES = 4_000_000
#: Optional ``METADATA["catalog"]`` values: how the "+ Add method" catalogue presents a plug-in (``"example"``: a
#: ready-made example shipped with the framework). Presentation only — not part of the method's contract or identity.
CATALOG = ("example",)


class ContractError(ValueError):
    pass


@dataclass(frozen=True)
class MethodMetadata:
    method_id: str
    name: str
    version: str
    kind: str
    problem_id: str
    objective_spec_id: str
    deterministic: bool
    description: str
    author: str
    default_config: dict = field(default_factory=dict)
    #: Settings a researcher may choose per experiment: ``{key: {"type": "number" | "integer" | "boolean" | "string",
    #: "label", "unit"?, "min"?, "max"?, "enum"?, "nullable"?}}``. ``null`` (when nullable) keeps the solver's own default.
    #: A method without a schema has no researcher-settable configuration.
    config_schema: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


REQUIRED = [k for k in MethodMetadata.__dataclass_fields__ if k not in ("default_config", "config_schema")]
SETTING_TYPES = {"number": (int, float), "integer": (int,), "boolean": (bool,), "string": (str,)}


def _check_schema(schema: dict) -> None:
    if not isinstance(schema, dict) or len(schema) > 32:
        raise ContractError("config_schema must be an object of at most 32 settings")
    for k, s in schema.items():
        if not (isinstance(k, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,47}", k)):
            raise ContractError(f"config_schema key {k!r} must be lowercase letters, digits and '_'")
        if not isinstance(s, dict) or s.get("type") not in SETTING_TYPES or not isinstance(s.get("label"), str):
            raise ContractError(f"config_schema[{k!r}] needs a type in {sorted(SETTING_TYPES)} and a label")
        unknown = set(s) - {"type", "label", "unit", "min", "max", "enum", "nullable", "help"}
        if unknown:
            raise ContractError(f"config_schema[{k!r}] has unknown field(s) {sorted(unknown)}")


def validate_config(meta: MethodMetadata, cfg: dict | None) -> dict:
    """A researcher's settings for one method, checked against its ``config_schema`` before any execution: only declared
    keys, the declared type, range and choices. Returns a normalised copy (integers stay integers)."""
    cfg = dict(cfg or {})
    if not cfg:
        return {}
    if not meta.config_schema:
        raise ContractError(f"{meta.method_id}@{meta.version} declares no configurable settings")
    out = {}
    for k, v in cfg.items():
        s = meta.config_schema.get(k)
        if s is None:
            raise ContractError(f"{meta.method_id}: unknown setting {k!r} (allowed: {sorted(meta.config_schema)})")
        if v is None:
            if not s.get("nullable"):
                raise ContractError(f"{meta.method_id}: {k} cannot be empty")
            out[k] = None
            continue
        types = SETTING_TYPES[s["type"]]
        if isinstance(v, bool) and s["type"] != "boolean" or not isinstance(v, types):
            raise ContractError(f"{meta.method_id}: {k} must be of type {s['type']}")
        if isinstance(v, float) and v != v:
            raise ContractError(f"{meta.method_id}: {k} must be a number")
        if "min" in s and v < s["min"] or "max" in s and v > s["max"]:
            raise ContractError(f"{meta.method_id}: {k} = {v} is outside [{s.get('min', '-inf')}, {s.get('max', 'inf')}]")
        if "enum" in s and v not in s["enum"]:
            raise ContractError(f"{meta.method_id}: {k} must be one of {s['enum']}")
        out[k] = v
    return out


def check_metadata(meta: dict | MethodMetadata, problem: Problem) -> MethodMetadata:
    d = meta.to_dict() if isinstance(meta, MethodMetadata) else dict(meta)
    catalog = d.pop("catalog", None)                       # catalogue presentation only, never part of the contract
    if catalog is not None and catalog not in CATALOG:
        raise ContractError(f"catalog must be one of {CATALOG} (or absent)")
    missing =[k for k in REQUIRED if k not in d]
    if missing:
        raise ContractError(f"metadata missing field(s): {missing}")
    unknown = set(d) - set(MethodMetadata.__dataclass_fields__)
    if unknown:
        raise ContractError(f"unknown metadata field(s): {sorted(unknown)}")
    if not METHOD_ID.match(str(d["method_id"])):
        raise ContractError("method_id must be 3-64 chars of lowercase letters, digits and '-', starting with a letter")
    if not SEMVER.match(str(d["version"])):
        raise ContractError(f"version {d['version']!r} is not a semantic version MAJOR.MINOR.PATCH")
    if d["kind"] not in KINDS:
        raise ContractError(f"kind must be one of {KINDS}")
    if d["problem_id"] != problem.problem_id:
        raise ContractError(f"incompatible method: problem_id {d['problem_id']!r} != {problem.problem_id!r}")
    if d["objective_spec_id"] != problem.objective_spec_id:
        raise ContractError(f"incompatible method: objective_spec_id {d['objective_spec_id']!r} != "
                            f"{problem.objective_spec_id!r}")
    if not isinstance(d["deterministic"], bool):
        raise ContractError("deterministic must be a boolean")
    cfg = d.get("default_config") or {}
    if not isinstance(cfg, dict):
        raise ContractError("default_config must be an object")
    try:
        json.dumps(cfg)
    except (TypeError, ValueError) as e:
        raise ContractError(f"default_config must be JSON-serialisable: {e}") from None
    schema = d.get("config_schema") or {}
    _check_schema(schema)
    out = MethodMetadata(**{**{k: d[k] for k in REQUIRED}, "default_config": cfg, "config_schema": schema})
    validate_config(out, {k: v for k, v in cfg.items() if k in schema})      # declared defaults obey their own schema
    return out


class MethodRegistry:
    """Methods of one problem, keyed by (method_id, version)."""

    def __init__(self, problem: Problem) -> None:
        self.problem = problem
        self._m: dict[tuple[str, str], tuple[MethodMetadata, Callable]] = {}

    def register_method(self, method_metadata: dict | MethodMetadata, solve_function: Callable) -> MethodMetadata:
        meta = check_metadata(method_metadata, self.problem)
        if not callable(solve_function):
            raise ContractError("solve_function must be callable")
        key = (meta.method_id, meta.version)
        if key in self._m:
            raise ContractError(f"{meta.method_id}@{meta.version} is already registered")
        self._m[key] = (meta, solve_function)
        return meta

    def get(self, method_id: str, version: str) -> tuple[MethodMetadata, Callable]:
        try:
            return self._m[(method_id, version)]
        except KeyError:
            raise ContractError(f"method {method_id}@{version} is not registered here") from None

    def list(self) -> list[MethodMetadata]:
        return [m for m, _ in self._m.values()]


def builtin_registry(problem: Problem) -> MethodRegistry:
    r = MethodRegistry(problem)
    for meta, fn in problem.builtin_methods():
        r.register_method(meta, fn)
    return r


def freeze(obj: Any) -> Any:
    """Deep read-only view: dicts become ``MappingProxyType``, lists become tuples."""
    if isinstance(obj, dict):
        return MappingProxyType({k: freeze(v) for k, v in obj.items()})
    if isinstance(obj, (list, tuple)):
        return tuple(freeze(v) for v in obj)
    return obj


def thaw(obj: Any) -> Any:
    """Inverse of :func:`freeze` for JSON output (tuples become lists, mapping proxies become dicts)."""
    if isinstance(obj, (dict, MappingProxyType)):
        return {k: thaw(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [thaw(v) for v in obj]
    return obj


def check_output(out: Any, problem: Problem) -> list[str]:
    """Schema validation of a method's raw output (before any independent recomputation)."""
    if not isinstance(out, dict):
        return ["output is not an object"]
    errs = []
    unknown = set(out) - OUTPUT_FIELDS
    if unknown:
        errs.append(f"unknown output field(s) {sorted(unknown)}")
    if "decisions" not in out:
        errs.append("decisions missing")
    else:
        errs += problem.check_decisions(out["decisions"])
    if out.get("status") not in STATUSES:
        errs.append(f"status must be one of {STATUSES}")
    metric_ids = {m.id for m in problem.metrics}
    dec = out.get("declared", {})
    if dec is not None and not (isinstance(dec, dict) and all(
            k in metric_ids and isinstance(v, (int, float)) and not isinstance(v, bool) for k, v in dec.items())):
        errs.append(f"declared must map metric ids {sorted(metric_ids)} to numbers")
    for k in ("metadata", "diagnostics"):
        if k in out and not isinstance(out[k], dict):
            errs.append(f"{k} must be an object")
    try:
        if len(json.dumps(out)) > MAX_OUTPUT_BYTES:
            errs.append("output too large")
    except (TypeError, ValueError):
        errs.append("output is not JSON-serialisable")
    return errs
