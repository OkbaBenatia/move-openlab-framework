"""Developer workflow for a new method: create it from the template, then check it the way the platform will run it.

``new_method``   writes ``<dest>/<name>/plugin.py``, ``test_plugin.py`` and ``README.md`` for a problem.
``template_zip`` the same files as a ZIP (``<name>/...``) for the web interface's "Create from template" — one
                 template, one rendering, shared with the CLI.
``check_method`` runs, in a throw-away installation and in order (stopping at the first failure):
    1. metadata  — read statically and checked against the problem (nothing executed);
    2. self-test — registration: one run on the problem's reserved self-test instance in the verified sandbox;
    3. benchmark — optional: the bundle is verified and imported, the method extends the imported experiment and
                   is executed on its instances; every run is validated independently and compared with the
                   experiment's reference method.
Each step reports ``ok`` and an actionable ``detail``. Nothing is written outside the temporary directory.
"""
from __future__ import annotations

import io
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from string import Template

from . import registry
from .analysis.compare import compare
from .methods import KINDS, ContractError, check_metadata
from .plugins import PLUGIN_FILE, read_plugin_metadata
from .store import BenchError, Installation

TEMPLATES = Path(__file__).resolve().parent / "templates" / "method"
NAME = re.compile(r"^[a-z][a-z0-9_]{2,40}$")


def _doc(value) -> str:
    """Text safe inside a generated docstring: no backslash escapes, no closing triple quote."""
    return str(value).replace("\\", "/").replace('"' * 3, "'" * 3)


def template_values(problem) -> dict:
    """What a new method of ``problem`` receives and returns (shown by the CLI template and the web interface)."""
    keys = [k for k in sorted(problem.selftest_instance()) if k not in ("instance_hash", "schema")]
    return dict(problem_id=problem.problem_id, title=problem.title, objective_spec_id=problem.objective_spec_id,
                instance_keys=keys, decisions=problem.decision_description or "the problem's decision list",
                kinds=list(KINDS), version="0.1.0", entry_point="solve(instance, config)")


def _text(value, what: str, limit: int) -> str:
    v = " ".join(str(value or "").split())              # one line: no control characters, no newlines
    if len(v) > limit:
        raise ValueError(f"{what} must be at most {limit} characters")
    return v


def new_method(name: str, problem_id: str, dest: Path, author: str = "", display_name: str = "", kind: str = "heuristic",
               description: str = "", shown_dir: str | None = None) -> Path:
    """Create ``<dest>/<name>/`` from the template. ``shown_dir`` is how the generated files refer to the directory
    (default: its real path; the web interface's ZIP uses the bare name)."""
    if not NAME.match(name):
        raise ValueError("name must be 3-41 characters: lowercase letters, digits, '_' and start with a letter")
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    try:
        problem = registry.get(problem_id)
    except registry.UnknownProblem:
        raise ValueError(f"unknown problem {problem_id!r}; installed: {[p.problem_id for p in registry.all_problems()]}") from None
    d = Path(dest) / name
    if d.exists():
        raise ValueError(f"{d} already exists")
    tv = template_values(problem)
    title = _text(display_name, "display name", 80) or name.replace("_", " ").title()
    author = _text(author, "author", 80) or "Your name"
    description = _text(description, "description", 300) or "Describe the rule your method follows."
    shown = shown_dir if shown_dir is not None else str(d)
    lit = json.dumps                                  # a JSON string is a valid Python string literal
    values = dict(name=_doc(title), name_lit=lit(title), method_id_lit=lit(name.replace("_", "-")),
                  problem_id=_doc(problem_id), problem_id_lit=lit(problem_id),
                  objective_lit=lit(problem.objective_spec_id), author_lit=lit(author), kind_lit=lit(kind),
                  description_lit=lit(description), decisions=_doc(tv["decisions"]),
                  instance_keys=_doc(", ".join(tv["instance_keys"])), test_file=_doc(f"{shown}/test_plugin.py"),
                  plugin_dir=_doc(shown), dir_name=name)
    d.mkdir(parents=True)
    for tmpl, out in (("plugin.py.tmpl", PLUGIN_FILE), ("test_plugin.py.tmpl", "test_plugin.py"), ("README.md.tmpl", "README.md")):
        (d / out).write_text(Template((TEMPLATES / tmpl).read_text()).substitute(values))
    return d


TEMPLATE_FILES = (PLUGIN_FILE, "test_plugin.py", "README.md")


