"""Installations, researcher workspaces, campaigns, lineage, locking, portable bundles and method registration.

Storage (one installation = one data directory; one workspace per authenticated user)::

  <data>/installation.json                                    installation identifier
  <data>/instances/<hash>.json                                content-addressed instances (immutable)
  <data>/workspaces/<user>/campaigns/<cid>/campaign.json
  <data>/workspaces/<user>/campaigns/<cid>/import_record.json  imported campaigns only: provenance of the import
  <data>/workspaces/<user>/methods.json                       plugins registered by this researcher
  <data>/workspaces/<user>/plugins/<name>@<version>/          plug-ins uploaded by this researcher (owner-only:
                                                              plugin.py, small text files, upload.json)

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
from .hashing import instance_hash, json_copy, sha256, sha256_bytes
from .methods import ContractError, builtin_registry, check_metadata, validate_config
from .plugins import code_sha256, discover, plugin_path, read_plugin_metadata
from . import plugins as plugin_files, privatefiles
from .access import Access
from .problem import Problem
from .redact import paths as redact_paths
from .runner import environment, run_once
from .sandbox import MODES, SandboxSpec, SandboxUnavailable, verify as sandbox_verify
from .scoring import MODES as SELECTION_MODES, normalise_thresholds, select, select_share, validate_selection

MAX_BUNDLE_BYTES = 64 * 1024 * 1024
LOCK_EXCLUDED = ("checksum", "locked_at", "status")
KINDS = ("baseline", "reproduction", "extended", "variant", "threshold-study")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
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
        self.access = Access(self.data)                     # per-account grants of restricted problems
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

    def workspace(self, username: str, display_name: str, public_only: bool = False) -> "Workspace":
        return Workspace(self, username, display_name, public_only)

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
    def __init__(self, inst: Installation, username: str, display_name: str, public_only: bool = False):
        if not username or not SAFE_ID.match(username):
            raise BenchError("invalid workspace user")
        self.inst, self.user, self.display = inst, username, display_name
        # the public context of a request: restricted problems and their records are left out even for an account
        # that is granted them (a grant is never widened by this flag; it can only narrow what a request sees)
        self.public_only = public_only
        self.root = inst.data / "workspaces" / username
        (self.root / "campaigns").mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ access to restricted problems
    def allows(self, problem: Problem) -> bool:
        """Whether this account may see a problem (always, unless the problem is restricted and not granted, or the
        request is made in the public context)."""
        if self.public_only and getattr(problem, "restricted", False):
            return False
        return self.inst.access.allows(problem, self.user)

    def _visible(self, problem_id: str) -> bool:
        try:
            return self.allows(registry.get(problem_id))
        except registry.UnknownProblem:
            return True                                     # not installed: reported as such where it is used

    def problem(self, problem_id: str) -> Problem:
        """An installed problem this account may use. A restricted problem that is not granted answers exactly like a
        problem that is not installed."""
        try:
            p = registry.get(problem_id)
        except registry.UnknownProblem as e:
            raise NotFound(str(e.args[0])) from None
        if not self.allows(p):
            raise NotFound(f"problem {problem_id!r} is not installed here")
        return p

    def problems(self) -> list[Problem]:
        return [p for p in registry.all_problems() if self.allows(p)]

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
            if not self._visible(c["spec"]["problem_id"]):
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
        if not self._visible(c["spec"]["problem_id"]):
            raise NotFound("campaign not found in this workspace")
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
            if not self._visible(r["problem_id"]):
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
        rec = json.loads(f.read_text())
        if not self._visible(rec.get("problem_id", "")):
            raise NotFound("scenario not found in this workspace")
        return rec

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
                uploaded = r.get("origin") == "uploaded"
                if uploaded and st["isolation"] != "sandbox":                 # an upload never runs outside the sandbox
                    raise ContractError(f"{r['method_id']}@{r['version']}: an uploaded plug-in runs only in the verified sandbox")
                try:
                    f = plugin_path(self.uploads_dir if uploaded else self.inst.plugin_dir, r["plugin"])
                except FileNotFoundError:
                    raise ContractError(f"{r['method_id']}@{r['version']}: plugin no longer in "
                                        + ("your workspace" if uploaded else "the approved directory")) from None
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

    def method_settings(self, problem: Problem, refs: list[dict], method_configs: dict | None,
                        base: dict | None = None) -> dict:
        """``{method_id: settings}`` for the methods of an experiment: ``base`` (the parent's settings) updated with
        ``method_configs``, every value checked against the method's ``config_schema`` before anything is stored. Only
        built-in methods declare settings; a plug-in runs with its own defaults."""
        out = {r["method_id"]: dict((base or {}).get(r["method_id"]) or {}) for r in refs}
        if not isinstance(method_configs or {}, dict):
            raise BenchError("method_configs must map a method id to its settings")
        for mid, cfg in (method_configs or {}).items():
            ref = next((r for r in refs if r["method_id"] == mid), None)
            if ref is None:
                raise BenchError(f"settings for {mid}, which is not a method of this experiment")
            if not isinstance(cfg, dict):
                raise BenchError(f"settings of {mid} must be an object")
            if ref.get("source") != "builtin":
                if cfg:
                    raise BenchError(f"{mid} is a plug-in: it runs with its own default configuration")
                continue
            meta, _ = builtin_registry(problem).get(ref["method_id"], ref["version"])
            out[mid] = validate_config(meta, {**out[mid], **cfg})
        return out

    # ------------------------------------------------------------------ plug-in catalogue, uploads and checks
    @property
    def uploads_dir(self) -> Path:
        """Plug-ins uploaded by this account (owner-only): never the approved directory, never another account's."""
        return self.root / "plugins"

    def _plugin_file(self, plugin: str, origin: str = "approved") -> Path:
        if origin not in ("approved", "uploaded"):
            raise BenchError("origin must be 'approved' or 'uploaded'")
        try:
            return plugin_path(self.uploads_dir if origin == "uploaded" else self.inst.plugin_dir, plugin)
        except FileNotFoundError as e:
            raise NotFound("plugin not found among your uploaded plug-ins" if origin == "uploaded" else str(e)) from None

    def _upload_record(self, plugin: str) -> dict:
        try:
            return json.loads((self._plugin_file(plugin, "uploaded").parent / plugin_files.UPLOAD_RECORD).read_text())
        except (OSError, ValueError, NotFound):
            return {}

    def _require_plugin_runs(self, origin: str, admin: bool, what: str = "register plugins") -> dict:
        """Plug-ins enabled; trusted-process mode for administrators only; an uploaded plug-in only in sandbox mode."""
        st = self.inst.require_plugins()
        if st["isolation"] == "process" and not admin:
            raise Forbidden(f"trusted-process mode: only an administrator can {what}")
        if origin == "uploaded" and st["isolation"] != "sandbox":
            raise ContractError("uploaded plug-ins run only in the verified sandbox; this installation uses "
                                "trusted-process mode")
        return st

    def _contract(self, problem: Problem, f: Path):
        meta = check_metadata(read_plugin_metadata(f), problem)        # compatibility check, nothing executed
        if any(b["method_id"] == meta.method_id for b in builtin_refs(problem)):
            raise ContractError("a plugin cannot replace a built-in method")
        return meta

    def _registration_of(self, problem: Problem, method_id: str, version: str) -> dict | None:
        return next((r for r in self.registered_methods(problem.problem_id)
                     if (r["method_id"], r["version"]) == (method_id, version)), None)

    def _selftest(self, problem: Problem, meta, f: Path, code: str, st: dict) -> dict:
        """One run on the problem's reserved self-test instance (never a benchmark one), validated independently."""
        probe = problem.selftest_instance()
        ref = dict(source="plugin", method_id=meta.method_id, version=meta.version, plugin_file=str(f), code_sha256=code,
                   isolation=st["isolation"])
        r = run_once(problem, ref, probe, {}, timeout_s=60.0, sandbox=self.inst.sandbox_spec)
        selftest = dict(instance_id=probe["instance_id"], accepted=r["accepted"], output_errors=r["output_errors"],
                        validation=r["validation"], error=r.get("error"), declared_mismatch=r.get("declared_mismatch"))
        if not r["accepted"]:
            raise ContractError(f"contract self-test failed: {r.get('error') or r['output_errors'] or r['validation']['errors']}")
        return selftest

    def available_plugins(self, problem: Problem) -> list[dict]:
        """The catalogue of "+ Add method" for one problem (nothing is executed): the plug-ins of the approved directory
        — ``catalog`` ``"example"`` (shipped with the framework, ``METADATA["catalog"] == "example"``) or
        ``"installation"`` (provided by the operator) — and those this account uploaded (``"uploaded"``). ``state`` is
        ``available``, ``registered`` (code pinned), ``incompatible`` (reason in ``incompatibility``), ``changed`` (the
        file no longer holds the registered code: never silently re-registered) or ``taken`` (this method id and version
        are registered from another plug-in)."""
        if not self.inst.plugin_status()["enabled"]:
            return []
        reg = {(r["method_id"], r["version"]): r for r in self.registered_methods(problem.problem_id)}
        builtin = {b["method_id"] for b in builtin_refs(problem)}
        items = [dict(i, origin="approved") for i in discover(self.inst.plugin_dir, problem)]
        for i in discover(self.uploads_dir, problem):
            rec = self._upload_record(i["plugin"])
            items.append(dict(i, origin="uploaded", upload_sha256=rec.get("upload_sha256"), uploaded_at=rec.get("uploaded_at")))
        out = []
        for item in items:
            m = item.get("metadata") or {}
            item["catalog"] = "uploaded" if item["origin"] == "uploaded" else (
                "example" if plugin_files.catalog_of(m, self.inst.plugin_dir, item["plugin"]) == "example" else "installation")
            if item.get("compatible") and m.get("method_id") in builtin:
                item["compatible"], item["incompatibility"] = False, "a plugin cannot replace a built-in method"
            r = reg.get((m.get("method_id"), m.get("version")))
            if r and r.get("origin", "approved") == item["origin"] and r.get("plugin") == item["plugin"]:
                item["state"] = "registered" if r["code_sha256"] == item["code_sha256"] else "changed"
                item["registered_code_sha256"] = r["code_sha256"]
            elif r:
                item["state"] = "taken"
                item["incompatibility"] = (f"{m.get('method_id')}@{m.get('version')} is already registered from another "
                                           "plug-in (bump the semantic version)")
            else:
                item["state"] = "available" if item.get("compatible") else "incompatible"
            item["registered"] = item["state"] == "registered"
            out.append(item)
        return out

    def uploaded_plugins(self) -> list[dict]:
        """Upload records of this account's plug-ins (as written by :meth:`upload_plugin`)."""
        return [rec for i in discover(self.uploads_dir) if (rec := self._upload_record(i["plugin"]))]

    def upload_plugin(self, problem: Problem, data: bytes, admin: bool = False) -> dict:
        """Store a completed plug-in uploaded as a ZIP in this account's workspace, after every check of
        :func:`move_openlab.plugins.inspect_archive` and a static METADATA check against the problem — nothing is
        executed. The stored bytes are those hashed (``code_sha256``) and, once registered, executed in the sandbox. An
        identical re-upload returns the stored record (``unchanged``); the same method id and version with other code is
        refused (bump the version). Only in sandbox mode."""
        self._require_plugin_runs("uploaded", admin, "add plug-ins")
        try:
            name, files = plugin_files.inspect_archive(data)
        except plugin_files.UploadRefused as e:
            raise ContractError(f"ZIP refused: {e}") from None
        try:
            meta = check_metadata(plugin_files.metadata_from_source(files[plugin_files.PLUGIN_FILE]), problem)
            if any(b["method_id"] == meta.method_id for b in builtin_refs(problem)):
                raise ContractError("a plugin cannot replace a built-in method")
        except ContractError as e:
            raise ContractError(f"METADATA refused: {e}") from None
        code, key = sha256_bytes(files[plugin_files.PLUGIN_FILE]), f"{name}@{meta.version}"
        with _lock:
            for it in discover(self.uploads_dir):
                m = it.get("metadata") or {}
                if it["plugin"] == key or (m.get("method_id"), m.get("version")) == (meta.method_id, meta.version):
                    if it["plugin"] == key and it["code_sha256"] == code and m.get("method_id") == meta.method_id:
                        return dict(self._upload_record(key), unchanged=True)
                    raise ImmutableError(f"{meta.method_id}@{meta.version} was already uploaded with different code: change "
                                         "the version in METADATA (for example to the next patch version) and upload again")
            self.uploads_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            tmp = self.uploads_dir / f".upload-{secrets.token_hex(6)}"
            tmp.mkdir(mode=0o700)
            try:
                for fname, body in sorted(files.items()):
                    privatefiles.write(tmp / fname, body)
                rec = dict(origin="uploaded", plugin=key, directory=name, problem_id=problem.problem_id,
                           method_id=meta.method_id, version=meta.version, name=meta.name, kind=meta.kind,
                           code_sha256=code, upload_sha256=sha256_bytes(data),
                           files={fn: dict(bytes=len(b), sha256=sha256_bytes(b)) for fn, b in sorted(files.items())},
                           uploaded_by=self.display, uploaded_at=now())
                privatefiles.write(tmp / plugin_files.UPLOAD_RECORD, json.dumps(rec, indent=1, sort_keys=True))
                os.rename(tmp, self.uploads_dir / key)
            except BaseException:
                for p in (tmp.iterdir() if tmp.exists() else ()):
                    p.unlink(missing_ok=True)
                if tmp.exists():
                    tmp.rmdir()
                raise
        return dict(rec, unchanged=False)

    def check_plugin(self, problem: Problem, plugin: str, origin: str = "approved", selftest: bool = False,
                     admin: bool = False) -> dict:
        """Check a catalogue plug-in step by step without registering it: ``metadata`` (read statically and checked
        against the problem — nothing executed) and ``registration`` (this id and version are not registered yet); with
        ``selftest``, also ``self-test``: one run in the verified sandbox on the problem's reserved self-test instance,
        validated independently. Nothing is recorded."""
        f = self._plugin_file(plugin, origin)
        out = dict(plugin=plugin, origin=origin, ok=False, steps=[])
        steps = out["steps"]
        try:
            meta = self._contract(problem, f)
        except (ContractError, OSError) as e:
            from .redact import exception as safe_message
            steps.append(dict(step="metadata", ok=False, detail=safe_message(e, "plug-in metadata") if isinstance(e, OSError)
                              else redact_paths(str(e))))
            return out
        code = code_sha256(f)
        out.update(method_id=meta.method_id, version=meta.version, code_sha256=code)
        steps.append(dict(step="metadata", ok=True, detail=f"{meta.method_id}@{meta.version} ({meta.kind}) for "
                                                           f"{problem.problem_id}, objective {meta.objective_spec_id}"))
        r = self._registration_of(problem, meta.method_id, meta.version)
        steps.append(dict(step="registration", ok=r is None, detail="not registered yet" if r is None else (
            f"{meta.method_id}@{meta.version} is already registered (bump the semantic version)"
            + ("" if r["code_sha256"] == code else "; the file now holds different code than the registered one"))))
        if selftest:
            st = self._require_plugin_runs(origin, admin)
            try:
                t = self._selftest(problem, meta, f, code, st)
                steps.append(dict(step="self-test", ok=True, detail=f"valid result on the self-test instance "
                                  f"{t['instance_id']} ({st['isolation']})", metrics=t["validation"]["metrics"]))
            except ContractError as e:
                steps.append(dict(step="self-test", ok=False, detail=str(e)))
        out["ok"] = all(s["ok"] for s in steps)
        return out

    def register_plugin(self, problem: Problem, plugin: str, admin: bool = False, origin: str = "approved") -> dict:
        """Register a plug-in of the approved directory (``origin="approved"``) or one this account uploaded
        (``"uploaded"``, sandbox mode only): static compatibility check, then the sandboxed contract self-test; the code
        SHA-256 (and the upload's) is pinned. The same method id and version is never registered twice."""
        st = self._require_plugin_runs(origin, admin)
        f = self._plugin_file(plugin, origin)
        meta = self._contract(problem, f)
        with _lock:
            if self._registration_of(problem, meta.method_id, meta.version):
                raise BenchError(f"{meta.method_id}@{meta.version} is already registered (bump the semantic version)")
        code = code_sha256(f)
        selftest = self._selftest(problem, meta, f, code, st)
        entry = dict(meta.to_dict(), plugin=plugin, origin=origin, code_sha256=code, registered_by=self.display,
                     registered_at=now(), compatibility=dict(problem_id="ok", objective_spec_id="ok", semver="ok"),
                     selftest=selftest, isolation_at_registration=st["isolation"],
                     isolation=("verified bubblewrap sandbox: no network, private PID namespace, cleared environment, "
                                "read-only installation, no data directory" if st["isolation"] == "sandbox" else
                                "trusted process (administrator decision; not a sandbox)"))
        if origin == "uploaded":
            entry["upload_sha256"] = self._upload_record(plugin).get("upload_sha256")
        with _lock:
            if self._registration_of(problem, meta.method_id, meta.version):
                raise BenchError(f"{meta.method_id}@{meta.version} is already registered (bump the semantic version)")
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
                        emissions: dict | None = None, method_configs: dict | None = None) -> dict:
        """``emissions`` (optional ``{scope, baseline}``) is experiment configuration: it is recorded in ``config``,
        hence in the experiment fingerprint, and reaches only the problem's domain metrics. ``method_configs``
        (``{method_id: {setting: value}}``) are the researcher's solver settings, validated against each method's
        ``config_schema`` before anything is stored; each run records the effective configuration."""
        problem = self.problem(problem_id)
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
        settings = self.method_settings(problem, refs, method_configs)
        budget = float(time_budget_s) if time_budget_s is not None else problem.default_time_budget_s
        c = self._new(problem, title, "baseline",
                      dict(meta, instance_hashes=hashes, instance_ids=[i["instance_id"] for i in instances]), refs,
                      dict(repetitions=int(repetitions), timeout_s=float(timeout_s), time_budget_s=budget,
                           order="repetition > instance > method", method_configs=settings,
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

    # ------------------------------------------------------------------ results computed elsewhere (data, never code)
    IMPORT_RECORD_KEYS = {"instance_hash", "method_id", "decisions", "status_declared", "declared", "solver_time_s",
                          "total_time_s", "method_metadata", "diagnostics", "effective_config", "executed_at", "record_sha256"}

    def import_results(self, problem_id: str, title: str, instance_hashes: list[str], methods: list[tuple[str, str]],
                       records: list[dict], source: dict, method_configs: dict | None = None) -> dict:
        """A new, immutable experiment holding results computed OUTSIDE this platform (e.g. an archived research
        runner). Data only — no code is imported or executed and nothing is solved. Before anything is stored:
        every scenario must be a stored instance of the problem, every method an installed built-in method (its settings
        checked against its schema), every record's ``record_sha256`` must match its content, and every decision set is
        re-validated by the problem's independent validator (declared objective values are compared, never trusted).
        Runs are recorded with ``origin = "imported-external"`` and kept distinct from runs executed here; rejected
        records are kept as rejected runs (never dropped). The experiment is created and locked at once; existing
        experiments are never touched."""
        problem = self.problem(problem_id)
        if not isinstance(records, list) or not 1 <= len(records) <= 5000:
            raise BenchError("records must list 1-5000 results")
        if not isinstance(source, dict) or not str(source.get("name", "")).strip():
            raise BenchError("source must name where the results come from")
        if not isinstance(instance_hashes, list) or not instance_hashes or len(set(instance_hashes)) != len(instance_hashes):
            raise BenchError("instance_hashes must list distinct stored instances")
        insts = {}
        for h in instance_hashes:
            i = self.inst.get_instance(h)
            if i.get("problem_id") != problem.problem_id or problem.check_instance(i):
                raise IntegrityError(f"instance {i.get('instance_id')} does not belong to {problem.problem_id} or fails its checks")
            insts[h] = i
        refs = [self.method_ref(problem, m, v) for m, v in methods]
        if not refs or len({r["method_id"] for r in refs}) != len(refs):
            raise BenchError("list each method once")
        if any(r.get("source") != "builtin" for r in refs):
            raise BenchError("imported results must refer to installed built-in methods")
        for r in refs:
            self.resolve_method(problem, r)
        settings = self.method_settings(problem, refs, method_configs)
        by_id = {r["method_id"]: r for r in refs}
        runs, seen, counts = [], set(), dict(records=len(records), validated=0, rejected=0, declared_objective_mismatches=0)
        for k, rec in enumerate(records):
            if not isinstance(rec, dict) or set(rec) - self.IMPORT_RECORD_KEYS:
                raise BenchError(f"record {k}: unknown fields {sorted(set(rec) - self.IMPORT_RECORD_KEYS) if isinstance(rec, dict) else ''}")
            body = {x: y for x, y in rec.items() if x != "record_sha256"}
            if rec.get("record_sha256") != sha256(body):
                raise IntegrityError(f"record {k}: record_sha256 does not match its content")
            h, mid = rec.get("instance_hash"), rec.get("method_id")
            if h not in insts or mid not in by_id:
                raise BenchError(f"record {k}: scenario or method not declared for this import")
            if (h, mid) in seen:
                raise BenchError(f"record {k}: a second result for the same scenario and method")
            seen.add((h, mid))
            decisions = rec.get("decisions") or []
            errs = problem.check_decisions(decisions) if decisions else ["no decisions"]
            val = problem.validate(insts[h], decisions) if not errs else dict(feasible=False, errors=errs, metrics={},
                                                                              validator_version=problem.validator_version)
            declared = rec.get("declared") or {}
            mism = [m for m, v in declared.items() if isinstance(v, (int, float)) and m in val.get("metrics", {})
                    and abs(val["metrics"][m] - v) > 1e-6 * max(1.0, abs(v))]
            counts["declared_objective_mismatches"] += bool(mism)
            accepted = bool(val["feasible"]) and not mism and rec.get("status_declared") in ("OPTIMAL", "FEASIBLE", "TIME_LIMIT")
            counts["validated" if accepted else "rejected"] += 1
            runs.append(dict(method_id=mid, version=by_id[mid]["version"], source="builtin", instance_hash=h,
                             instance_id=insts[h]["instance_id"], isolation="external",
                             trace=[dict(stage="imported", duration_s=0.0, detail=f"result computed by {source['name']}; re-validated here")],
                             accepted=accepted, status_declared=rec.get("status_declared"), decisions=problem.canonical_decisions(decisions),
                             output_errors=[] if accepted else (val.get("errors") or []) + [f"declared {m} differs" for m in mism],
                             validation=val, declared=declared, declared_mismatch=mism, method_time_s=rec.get("total_time_s"),
                             solver_time_s=rec.get("solver_time_s"), total_time_s=rec.get("total_time_s"),
                             effective_config=rec.get("effective_config") or settings[mid], method_metadata=rec.get("method_metadata") or {},
                             diagnostics=rec.get("diagnostics") or {}, run_id=f"r{len(runs) + 1:05d}", repetition=1,
                             executed_by=str(source.get("executed_by") or source["name"]), executed_at=rec.get("executed_at") or None,
                             origin="imported-external", record_sha256=rec["record_sha256"], installation_id=self.inst.id))
        missing = [(h, m) for h in insts for m in by_id if (h, m) not in seen]
        c = self._new(problem, title, "baseline", dict(params=dict(instance_hashes=list(insts)), generator=dict(name="imported results"),
                                                        instance_hashes=list(insts), instance_ids=[i["instance_id"] for i in insts.values()]),
                      refs, dict(repetitions=1, timeout_s=0.0, time_budget_s=problem.default_time_budget_s,
                                 order="imported", method_configs=settings), None)
        c.update(runs=runs, status="completed", completed_at=now(),
                 environment=dict(source.get("environment") or {}, note=f"results computed outside this platform by {source['name']}"),
                 result_import=dict(source=source, imported_at=now(), imported_by=self.display, into_installation=self.inst.id,
                                    counts=dict(counts, missing_cells=len(missing)),
                                    rule="data only; every record digest checked; every decision set re-validated by the independent "
                                         "validator; declared values compared, never trusted; nothing was solved here"))
        with _lock:
            self._save(c)
        return self.lock(c["campaign_id"])

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

    def create_settings_version(self, parent_id: str, method_configs: dict, title: str | None = None,
                                methods: list[str] | None = None, instance_hashes: list[str] | None = None) -> dict:
        """A new experiment version that differs from a locked parent only by method settings, on the parent's frozen
        scenarios. Only the selected methods run: ``methods`` (method ids of the parent), by default exactly the methods
        whose settings changed — never all methods implicitly. ``instance_hashes`` optionally restricts it to some of
        the parent's scenarios. The changed settings are validated and recorded (``config.method_configs`` and
        ``config_differences_from_parent``). The parent and its results are never modified."""
        parent = self.get(parent_id)
        problem = problem_for(parent)
        everyone = list(parent["methods"])
        for m in everyone:
            self.resolve_method(problem, m)
        cfg = json_copy(parent["config"])
        new = self.method_settings(problem, everyone, method_configs, base=cfg.get("method_configs"))
        changes, changed = [], []
        for m in everyone:
            mid = m["method_id"]
            meta = builtin_registry(problem).get(mid, m["version"])[0] if m.get("source") == "builtin" else None
            before = {**((meta.default_config if meta else {}) or {}), **((cfg.get("method_configs") or {}).get(mid) or {})}
            after = {**((meta.default_config if meta else {}) or {}), **new[mid]}
            diff = [f"settings {mid}: {k} {before.get(k)!r} -> {after.get(k)!r}"
                    for k in sorted(set(before) | set(after)) if before.get(k) != after.get(k)]
            changes += diff
            changed += [mid] if diff else []
        if not changes:
            raise BenchError("the settings are unchanged: no new version is needed")
        ids = list(methods) if methods else changed
        unknown = sorted(set(ids) - {m["method_id"] for m in everyone})
        if unknown or not ids:
            raise BenchError(f"choose methods of this experiment to run{f' (unknown: {unknown})' if unknown else ''}")
        if not set(changed) <= set(ids):
            raise BenchError(f"a method whose settings changed must run: {sorted(set(changed) - set(ids))}")
        selected = [m for m in everyone if m["method_id"] in ids]
        hs = list(parent["scenario_set"]["instance_hashes"])
        if instance_hashes:
            if not set(instance_hashes) <= set(hs) or len(set(instance_hashes)) != len(instance_hashes):
                raise BenchError("choose distinct scenarios of this experiment")
            hs = [h for h in hs if h in set(instance_hashes)]
        id_of = dict(zip(parent["scenario_set"]["instance_hashes"], parent["scenario_set"]["instance_ids"]))
        cfg["method_configs"] = {m["method_id"]: new[m["method_id"]] for m in selected}
        root = base_title(parent["title"]).removesuffix(" — Baseline")
        n = 1 + sum(1 for c in self.list() if c["kind"] == "variant" and c["title"].startswith(f"{root} — Settings "))
        c = self._derive(parent_id, "variant", "perturbs", (title or f"{root} — Settings {n}")[:160], selected,
                         dict(json_copy(parent["scenario_set"]), instance_hashes=hs, instance_ids=[id_of[h] for h in hs]), cfg)
        c["semantic_variant"] = dict(variant="solver-settings", description="solver settings changed: " + "; ".join(changes),
                                     modifications=[], not_applicable=[])
        scope = [f"runs {len(selected)} of {len(everyone)} methods: {', '.join(m['method_id'] for m in selected)}",
                 f"on {len(hs)} of {len(parent['scenario_set']['instance_hashes'])} scenarios"]
        c["config_differences_from_parent"] = changes + scope + c["config_differences_from_parent"]
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

    # ------------------------------------------------------------------ studies (saved, non-destructive views)
    def studies(self) -> list[dict]:
        """Saved study views of this workspace: named lists of (experiment, method) members that were evaluated on the
        same scenarios and are shown together. A study is presentation only: it is stored next to the experiments
        (``studies.json``), never inside a record, and removing it removes nothing else. A study with a member this
        account cannot read (removed access, missing experiment) is not listed."""
        f = self.root / "studies.json"
        try:
            raw = json.loads(f.read_text()) if f.exists() else []
        except ValueError:
            raw = []
        out = []
        for st in raw if isinstance(raw, list) else []:
            try:
                for cid in {m["campaign_id"] for m in st["members"]}:
                    self.get(cid)
            except (BenchError, KeyError, TypeError):
                continue
            out.append(st)
        return out

    def save_study(self, title: str, members: list[dict], featured_instance: str | None = None, description: str = "",
                   study_id: str | None = None) -> dict:
        """Create or replace a study. Members must be methods with results in experiments of this workspace, all on
        the same scenarios with the same problem specification and validator (checked by building the comparison)."""
        from .analysis.compare import compare_members
        title = " ".join(str(title).split())
        if not 3 <= len(title) <= 160:
            raise BenchError("a study title has 3 to 160 characters")
        if not isinstance(members, list) or not 1 <= len(members) <= 12:
            raise BenchError("a study lists 1 to 12 methods")
        clean, seen = [], set()
        for m in members:
            if not isinstance(m, dict) or not SAFE_ID.match(str(m.get("campaign_id", ""))) or not SAFE_ID.match(str(m.get("method_id", ""))):
                raise BenchError("a study member names an experiment and a method")
            key = (m["campaign_id"], m["method_id"])
            if key in seen:
                raise BenchError("a study lists each method of an experiment once")
            seen.add(key)
            clean.append(dict(campaign_id=m["campaign_id"], method_id=m["method_id"],
                              **{k: " ".join(str(m[k]).split())[:120] for k in ("label", "note") if m.get(k)}))
        cmp = compare_members(self, clean)                       # refuses mismatched scenarios, specifications, methods
        hashes = self.get(clean[0]["campaign_id"])["scenario_set"]["instance_hashes"]
        if featured_instance is not None and featured_instance not in hashes:
            raise BenchError("the featured scenario is not one of the study's scenarios")
        with _lock:
            cur = [x for x in self.studies_raw() if x.get("study_id") != study_id]
            sid = study_id if study_id and SAFE_ID.match(study_id) else f"st-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{secrets.token_hex(3)}"
            st = dict(study_id=sid, title=title, description=" ".join(str(description).split())[:600], members=clean,
                      featured_instance=featured_instance, problem_id=cmp["problem"]["problem_id"], scenarios=len(hashes),
                      created_by=self.display, updated_at=now())
            _write(self.root / "studies.json", cur + [st])
        return st

    def studies_raw(self) -> list[dict]:
        f = self.root / "studies.json"
        try:
            raw = json.loads(f.read_text()) if f.exists() else []
        except ValueError:
            raw = []
        return raw if isinstance(raw, list) else []

    def delete_study(self, study_id: str) -> None:
        with _lock:
            cur = self.studies_raw()
            if not any(x.get("study_id") == study_id for x in cur):
                raise NotFound("study not found in this workspace")
            _write(self.root / "studies.json", [x for x in cur if x.get("study_id") != study_id])

    # ------------------------------------------------------------------ bundles (see :mod:`.bundles`)
    def export_bundle(self, cid: str, geometry: bool = True, evidence: dict | None = None,
                      ml_evidence: str = "full") -> tuple[bytes, dict]:
        from . import bundles
        return bundles.export(self, cid, geometry=geometry, evidence=evidence, ml_evidence=ml_evidence)

    def verify_bundle(self, data: bytes) -> tuple[dict, dict, dict, Problem]:
        from . import bundles
        return bundles.verify(self, data)[:4]

    def import_bundle(self, data: bytes) -> dict:
        from . import bundles
        return bundles.import_(self, data)

    # ------------------------------------------------------------------ scenario packages (see :mod:`.scenario_packages`)
    def export_scenario_package(self, instance_hash: str, record: dict | None = None, **kw) -> tuple[bytes, dict]:
        from . import scenario_packages
        return scenario_packages.export(self, instance_hash, record=record, **kw)

    def verify_scenario_package(self, data: bytes) -> dict:
        from . import scenario_packages
        return scenario_packages.verify(self, data)[0]

    def import_scenario_package(self, data: bytes) -> dict:
        from . import scenario_packages
        return scenario_packages.import_(self, data)
