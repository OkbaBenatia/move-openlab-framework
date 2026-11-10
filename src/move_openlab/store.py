"""Installations, researcher workspaces, campaigns, lineage, locking, portable bundles and method registration.

Storage (one installation = one data directory; one workspace per authenticated user)::

  <data>/installation.json                                    installation identifier
  <data>/instances/<hash>.json                                content-addressed instances (immutable)
  <data>/workspaces/<user>/campaigns/<cid>/campaign.json
  <data>/workspaces/<user>/campaigns/<cid>/import_record.json  imported campaigns only: provenance of the import
  <data>/workspaces/<user>/methods.json                       plugins registered by this researcher

Campaign kinds: ``baseline`` · ``reproduction`` (re-executes its parent) · ``extended`` (adds methods to its parent) ·
``variant`` (controlled perturbation of its parent) · ``threshold-study`` (candidate pruning at several thresholds).
A locked campaign carries ``checksum`` = SHA-256 of its canonical content (without checksum / locked_at / status); any
later change is refused, and every read of a locked campaign re-verifies the checksum. Imported campaigns are
read-only. Derived campaigns record the parent's checksum, so a broken lineage is detected.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path

from . import __version__, custom_metrics, registry
from .hashing import instance_hash, json_copy, sha256
from .methods import ContractError, builtin_registry, check_metadata
from .plugins import code_sha256, discover, plugin_path, read_plugin_metadata
from .problem import Problem
from .runner import environment, run_once
from .sandbox import MODES, SandboxSpec, SandboxUnavailable, verify as sandbox_verify
from .scoring import MODES as SELECTION_MODES, normalise_thresholds, select, select_share, validate_selection

MAX_BUNDLE_BYTES = 64 * 1024 * 1024
LOCK_EXCLUDED = ("checksum", "locked_at", "status")
KINDS = ("baseline", "reproduction", "extended", "variant", "threshold-study")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_lock = threading.RLock()


class BenchError(Exception):
    status = 400


class NotFound(BenchError):
    status = 404


class ImmutableError(BenchError):
    status = 409


class IntegrityError(BenchError):
    status = 422


class Forbidden(BenchError):
    status = 403


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(json.dumps(obj, indent=1, sort_keys=True))
    os.replace(tmp, path)


_OLD_PREFIX = ("Independent re-execution of ", "Extension of ")
_DERIVED_SUFFIX = re.compile(r"\s+—\s+(?:Reproduction|Extension)(?:\s+\d+)?(?:\s+\(.*\))?$")


def base_title(title: str) -> str:
    """The experiment a derived title derives from, without the derivation words (old and new forms), e.g.
    "Independent re-execution of Independent re-execution of X" or "X — Reproduction 2" -> "X"."""
    t = (title or "").strip()
    while True:
        for pre in _OLD_PREFIX:
            if t.startswith(pre):
                t = t[len(pre):]
                if pre == "Extension of " and " with " in t:
                    t = t.rsplit(" with ", 1)[0]
                break
        else:
            m = _DERIVED_SUFFIX.search(t)
            if not m:
                return t
            t = t[:m.start()]


def display_title(title: str) -> str:
    """A short label for a stored title (titles are part of the record and its checksum, so old ones are never
    rewritten): "Independent re-execution of Independent re-execution of X" -> "X — Reproduction (of a reproduction)"."""
    t, n = title or "", 0
    while t.startswith(_OLD_PREFIX[0]):
        t, n = t[len(_OLD_PREFIX[0]):], n + 1
    if n:
        return f"{display_title(t)} — Reproduction" + (" (of a reproduction)" if n > 1 else "")
    if t.startswith(_OLD_PREFIX[1]) and " with " in t:
        base, added = t[len(_OLD_PREFIX[1]):].rsplit(" with ", 1)
        return f"{display_title(base)} — Extension ({added})"
    return t


def campaign_checksum(c: dict) -> str:
    return sha256({k: v for k, v in c.items() if k not in LOCK_EXCLUDED})


def builtin_refs(problem: Problem) -> list[dict]:
    return [dict(source="builtin", method_id=m.method_id, version=m.version, name=m.name, kind=m.kind, author=m.author)
            for m in builtin_registry(problem).list()]


def problem_for(c: dict) -> Problem:
    """The installed problem definition of a campaign; its specification must match the recorded one exactly."""
    try:
        p = registry.get(c["spec"]["problem_id"])
    except registry.UnknownProblem as e:
        raise IntegrityError(str(e)) from None
    if {k: c["spec"].get(k) for k in p.spec_record()} != p.spec_record() or c["spec"].get("validator_version") != p.validator_version:
        raise IntegrityError("the installed problem specification or validator differs from the campaign's")
    return p


class Installation:
    """One installation. Plugins are off unless both an approved plugin directory and a plugin mode are configured:
    ``sandbox`` (verified bubblewrap isolation, fail closed) or ``trusted-process`` (administrators only, not a
    sandbox). ``protected`` lists further paths that must never be visible to a sandboxed plugin (e.g. the
    credential store); the data directory and the plugin directory are always protected."""

    def __init__(self, data_dir: Path, plugin_dir: Path | None = None, installation_id: str | None = None,
                 plugin_mode: str = "disabled", protected: tuple = ()):
        if plugin_mode not in MODES:
            raise ValueError(f"plugin mode must be one of {MODES}")
        self.data = Path(data_dir)
        self.plugin_dir = Path(plugin_dir).resolve() if plugin_dir else None
        self.plugin_mode = plugin_mode if self.plugin_dir else "disabled"
        self.data.mkdir(parents=True, exist_ok=True)
        self.sandbox_spec = SandboxSpec.of(self.data, self.plugin_dir, *protected)
        info = self.data / "installation.json"
        if info.exists():
            self.id = json.loads(info.read_text())["installation_id"]
        else:
            self.id = installation_id or f"inst-{secrets.token_hex(4)}"
            _write(info, dict(installation_id=self.id, created_at=now(), framework_version=__version__))

    def plugin_status(self) -> dict:
        """Whether plugins can run here, how, and why not. Sandbox mode is enabled only after the isolation probe
        passed inside the real sandbox."""
        st = dict(mode=self.plugin_mode, enabled=False, isolation=None, reason=None, checks=None)
        if self.plugin_dir is None:
            st["reason"] = "no approved plugin directory is configured (MOVE_OPENLAB_PLUGIN_DIR)"
        elif self.plugin_mode == "disabled":
            st["reason"] = "plugins are disabled (MOVE_OPENLAB_PLUGIN_MODE=disabled, the default)"
        elif self.plugin_mode == "sandbox":
            try:
                st.update(enabled=True, isolation="sandbox", checks=sandbox_verify(self.sandbox_spec))
            except SandboxUnavailable as e:
                st.update(enabled=False, reason=f"plugins refused: {e}")
        else:
            st.update(enabled=True, isolation="process",
                      reason="trusted-process mode: plugins run with the server's permissions (not a sandbox); "
                             "only administrators can register them")
        return st

    def require_plugins(self) -> dict:
        st = self.plugin_status()
        if not st["enabled"]:
            raise ContractError(st["reason"])
        return st

    def put_instance(self, problem: Problem, inst: dict) -> str:
        errs = problem.check_instance(inst)
        if errs:
            raise IntegrityError(f"instance {inst.get('instance_id')} failed integrity checks: {errs}")
        h = inst["instance_hash"]
        f = self.data / "instances" / f"{h}.json"
        if not f.exists():
            _write(f, inst)
        return h

    def get_instance(self, h: str) -> dict:
        if not re.fullmatch(r"[0-9a-f]{64}", h or ""):
            raise NotFound("instance not found")
        f = self.data / "instances" / f"{h}.json"
        if not f.exists():
            raise NotFound(f"instance {h[:12]} not found")
        inst = json.loads(f.read_text())
        if instance_hash(inst) != h or inst.get("instance_hash") != h:
            raise IntegrityError(f"stored instance {h[:12]} is corrupted")
        return inst

    def workspace(self, username: str, display_name: str) -> "Workspace":
        return Workspace(self, username, display_name)

    def recover_interrupted(self) -> dict[str, list[str]]:
        """At start-up: campaigns of every workspace left 'running' by a stopped server go back to draft."""
        out = {}
        ws_root = self.data / "workspaces"
        if ws_root.is_dir():
            for d in sorted(ws_root.iterdir()):
                if d.is_dir() and SAFE_ID.match(d.name):
                    got = Workspace(self, d.name, d.name).recover_interrupted()
                    if got:
                        out[d.name] = got
        return out


class Workspace:
    def __init__(self, inst: Installation, username: str, display_name: str):
        if not username or not SAFE_ID.match(username):
            raise BenchError("invalid workspace user")
        self.inst, self.user, self.display = inst, username, display_name
        self.root = inst.data / "workspaces" / username
        (self.root / "campaigns").mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ campaigns
    def _cdir(self, cid: str) -> Path:
        if not cid or not SAFE_ID.match(cid):
            raise NotFound("campaign not found")
        return self.root / "campaigns" / cid

    def list(self, problem_id: str | None = None) -> list[dict]:
        out = []
        for f in sorted((self.root / "campaigns").glob("*/campaign.json")):
            c = json.loads(f.read_text())
            if problem_id and c["spec"]["problem_id"] != problem_id:
                continue
            out.append(dict(campaign_id=c["campaign_id"], title=c["title"], kind=c["kind"], status=c["status"],
                            problem_id=c["spec"]["problem_id"], owner_display=c["owner_display"],
                            created_at=c["created_at"], parent=c.get("parent"),
                            methods=[m["method_id"] for m in c["methods"]],
                            scenarios=len(c["scenario_set"]["instance_hashes"]), runs=len(c["runs"]),
                            checksum=c.get("checksum"), imported=(f.parent / "import_record.json").exists()))
        return sorted(out, key=lambda c: (c["created_at"], c["campaign_id"]))

    def get(self, cid: str) -> dict:
        f = self._cdir(cid) / "campaign.json"
        if not f.exists():
            raise NotFound("campaign not found in this workspace")
        c = json.loads(f.read_text())
        if c.get("checksum") and campaign_checksum(c) != c["checksum"]:
            raise IntegrityError(f"campaign {cid} fails its checksum: the stored record was modified")
        return c

    def import_record(self, cid: str) -> dict | None:
        f = self._cdir(cid) / "import_record.json"
        return json.loads(f.read_text()) if f.exists() else None

    def _save(self, c: dict) -> None:
        f = self._cdir(c["campaign_id"]) / "campaign.json"
        if f.exists():
            prev = json.loads(f.read_text())
            if prev.get("checksum") or self.import_record(c["campaign_id"]):
                raise ImmutableError(f"campaign {c['campaign_id']} is locked or imported and cannot be modified")
        _write(f, c)

    def _new(self, problem: Problem, title: str, kind: str, scenario_set: dict, methods: list[dict], config: dict,
             parent: dict | None) -> dict:
        title = " ".join(str(title).split())[:160]
        if len(title) < 3:
            raise BenchError("title must contain at least 3 characters")
        cid = f"c-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{secrets.token_hex(3)}"
        return dict(campaign_id=cid, title=title, kind=kind, owner=self.user, owner_display=self.display,
                    installation_id=self.inst.id, created_at=now(), status="draft", synthetic=problem.synthetic,
                    spec={**problem.spec_record(), "validator_version": problem.validator_version,
                          "framework_version": __version__},
                    scenario_set=scenario_set, methods=methods, config=config, parent=parent, runs=[],
                    environment=None, checksum=None, locked_at=None)

    # ------------------------------------------------------------------ scenario library
    def save_scenario(self, problem: Problem, scenario: dict, instance: dict, parent: str | None = None) -> dict:
        """Store an editable scenario and its built (content-addressed, immutable) instance in this workspace.
        Editing a scenario creates a new library entry that records its parent."""
        h = self.inst.put_instance(problem, instance)
        sid = f"s-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{secrets.token_hex(3)}"
        rec = dict(scenario_id=sid, name=scenario["name"], problem_id=problem.problem_id, created_at=now(),
                   created_by=self.display, parent=parent, scenario=scenario, instance_hash=h,
                   source=(scenario.get("provenance") or {}).get("source", "editor"))
        _write(self.root / "scenarios" / f"{sid}.json", rec)
        return rec

    def scenarios(self, problem_id: str | None = None) -> list[dict]:
        out = []
        for f in sorted((self.root / "scenarios").glob("*.json")):
            r = json.loads(f.read_text())
            if problem_id and r["problem_id"] != problem_id:
                continue
            sc = r["scenario"]
            out.append(dict(scenario_id=r["scenario_id"], name=r["name"], problem_id=r["problem_id"], source=r["source"],
                            created_at=r["created_at"], parent=r.get("parent"), instance_hash=r["instance_hash"],
                            drivers=len(sc.get("drivers", [])), riders=len(sc.get("riders", [])),
                            network_id=sc.get("network_id")))
        return sorted(out, key=lambda r: r["created_at"], reverse=True)

    def scenario(self, sid: str) -> dict:
        if not sid or not SAFE_ID.match(sid):
            raise NotFound("scenario not found")
        f = self.root / "scenarios" / f"{sid}.json"
        if not f.exists():
            raise NotFound("scenario not found in this workspace")
        return json.loads(f.read_text())

    # ------------------------------------------------------------------ methods
    def registered_methods(self, problem_id: str | None = None) -> list[dict]:
        f = self.root / "methods.json"
        regs = json.loads(f.read_text()) if f.exists() else []
        return [r for r in regs if problem_id is None or r["problem_id"] == problem_id]

    def resolve_method(self, problem: Problem, ref: dict) -> dict:
        """Executable reference: a built-in method, or a plugin this researcher registered here whose code is
        unchanged since registration and still inside the approved plugin directory."""
        if ref.get("source") == "builtin":
            meta, _ = builtin_registry(problem).get(ref["method_id"], ref["version"])
            return dict(source="builtin", method_id=meta.method_id, version=meta.version)
        for r in self.registered_methods(problem.problem_id):
            if (r["method_id"], r["version"]) == (ref["method_id"], ref["version"]):
                st = self.inst.require_plugins()                      # fail closed: no sandbox, no plugin run
                if r.get("isolation_at_registration") and r["isolation_at_registration"] != st["isolation"]:
                    raise ContractError(f"{r['method_id']}@{r['version']} was registered for {r['isolation_at_registration']} "
                                        f"isolation; this installation now uses {st['isolation']} (register it again)")
                if ref.get("code_sha256") and ref["code_sha256"] != r["code_sha256"]:
                    raise ContractError(f"{ref['method_id']}@{ref['version']}: local code differs from the referenced code hash")
                try:
                    f = plugin_path(self.inst.plugin_dir, r["plugin"])
                except FileNotFoundError:
                    raise ContractError(f"{r['method_id']}@{r['version']}: plugin no longer in the approved directory") from None
                if code_sha256(f) != r["code_sha256"]:
                    raise ContractError(f"{r['method_id']}@{r['version']}: plugin code changed since registration "
                                        "(register a new semantic version)")
                return dict(source="plugin", method_id=r["method_id"], version=r["version"], plugin_file=str(f),
                            code_sha256=r["code_sha256"], isolation=st["isolation"])
        raise ContractError(f"method {ref['method_id']}@{ref['version']} is not available in this workspace "
                            "(built-in, or a plugin registered by this researcher)")

    def method_ref(self, problem: Problem, method_id: str, version: str) -> dict:
        for b in builtin_refs(problem):
            if (b["method_id"], b["version"]) == (method_id, version):
                return b
        for r in self.registered_methods(problem.problem_id):
            if (r["method_id"], r["version"]) == (method_id, version):
                return dict(source="plugin", method_id=method_id, version=version, name=r["name"], kind=r["kind"],
                            author=r["author"], code_sha256=r["code_sha256"])
        raise ContractError(f"unknown method {method_id}@{version}")

    def available_plugins(self, problem: Problem) -> list[dict]:
        if not self.inst.plugin_status()["enabled"]:
            return []
        reg = {(r["method_id"], r["version"]): r for r in self.registered_methods(problem.problem_id)}
        out = []
        for item in discover(self.inst.plugin_dir, problem):
            m = item.get("metadata") or {}
            r = reg.get((m.get("method_id"), m.get("version")))
            item["registered"] = bool(r and r["code_sha256"] == item["code_sha256"])
            out.append(item)
        return out

    def register_plugin(self, problem: Problem, plugin: str, admin: bool = False) -> dict:
        st = self.inst.require_plugins()
        if st["isolation"] == "process" and not admin:
            raise Forbidden("trusted-process mode: only an administrator can register plugins")
        try:
            f = plugin_path(self.inst.plugin_dir, plugin)
        except FileNotFoundError as e:
            raise NotFound(str(e)) from None
        meta = check_metadata(read_plugin_metadata(f), problem)        # compatibility check, nothing executed
        if any(b["method_id"] == meta.method_id for b in builtin_refs(problem)):
            raise ContractError("a plugin cannot replace a built-in method")
        with _lock:
            regs = self.registered_methods()
            if any((r["problem_id"], r["method_id"], r["version"]) == (problem.problem_id, meta.method_id, meta.version)
                   for r in regs):
                raise BenchError(f"{meta.method_id}@{meta.version} is already registered (bump the semantic version)")
        code = code_sha256(f)
        probe = problem.selftest_instance()                              # reserved instance, never a benchmark one
        ref = dict(source="plugin", method_id=meta.method_id, version=meta.version, plugin_file=str(f), code_sha256=code,
                   isolation=st["isolation"])
        r = run_once(problem, ref, probe, {}, timeout_s=60.0, sandbox=self.inst.sandbox_spec)
        selftest = dict(instance_id=probe["instance_id"], accepted=r["accepted"], output_errors=r["output_errors"],
                        validation=r["validation"], error=r.get("error"), declared_mismatch=r.get("declared_mismatch"))
        if not r["accepted"]:
            raise ContractError(f"contract self-test failed: {r.get('error') or r['output_errors'] or r['validation']['errors']}")
        entry = dict(meta.to_dict(), plugin=plugin, code_sha256=code, registered_by=self.display, registered_at=now(),
                     compatibility=dict(problem_id="ok", objective_spec_id="ok", semver="ok"), selftest=selftest,
                     isolation_at_registration=st["isolation"],
                     isolation=("verified bubblewrap sandbox: no network, private PID namespace, cleared environment, "
                                "read-only installation, no data directory" if st["isolation"] == "sandbox" else
                                "trusted process (administrator decision; not a sandbox)"))
        with _lock:
            _write(self.root / "methods.json", self.registered_methods() + [entry])
        return entry

    # ------------------------------------------------------------------ custom metrics (third-party: sandboxed)
    def registered_metrics(self, problem_id: str | None = None) -> list[dict]:
        f = self.root / "metrics.json"
        regs = json.loads(f.read_text()) if f.exists() else []
        return [r for r in regs if problem_id is None or problem_id in r["problems"]]

    def available_metrics(self, problem: Problem) -> list[dict]:
        """Metric files of the approved directory (static metadata only) and whether this researcher registered them."""
        if not self.inst.plugin_status()["enabled"]:
            return []
        reg = {(r["id"], r["version"]): r for r in self.registered_metrics(problem.problem_id)}
        out = []
        for item in custom_metrics.discover(self.inst.plugin_dir, problem):
            m = item.get("metadata") or {}
            r = reg.get((m.get("id"), m.get("version")))
            item["registered"] = bool(r and r["code_sha256"] == item["code_sha256"])
            out.append(item)
        return out

    def register_metric(self, problem: Problem, plugin: str, admin: bool = False) -> dict:
        """Register a metric file for this workspace: static contract and compatibility checks, SHA-256 pinned,
        self-test on a reserved context in the required isolation. Nothing of the file runs in this process."""
        st = self.inst.require_plugins()
        if st["isolation"] == "process" and not admin:
            raise Forbidden("trusted-process mode: only an administrator can register metrics")
        try:
            f = custom_metrics.metric_path(self.inst.plugin_dir, plugin)
        except FileNotFoundError as e:
            raise NotFound(str(e)) from None
        code = custom_metrics.code_sha256(f)
        try:
            spec = custom_metrics.spec_from_metadata(custom_metrics.read_metadata(f), code)
        except (ValueError, SyntaxError) as e:
            raise ContractError(f"metric contract: {e}") from None
        errs = custom_metrics.compatibility(spec, problem)
        if errs:
            raise ContractError("; ".join(errs))
        if custom_metrics.is_builtin_id(spec.id):
            raise ContractError("a registered metric cannot replace a built-in metric")
        with _lock:
            if any((r["id"], r["version"]) == (spec.id, spec.version) for r in self.registered_metrics()):
                raise BenchError(f"{spec.id}@{spec.version} is already registered (bump the semantic version)")
        probe = custom_metrics.selftest_context(spec)
        ev = custom_metrics.evaluate_isolated(spec, [probe], str(f), st["isolation"], self.inst.sandbox_spec)
        if ev.per[0] is None:
            raise ContractError("metric self-test failed: " + ("; ".join(ev.issues) or "no value for the reserved context"))
        entry = dict(spec.public(st["isolation"]), plugin=plugin, registered_by=self.display, registered_at=now(),
                     selftest=dict(context=probe, value=ev.per[0]), isolation_at_registration=st["isolation"])
        with _lock:
            _write(self.root / "metrics.json", self.registered_metrics() + [entry])
        return entry

    def metric_evaluations(self, problem: Problem, contexts: list[dict]) -> list[tuple[dict, custom_metrics.Evaluation]]:
        """Every metric of this problem for this workspace — built-in ones in this process (trusted), registered ones
        in isolation — as (public description, evaluation). A registered metric that cannot run here (plugins off,
        isolation unavailable or changed, file moved or modified) is listed with no values and the reason."""
        out = [(m.public(), custom_metrics.evaluate_detailed(m, contexts)) for m in custom_metrics.builtin_for(problem.problem_id)]
        for r in self.registered_metrics(problem.problem_id):
            spec = custom_metrics.spec_from_metadata({k: r[k] for k in custom_metrics.METADATA_KEYS}, r["code_sha256"])
            none = [None] * len(contexts)
            try:
                st = self.inst.require_plugins()
                if r["isolation_at_registration"] != st["isolation"]:
                    raise ContractError(f"registered for {r['isolation_at_registration']} isolation; this installation now "
                                        f"uses {st['isolation']} (register it again)")
                f = custom_metrics.metric_path(self.inst.plugin_dir, r["plugin"])
                if custom_metrics.code_sha256(f) != r["code_sha256"]:
                    raise ContractError("metric code changed since registration (register a new semantic version)")
            except (ContractError, FileNotFoundError) as e:
                out.append((dict(spec.public(r["isolation_at_registration"]), available=False),
                            custom_metrics.Evaluation(none, None, [f"not computed: {e}"])))
                continue
            out.append((spec.public(st["isolation"]),
                        custom_metrics.evaluate_isolated(spec, contexts, str(f), st["isolation"], self.inst.sandbox_spec)))
        return out

    # ------------------------------------------------------------------ creation and execution
    def create_campaign(self, problem_id: str, title: str, scenario_params: dict, methods: list[tuple[str, str]],
                        repetitions: int = 3, timeout_s: float = 120.0, time_budget_s: float | None = None,
                        emissions: dict | None = None) -> dict:
        """``emissions`` (optional ``{scope, baseline}``) is experiment configuration: it is recorded in ``config``,
        hence in the experiment fingerprint, and reaches only the problem's domain metrics."""
        try:
            problem = registry.get(problem_id)
        except registry.UnknownProblem as e:
            raise NotFound(str(e)) from None
        if not 1 <= int(repetitions) <= 20 or not 1 <= float(timeout_s) <= 3600:
            raise BenchError("repetitions must be 1-20 and timeout 1-3600 s")
        if emissions is not None:
            from .mobility.emissions import validate_config
            try:
                emissions = validate_config(emissions)
            except ValueError as e:
                raise BenchError(str(e)) from None
        if not methods:
            raise BenchError("select at least one method")
        params = scenario_params or {}
        if "instance_hashes" in params:                       # existing scenarios (e.g. from the scenario library)
            hs = params["instance_hashes"]
            if not isinstance(hs, list) or not 1 <= len(hs) <= 500 or len(set(hs)) != len(hs):
                raise BenchError("instance_hashes must list 1-500 distinct stored instances")
            instances = [self.inst.get_instance(h) for h in hs]
            for i in instances:
                if i.get("problem_id") != problem.problem_id or problem.check_instance(i):
                    raise IntegrityError(f"instance {i.get('instance_id')} does not belong to {problem.problem_id} or fails its checks")
            meta = dict(params=dict(instance_hashes=hs), generator=dict(name="scenario library"))
        else:
            try:
                instances, meta = problem.generate_scenarios(params)
            except ValueError as e:
                raise BenchError(f"invalid scenario parameters: {e}") from None
        hashes = [self.inst.put_instance(problem, i) for i in instances]
        refs = [self.method_ref(problem, m, v) for m, v in methods]
        if len({r["method_id"] for r in refs}) != len(refs):
            raise BenchError("a method may appear only once in a campaign")
        for r in refs:
            self.resolve_method(problem, r)
        budget = float(time_budget_s) if time_budget_s is not None else problem.default_time_budget_s
        c = self._new(problem, title, "baseline",
                      dict(meta, instance_hashes=hashes, instance_ids=[i["instance_id"] for i in instances]), refs,
                      dict(repetitions=int(repetitions), timeout_s=float(timeout_s), time_budget_s=budget,
                           order="repetition > instance > method", method_configs={r["method_id"]: {} for r in refs},
                           **(dict(emissions=emissions) if emissions else {})),
                      None)
        self._save(c)
        return c

    def execute(self, cid: str, progress=None, cancel=None) -> dict:
        """Run every (repetition, instance, method) cell. ``progress`` is called as ``progress(done, total)``; when it
        also has an ``event(stage, message)`` method (a job monitor) each run is traced. ``cancel`` (a
        ``threading.Event``) stops the campaign: the running worker is killed, no partial result is kept and the
        campaign returns to draft."""
        event = getattr(progress, "event", None)
        cancel = cancel if cancel is not None else getattr(progress, "cancel", None)
        with _lock:
            c = self.get(cid)
            if c.get("checksum") or self.import_record(cid):
                raise ImmutableError("locked or imported campaigns cannot be executed again; derive a new campaign")
            if c["status"] == "running":
                raise ImmutableError("this campaign is already running")
            problem = problem_for(c)
            exe = [(m, self.resolve_method(problem, m)) for m in c["methods"]]
            c["status"] = "running"
            self._save(c)
        try:
            insts = [self.inst.get_instance(h) for h in c["scenario_set"]["instance_hashes"]]
            runs, total, done = [], c["config"]["repetitions"] * len(insts) * len(exe), 0
            env = environment(problem, self.inst.id)
            if event:
                event("prepare", f"{len(insts)} instance(s) verified; {len(exe)} method(s); {total} run(s)")
            for rep in range(1, c["config"]["repetitions"] + 1):
                for inst in insts:
                    for m, ref in exe:
                        if cancel is not None and cancel.is_set():
                            from .runner import Cancelled
                            raise Cancelled("campaign execution cancelled")
                        r = run_once(problem, ref, inst, c["config"]["method_configs"].get(m["method_id"], {}),
                                     c["config"]["timeout_s"], sandbox=self.inst.sandbox_spec, cancel=cancel,
                                     experiment_config=c["config"])
                        if event:
                            event("run", f"{inst['instance_id']} · {m['method_id']} · rep {rep}: "
                                         + ("accepted" if r["accepted"] else "rejected"),
                                  instance_id=inst["instance_id"], method_id=m["method_id"], repetition=rep,
                                  accepted=r["accepted"], metrics=r["validation"]["metrics"],
                                  stages={x["stage"]: x["duration_s"] for x in r.get("trace", [])})
                        r.update(run_id=f"r{len(runs) + 1:05d}", repetition=rep, executed_by=self.display,
                                 executed_at=now(), origin="executed", installation_id=self.inst.id)
                        runs.append(r)
                        done += 1
                        if progress:
                            progress(done, total)
        except BaseException:
            with _lock:
                c = json.loads((self._cdir(cid) / "campaign.json").read_text())
                c["status"] = "draft"
                self._save(c)
            raise
        with _lock:
            c = json.loads((self._cdir(cid) / "campaign.json").read_text())
            c.update(runs=runs, environment=env, status="completed", completed_at=now())
            self._save(c)
        if event:   # every run was checked by the independent validator as it finished; this is the summary
            event("validate", f"independent validation: {sum(r['accepted'] for r in runs)} of {len(runs)} solutions accepted")
            event("complete", f"{sum(r['accepted'] for r in runs)}/{len(runs)} runs accepted")
        return c

    def recover_interrupted(self) -> list[str]:
        """Campaigns left 'running' by a stopped server go back to draft (no partial runs were ever stored)."""
        out = []
        with _lock:
            for f in sorted((self.root / "campaigns").glob("*/campaign.json")):
                c = json.loads(f.read_text())
                if c.get("status") == "running" and not c.get("checksum") and not self.import_record(c["campaign_id"]):
                    c["status"] = "draft"
                    c["interrupted_at"] = now()
                    _write(f, c)
                    out.append(c["campaign_id"])
        return out

    def lock(self, cid: str) -> dict:
        with _lock:
            c = self.get(cid)
            if c.get("checksum"):
                raise ImmutableError("campaign is already locked")
            if self.import_record(cid):
                raise ImmutableError("imported campaigns are read-only")
            if c["status"] != "completed" or not c["runs"]:
                raise BenchError("only a completed campaign can be locked")
            c["status"], c["locked_at"] = "locked", now()
            c["checksum"] = campaign_checksum(c)
            _write(self._cdir(cid) / "campaign.json", c)
            return c

    def lineage(self, cid: str) -> list[dict]:
        """[campaign, parent, grand-parent, ...] with checksum verification of every link."""
        chain, cur, seen = [], self.get(cid), set()
        while True:
            if cur["campaign_id"] in seen:
                raise IntegrityError("lineage contains a cycle")
            seen.add(cur["campaign_id"])
            chain.append(cur)
            p = cur.get("parent")
            if not p:
                return chain
            parent = self.get(p["campaign_id"])
            if parent.get("checksum") != p["checksum"]:
                raise IntegrityError(f"lineage broken: parent {p['campaign_id']} checksum differs from the recorded one")
            cur = parent

    def _derive(self, parent_id: str, kind: str, relation: str, title: str, methods: list[dict],
                scenario_set: dict | None = None, config: dict | None = None) -> dict:
        parent = self.get(parent_id)
        if not parent.get("checksum"):
            raise BenchError("derive only from a locked (immutable) campaign")
        problem = problem_for(parent)
        cfg = config or json_copy(parent["config"])
        for m in methods:
            cfg["method_configs"].setdefault(m["method_id"], {})
        c = self._new(problem, title, kind, scenario_set or json_copy(parent["scenario_set"]), methods, cfg,
                      dict(campaign_id=parent["campaign_id"], checksum=parent["checksum"], relation=relation,
                           kind=parent["kind"], owner_display=parent["owner_display"],
                           installation_id=parent["installation_id"]))
        diffs = []
        if kind != "reproduction":
            diffs += [f"added method {m['method_id']}@{m['version']}" for m in methods
                      if m["method_id"] not in {x["method_id"] for x in parent["methods"]}]
        if cfg != parent["config"]:
            diffs += [f"configuration {k}: {parent['config'].get(k)!r} -> {cfg.get(k)!r}"
                      for k in sorted(set(cfg) | set(parent["config"])) if cfg.get(k) != parent["config"].get(k)
                      and k != "method_configs"]
        c["config_differences_from_parent"] = diffs
        return c

    def _derived_title(self, parent_title: str, word: str, detail: str = "") -> str:
        """Short title of a derived experiment, never nested: "<root> — Reproduction 2", "<root> — Extension 1 (Method)".
        The number counts the experiments of that kind derived from the same root in this workspace; the full lineage
        is recorded separately (``parent``) and shown under Details."""
        root = base_title(parent_title)
        if root.endswith(" — Baseline"):
            root = root[:-len(" — Baseline")]
        kind = "reproduction" if word == "Reproduction" else "extended"
        n = 1 + sum(1 for c in self.list() if c.get("kind") == kind and base_title(c.get("title", "")).removesuffix(" — Baseline") == root)
        return f"{root} — {word} {n}{f' ({detail})' if detail else ''}"[:160]

    def create_reproduction(self, parent_id: str) -> dict:
        parent = self.get(parent_id)
        problem = problem_for(parent)
        for m in parent["methods"]:
            self.resolve_method(problem, m)
        c = self._derive(parent_id, "reproduction", "reproduces", self._derived_title(parent["title"], "Reproduction"),
                         parent["methods"])
        self._save(c)
        return c

    def create_extension(self, parent_id: str, methods: list[tuple[str, str]]) -> dict:
        chain = self.lineage(parent_id)
        problem = problem_for(chain[0])
        existing = {m["method_id"] for c in chain for m in c["methods"]}
        refs = [self.method_ref(problem, m, v) for m, v in methods]
        if not refs:
            raise BenchError("select at least one method")
        for r in refs:
            if r["method_id"] in existing:
                raise BenchError(f"{r['method_id']} is already part of the lineage")
            self.resolve_method(problem, r)
        c = self._derive(parent_id, "extended", "extends", self._derived_title(chain[-1]["title"], "Extension",
                                                                               ", ".join(r["name"] for r in refs)), refs)
        self._save(c)
        return c

    def create_variant(self, parent_id: str, variant_id: str, title: str | None = None) -> dict:
        """Controlled variant: derived instances are new content-addressed artifacts; the parent is never modified."""
        parent = self.get(parent_id)
        problem = problem_for(parent)
        variants = problem.variants()
        if variant_id not in variants:
            raise BenchError(f"unknown variant {variant_id!r}")
        v = variants[variant_id]
        hashes, ids, mods, na = [], [], [], []
        for h in parent["scenario_set"]["instance_hashes"]:
            inst = self.inst.get_instance(h)
            if v.apply is None:
                hashes.append(h); ids.append(inst["instance_id"])
                continue
            child = v.apply(inst)
            if child is None:
                na.append(inst["instance_id"])
                continue
            hashes.append(self.inst.put_instance(problem, child)); ids.append(child["instance_id"])
            mods.append(dict(parent_instance_id=inst["instance_id"], parent_instance_hash=h,
                             derived_instance_id=child["instance_id"], derived_instance_hash=child["instance_hash"],
                             modification=child["derivation"]["modification"]))
        if not hashes:
            raise BenchError(f"{variant_id} is not applicable to any scenario of this campaign")
        methods = list(parent["methods"])
        for r in self.registered_methods(problem.problem_id):        # the researcher's own registered methods
            if not any(m["method_id"] == r["method_id"] for m in methods):
                methods.append(self.method_ref(problem, r["method_id"], r["version"]))
        for m in methods:
            self.resolve_method(problem, m)
        cfg = json_copy(parent["config"])
        for k, val in v.config_patch.items():
            if k == "method_configs":
                for mid, opts in val.items():
                    cfg["method_configs"].setdefault(mid, {}).update(opts)
            else:
                cfg[k] = val
        c = self._derive(parent_id, "variant", "perturbs", title or f"Controlled variant '{variant_id}' of {parent['title']}",
                         methods, dict(parent["scenario_set"], instance_hashes=hashes, instance_ids=ids), cfg)
        c["semantic_variant"] = dict(variant=variant_id, description=v.description, modifications=mods,
                                     not_applicable=na)
        c["config_differences_from_parent"].insert(0, f"controlled variant {variant_id}: {v.description}")
        self._save(c)
        return c

    def create_threshold_study(self, parent_id: str, method: tuple[str, str], scorer_id: str, thresholds: list[float],
                               top_k: int | None = None, mode: str = "absolute") -> dict:
        """Run one method on candidate-pruned copies of the parent's instances, one copy per selection value. The
        parent's runs of the same method on the full instances are the reference.

        ``mode="absolute"``: each value is a fixed score threshold (with optional per-group ``top_k``).
        ``mode="share"``: each value is the share of scored candidates to keep per instance; the threshold is then
        dynamic — computed per instance as the score of the last kept candidate (recorded as ``effective_threshold``)."""
        if mode not in SELECTION_MODES:
            raise BenchError(f"mode must be one of {SELECTION_MODES}")
        parent = self.get(parent_id)
        problem = problem_for(parent)
        if not problem.supports_candidates():
            raise BenchError(f"problem {problem.problem_id} exposes no candidate decisions to score")
        scorers = problem.scorers()
        if scorer_id not in scorers:
            raise BenchError(f"unknown scorer {scorer_id!r}")
        try:
            ths = normalise_thresholds(thresholds)
            validate_selection(None, top_k)
            if mode == "share" and (any(not 0 < t <= 1 for t in ths) or top_k):
                raise ValueError("share mode takes values in (0, 1] and no top_k")
        except ValueError as e:
            raise BenchError(str(e)) from None
        ref = self.method_ref(problem, *method)
        if not any(r["method_id"] == ref["method_id"] for r in parent["runs"]):
            raise BenchError("the parent campaign has no runs of this method on the full instances (the reference)")
        self.resolve_method(problem, ref)
        scorer = scorers[scorer_id]
        hashes, ids, cells = [], [], []
        for h in parent["scenario_set"]["instance_hashes"]:
            inst = self.inst.get_instance(h)
            cands = problem.candidates(inst)
            scores = scorer.score(inst, cands)
            for t in ths:
                if mode == "share":
                    keep, eff = select_share(cands, scores, t)
                else:
                    keep, eff = select(cands, scores, t, top_k), t
                child = problem.restrict(inst, keep, dict(parent_instance_id=inst["instance_id"], parent_instance_hash=h,
                                                          scorer=scorer_id, threshold=t, top_k=top_k, mode=mode,
                                                          effective_threshold=eff))
                ch = self.inst.put_instance(problem, child)
                hashes.append(ch); ids.append(child["instance_id"])
                cells.append(dict(parent_instance_hash=h, parent_instance_id=inst["instance_id"], threshold=t,
                                  effective_threshold=eff, instance_hash=ch, candidates_total=len(cands),
                                  candidates_kept=len(keep)))
        cfg = json_copy(parent["config"])
        cfg["method_configs"] = {ref["method_id"]: parent["config"]["method_configs"].get(ref["method_id"], {})}
        c = self._derive(parent_id, "threshold-study", "prunes", f"Threshold study of {ref['name']} on {parent['title']}",
                         [ref], dict(parent["scenario_set"], instance_hashes=hashes, instance_ids=ids), cfg)
        rule = ("keep a candidate if score >= threshold and (when top_k is set) it is among the top-k scored candidates "
                "of one of its groups; unscored candidates are always kept") if mode == "absolute" else (
                "dynamic threshold: keep the best-scored share of the scored candidates of each instance (ties at the "
                "cut-off are kept); unscored candidates are always kept")
        c["threshold_study"] = dict(method=dict(method_id=ref["method_id"], version=ref["version"]),
                                    scorer=scorer.info(), thresholds=ths, top_k=top_k, mode=mode, cells=cells,
                                    selection_rule=rule)
        self._save(c)
        return c

    # ------------------------------------------------------------------ bundles (see :mod:`.bundles`)
    def export_bundle(self, cid: str, geometry: bool = True, evidence: dict | None = None) -> tuple[bytes, dict]:
        from . import bundles
        return bundles.export(self, cid, geometry=geometry, evidence=evidence)

    def verify_bundle(self, data: bytes) -> tuple[dict, dict, dict, Problem]:
        from . import bundles
        return bundles.verify(self, data)[:4]

    def import_bundle(self, data: bytes) -> dict:
        from . import bundles
        return bundles.import_(self, data)