def template_zip(name: str, problem_id: str, author: str = "", display_name: str = "", kind: str = "heuristic",
                 description: str = "") -> bytes:
    """The files of :func:`new_method` as a deterministic ZIP ``<name>/plugin.py``, ``<name>/test_plugin.py``,
    ``<name>/README.md`` (the web interface's "Create from template"). Nothing is stored or executed."""
    with tempfile.TemporaryDirectory(prefix="move-openlab-template-") as tmp:
        d = new_method(name, problem_id, Path(tmp), author, display_name, kind, description, shown_dir=name)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for fn in TEMPLATE_FILES:
                zi = zipfile.ZipInfo(f"{name}/{fn}", date_time=(2026, 1, 1, 0, 0, 0))
                zi.external_attr, zi.compress_type = 0o100644 << 16, zipfile.ZIP_DEFLATED
                z.writestr(zi, (d / fn).read_bytes())
        return buf.getvalue()


def _step(steps: list, name: str, ok: bool, detail, **extra) -> bool:
    steps.append(dict(step=name, ok=ok, detail=detail, **extra))
    return ok


def check_method(path: Path, bundle: bytes | None = None, plugin_mode: str = "sandbox") -> dict:
    path = Path(path).resolve()
    f = path / PLUGIN_FILE if path.is_dir() else path
    steps: list[dict] = []
    report = dict(plugin=str(f), steps=steps, ok=False)
    if not f.is_file() or f.name != PLUGIN_FILE:
        _step(steps, "metadata", False, f"{f} not found (expected <method directory>/{PLUGIN_FILE})")
        return report
    try:
        meta = read_plugin_metadata(f)
        problem = registry.get(str(meta.get("problem_id")))
        m = check_metadata(meta, problem)
    except registry.UnknownProblem:
        _step(steps, "metadata", False, f"problem_id {meta.get('problem_id')!r} is not installed")
        return report
    except (ContractError, SyntaxError, ValueError, OSError) as e:
        _step(steps, "metadata", False, str(e))
        return report
    _step(steps, "metadata", True, f"{m.method_id}@{m.version} ({m.kind}) for {problem.problem_id}")
    report["method"] = dict(method_id=m.method_id, version=m.version, problem_id=problem.problem_id)
    with tempfile.TemporaryDirectory(prefix="move-openlab-check-") as tmp:
        tmp = Path(tmp)
        (tmp / "plugins" / f.parent.name).mkdir(parents=True)          # only the plugin file is checked and run
        shutil.copyfile(f, tmp / "plugins" / f.parent.name / PLUGIN_FILE)
        inst = Installation(tmp / "data", tmp / "plugins", "method-check", plugin_mode=plugin_mode)
        w = inst.workspace("checker", "Method check")
        try:
            reg = w.register_plugin(problem, f.parent.name, admin=True)
        except (BenchError, ContractError) as e:
            _step(steps, "self-test", False, str(e))
            return report
        st = reg["selftest"]
        _step(steps, "self-test", True, f"valid result on the self-test instance ({reg['isolation_at_registration']})",
              metrics=st["validation"]["metrics"])
        if bundle is None:
            report["ok"] = True
            return report
        try:
            imp = w.import_bundle(bundle)
            if imp["problem_id"] != problem.problem_id:
                raise BenchError(f"the bundle studies {imp['problem_id']}, the method {problem.problem_id}")
            ext = w.create_extension(imp["root_campaign_id"], [(m.method_id, m.version)])
            w.execute(ext["campaign_id"])
        except (BenchError, ContractError) as e:
            _step(steps, "benchmark", False, str(e))
            return report
        c = w.get(ext["campaign_id"])
        runs = [r for r in c["runs"] if r["method_id"] == m.method_id and r.get("repetition") == 1]
        bad = [dict(instance=r["instance_id"], errors=(r.get("output_errors") or []) + r["validation"]["errors"]
                    + ([r["error"]] if r.get("error") else [])) for r in runs if not r["accepted"]]
        cmp = compare(w, ext["campaign_id"])
        rows = [dict(method_id=r["method_id"], valid=r["all_feasible"], totals=r["totals"], optimal=r.get("optimal"),
                     scenarios=r["scenarios"], median_total_time_s=r["median_total_time_s"]) for r in cmp["rows"]]
        ok = not bad and bool(runs)
        _step(steps, "benchmark", ok,
              f"{len(runs) - len(bad)}/{len(runs)} runs valid on the imported experiment" if runs else "no run executed",
              invalid=bad[:10], comparison=rows, reference=cmp["reference"])
        report["ok"] = ok
    return report
