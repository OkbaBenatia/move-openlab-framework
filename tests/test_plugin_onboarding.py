"""+ Add method: the plug-in catalogue (ready-made examples, plug-ins provided on the installation, uploads), the
static compatibility check, the upload of a completed plug-in (every refusal of the archive checks), isolation of
uploads between accounts, hash pinning, the template ZIP shared with the CLI, and an uploaded plug-in that registers,
runs on the public demonstration and is validated — inside the verified sandbox, which hides the data directory,
the credential store and other accounts' files from it."""
import io
import json
import os
import shutil
import stat
import zipfile
from pathlib import Path

import pytest

from conftest import ROOT, sandbox_or_skip
from move_openlab import registry, runner
from move_openlab import plugins as P
from move_openlab.methods import ContractError, check_metadata
from move_openlab.runner import run_once
from move_openlab.store import BenchError, Forbidden, ImmutableError, Installation, NotFound
from test_api import login, make_client, wait

PID = "public-ride-matching"
EXAMPLES = ("my_greedy_matching", "nearest_pickup", "example_scored_filter", "regret_greedy")
GREEDY = '''
def solve(instance, config) -> dict:
    used, served, out = set(), set(), []
    for p in sorted(instance["pairs"], key=lambda p: (p["to_pickup_s"], p["driver"], p["rider"])):
        if p["driver"] not in used and p["rider"] not in served:
            used.add(p["driver"]); served.add(p["rider"]); out.append([p["driver"], p["rider"]])
    return dict(decisions=out, status="HEURISTIC", declared=dict(served=len(out)))
'''


def meta_src(method_id="uploaded-greedy", version="1.0.0", problem=PID, extra="", body=GREEDY, **over) -> str:
    p = registry.get(problem) if problem in {x.problem_id for x in registry.all_problems()} else registry.get(PID)
    meta = dict(method_id=method_id, name=over.pop("name", "Uploaded greedy"), version=version, kind="heuristic",
                problem_id=problem, objective_spec_id=over.pop("objective", p.objective_spec_id), deterministic=True,
                author="Test", description="nearest pickup first", default_config=over.pop("default_config", {}))
    return f"METADATA = {meta!r}\n{extra}\n{body}"


def zbytes(entries: list) -> bytes:
    """A ZIP from (name, bytes) or (ZipInfo, bytes) entries, exactly as given (no normalisation)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in entries:
            z.writestr(n, b)
    return buf.getvalue()


def plugin_zip(name="uploaded_greedy", src: str | None = None, extra: list = ()) -> bytes:
    return zbytes([(f"{name}/plugin.py", (src or meta_src()).encode()), (f"{name}/README.md", b"# test\n"), *extra])


@pytest.fixture
def approved(tmp_path):
    """The approved folder: the shipped examples, one plug-in provided by the operator, one written for another
    problem, one claiming a built-in method id."""
    d = tmp_path / "plugins"
    for e in EXAMPLES:
        shutil.copytree(ROOT / "plugins" / e, d / e)
    shutil.copyfile(ROOT / "plugins" / "catalog.json", d / "catalog.json")      # which plug-ins are shown as examples
    (d / "operator_method").mkdir()
    (d / "operator_method" / "plugin.py").write_text(meta_src("operator-method", name="Operator method"))
    (d / "fake_builtin").mkdir()
    (d / "fake_builtin" / "plugin.py").write_text(meta_src("greedy-min-detour", name="Fake built-in"))
    return d


@pytest.fixture
def inst(tmp_path, approved):
    sandbox_or_skip(tmp_path)
    (tmp_path / "auth.sqlite3").write_text("credential store")
    return Installation(tmp_path / "data", approved, "inst-onb", plugin_mode="sandbox", protected=(tmp_path / "auth.sqlite3",))


def by(cat, plugin, origin="approved"):
    return next(i for i in cat if i["plugin"] == plugin and i["origin"] == origin)


# ---------------------------------------------------------------- catalogue and states
def test_catalogue_marks_examples_installation_plugins_and_states(inst):
    w, p = inst.workspace("alice", "Alice"), registry.get(PID)
    cat = w.available_plugins(p)
    assert by(cat, "my_greedy_matching")["catalog"] == "example" and by(cat, "nearest_pickup")["catalog"] == "example"
    assert by(cat, "operator_method")["catalog"] == "installation"
    assert by(cat, "my_greedy_matching")["state"] == by(cat, "operator_method")["state"] == "available"
    other = by(cat, "regret_greedy")
    assert other["state"] == "incompatible" and "problem_id" in other["incompatibility"]
    fake = by(cat, "fake_builtin")
    assert fake["state"] == "incompatible" and "built-in" in fake["incompatibility"]
    assert all(len(i["code_sha256"]) == 64 for i in cat)
    w.register_plugin(p, "nearest_pickup")
    reg = by(w.available_plugins(p), "nearest_pickup")
    assert reg["state"] == "registered" and reg["registered"] and reg["registered_code_sha256"] == reg["code_sha256"]
    f = inst.plugin_dir / "nearest_pickup" / "plugin.py"                       # the file changes after registration
    f.write_text(f.read_text() + "\n# edited\n")
    ch = by(w.available_plugins(p), "nearest_pickup")
    assert ch["state"] == "changed" and not ch["registered"]
    with pytest.raises(BenchError, match="already registered"):              # never silently re-registered
        w.register_plugin(p, "nearest_pickup")
    with pytest.raises(ContractError, match="code changed"):
        w.resolve_method(p, dict(source="plugin", method_id="nearest-pickup", version="1.0.0"))


def test_catalogue_marker_is_presentation_only():
    meta = P.read_plugin_metadata(ROOT / "plugins" / "my_greedy_matching" / "plugin.py")
    assert "catalog" not in meta                                             # the shipped files stay byte-identical
    assert P.catalog_of(meta, ROOT / "plugins", "my_greedy_matching") == "example"   # listed in plugins/catalog.json
    assert P.catalog_of(meta, ROOT / "plugins", "operator_method") is None
    meta = dict(meta, catalog="example")                                     # a plug-in may also say it itself
    m = check_metadata(meta, registry.get(PID))                              # accepted, and not part of the contract
    assert "catalog" not in m.to_dict()
    with pytest.raises(ContractError, match="catalog"):
        check_metadata(dict(meta, catalog="official"), registry.get(PID))


def test_compatibility_check_executes_nothing(inst, monkeypatch):
    monkeypatch.setattr(runner, "execute_isolated", lambda *a, **k: pytest.fail("a worker must not be started"))
    w, p = inst.workspace("alice", "Alice"), registry.get(PID)
    ok = w.check_plugin(p, "my_greedy_matching")
    assert ok["ok"] and [s["step"] for s in ok["steps"]] == ["metadata", "registration"]
    bad = w.check_plugin(p, "regret_greedy")
    assert not bad["ok"] and bad["steps"][0]["step"] == "metadata" and "problem_id" in bad["steps"][0]["detail"]
    assert not w.check_plugin(p, "fake_builtin")["ok"]
    with pytest.raises(NotFound):
        w.check_plugin(p, "../etc")


def test_selftest_check_runs_in_the_sandbox_and_records_nothing(inst):
    w, p = inst.workspace("alice", "Alice"), registry.get(PID)
    r = w.check_plugin(p, "my_greedy_matching", selftest=True)
    assert r["ok"] and r["steps"][-1]["step"] == "self-test" and "sandbox" in r["steps"][-1]["detail"]
    assert w.registered_methods(PID) == []


def test_registering_twice_and_replacing_a_builtin_are_refused_over_http(tmp_path, approved):
    sandbox_or_skip(tmp_path)
    c = make_client(tmp_path, "dup", approved, "sandbox")
    login(c, "alice")
    url = f"/api/problems/{PID}/methods/register"
    first = c.post(url, json=dict(plugin="my_greedy_matching"))
    assert first.status_code == 200 and first.json()["origin"] == "approved"
    again = c.post(url, json=dict(plugin="my_greedy_matching"))
    assert again.status_code == 400 and "already registered" in again.json()["detail"]
    assert c.post(url, json=dict(plugin="fake_builtin")).status_code == 422
    chk = c.post(f"/api/problems/{PID}/methods/check", json=dict(plugin="my_greedy_matching")).json()
    assert not chk["ok"] and "already registered" in chk["steps"][1]["detail"]


def test_a_shipped_example_registers_and_runs_on_the_public_demonstration(tmp_path, approved):
    """Only public parts: the shipped example and the public Montbéliard demonstration, with open-source solvers."""
    sandbox_or_skip(tmp_path)
    c = make_client(tmp_path, "ex", approved, "sandbox")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    assert c.post(f"/api/problems/{PID}/methods/register", json=dict(plugin="nearest_pickup")).status_code == 200
    ext = c.post(f"/api/campaigns/{base}/extend", json=dict(methods=[["nearest-pickup", "1.0.0"]])).json()
    wait(c, c.post(f"/api/campaigns/{ext['campaign_id']}/execute").json())
    e = c.get(f"/api/lab/experiments/{ext['campaign_id']}").json()
    assert e["validation"]["accepted"] == e["validation"]["runs"] > 0
    assert "nearest-pickup" in {r["method_id"] for r in e["results"]["rows"]}


# ---------------------------------------------------------------- upload: every refusal
def _link(name):
    zi = zipfile.ZipInfo(name)
    zi.external_attr = (stat.S_IFLNK | 0o777) << 16
    return zi


def _fifo(name):
    zi = zipfile.ZipInfo(name)
    zi.external_attr = (stat.S_IFIFO | 0o644) << 16
    return zi


GOOD = meta_src().encode()
REFUSED = [
    ("traversal", zbytes([("../evil.py", b"x"), ("m_ok/plugin.py", GOOD)]), "'..'"),
    ("traversal-inside", zbytes([("m_ok/../../evil.py", b"x")]), "'..'"),
    ("absolute", zbytes([("/etc/m_ok/plugin.py", GOOD)]), "absolute"),
    ("backslash", zbytes([("m_ok\\plugin.py", GOOD)]), "backslash"),
    ("symlink", zbytes([("m_ok/plugin.py", GOOD), (_link("m_ok/README.md"), b"/etc/passwd")]), "symbolic link"),
    ("special-file", zbytes([("m_ok/plugin.py", GOOD), (_fifo("m_ok/README.md"), b"")]), "special file"),
    ("too-many-members", zbytes([("m_ok/plugin.py", GOOD)] + [(f"m_ok/README{i}", b"x") for i in range(P.MAX_UPLOAD_MEMBERS)]),
     "entries"),
    ("plugin-too-large", zbytes([("m_ok/plugin.py", GOOD + b"#" * P.MAX_PLUGIN_BYTES)]), "larger than"),
    ("zip-bomb", zbytes([("m_ok/plugin.py", GOOD), ("m_ok/README.md", b"\0" * (P.MAX_UPLOAD_UNCOMPRESSED + 1))]),
     "uncompressed"),
    ("nested-archive", zbytes([("m_ok/plugin.py", GOOD), ("m_ok/inner.zip", zbytes([("a", b"b")]))]), "nested archive"),
    ("nested-archive-renamed", zbytes([("m_ok/plugin.py", GOOD), ("m_ok/README.md", zbytes([("a", b"b")]))]), "nested archive"),
    ("extra-python-file", zbytes([("m_ok/plugin.py", GOOD), ("m_ok/helper.py", b"import os")]), "only plugin.py"),
    ("data-file", zbytes([("m_ok/plugin.py", GOOD), ("m_ok/weights.csv", b"1,2")]), "only plugin.py"),
    ("pycache", zbytes([("m_ok/plugin.py", GOOD), ("m_ok/__pycache__/plugin.cpython-312.pyc", b"x")]), "sub-directories"),
    ("binary-text", zbytes([("m_ok/plugin.py", GOOD), ("m_ok/LICENSE", b"\xff\xfe\0\0")]), "not a text file"),
    ("two-plugin-dirs", zbytes([("m_ok/plugin.py", GOOD), ("m_two/plugin.py", GOOD)]), "exactly one plug-in directory"),
    ("top-level-file", zbytes([("plugin.py", GOOD)]), "inside one plug-in directory"),
    ("no-plugin-file", zbytes([("m_ok/README.md", b"hi")]), "no m_ok/plugin.py"),
    ("bad-dir-name", zbytes([("My-Plugin/plugin.py", GOOD)]), "lowercase"),
    ("not-a-zip", b"this is not a zip", "not a readable ZIP"),
    ("too-large", b"PK" + b"\0" * P.MAX_UPLOAD_BYTES, "larger than"),
    ("no-metadata", plugin_zip(src=GREEDY), "METADATA refused: plugin defines no literal METADATA"),
    ("metadata-not-literal", plugin_zip(src="import os\nMETADATA = dict(os.environ)\n" + GREEDY), "plain literal"),
    ("wrong-problem", plugin_zip(src=meta_src(problem="synthetic-capacitated-bipartite-assignment")),
     "METADATA refused: incompatible method: problem_id"),
    ("wrong-objective", plugin_zip(src=meta_src(objective="other/1.0.0")), "objective_spec_id"),
    ("builtin-id", plugin_zip(src=meta_src("greedy-min-detour")), "cannot replace a built-in"),
    ("syntax-error", plugin_zip(src="METADATA = {\n"), "not valid Python"),
]


@pytest.mark.parametrize("label,data,reason", REFUSED, ids=[r[0] for r in REFUSED])
def test_upload_refusals(inst, label, data, reason, monkeypatch):
    monkeypatch.setattr(runner, "execute_isolated", lambda *a, **k: pytest.fail("an upload must never execute code"))
    w = inst.workspace("alice", "Alice")
    with pytest.raises(ContractError) as e:
        w.upload_plugin(registry.get(PID), data)
    assert reason in str(e.value), str(e.value)
    assert not w.uploads_dir.exists() or not any(w.uploads_dir.iterdir())   # nothing stored, nothing half-written
    assert sorted(os.listdir(inst.plugin_dir)) == sorted([*EXAMPLES, "operator_method", "fake_builtin", "catalog.json"])


def test_upload_is_owner_only_in_the_uploaders_workspace_and_idempotent(inst):
    w, p = inst.workspace("alice", "Alice"), registry.get(PID)
    data = plugin_zip(extra=[("uploaded_greedy/test_plugin.py", b"def test_nothing():\n    pass\n")])
    rec = w.upload_plugin(p, data)
    d = w.uploads_dir / "uploaded_greedy@1.0.0"
    assert rec["plugin"] == "uploaded_greedy@1.0.0" and not rec["unchanged"] and rec["origin"] == "uploaded"
    assert sorted(os.listdir(d)) == ["README.md", "plugin.py", "test_plugin.py", "upload.json"]
    assert (d / "plugin.py").read_bytes() == meta_src().encode()
    assert rec["code_sha256"] == P.code_sha256(d / "plugin.py") and len(rec["upload_sha256"]) == 64
    if os.name == "posix":                                   # owner-only modes (Windows: the profile's access-control list)
        assert stat.S_IMODE(os.stat(d).st_mode) & 0o077 == 0
        assert all(stat.S_IMODE(os.stat(d / f).st_mode) == 0o600 for f in os.listdir(d))
    assert not (inst.plugin_dir / "uploaded_greedy").exists()                  # never the approved folder
    again = w.upload_plugin(p, data)
    assert again["unchanged"] and again["code_sha256"] == rec["code_sha256"]
    other = plugin_zip(src=meta_src(body=GREEDY + "\n# a different version of the code\n"))
    with pytest.raises(ImmutableError, match="different code"):
        w.upload_plugin(p, other)
    assert w.upload_plugin(p, plugin_zip(src=meta_src(version="1.0.1")))["plugin"] == "uploaded_greedy@1.0.1"
    cat = [i for i in w.available_plugins(p) if i["origin"] == "uploaded"]
    assert {i["plugin"] for i in cat} == {"uploaded_greedy@1.0.0", "uploaded_greedy@1.0.1"}
    assert all(i["catalog"] == "uploaded" and i["state"] == "available" for i in cat)


def test_uploads_are_invisible_to_another_account(tmp_path, approved):
    sandbox_or_skip(tmp_path)
    c = make_client(tmp_path, "iso", approved, "sandbox")
    login(c, "alice")
    r = c.post(f"/api/problems/{PID}/methods/upload", files=dict(file=("p.zip", plugin_zip(), "application/zip")))
    assert r.status_code == 200, r.text
    key = r.json()["upload"]["plugin"]
    assert [s["step"] for s in r.json()["steps"]] == ["archive", "metadata"]
    c.post("/api/auth/logout")
    login(c, "bob")
    listed = c.get(f"/api/problems/{PID}/methods").json()["plugins"]
    assert not any(i["origin"] == "uploaded" for i in listed)
    assert c.post(f"/api/problems/{PID}/methods/register", json=dict(plugin=key, origin="uploaded")).status_code == 404
    assert c.post(f"/api/problems/{PID}/methods/check", json=dict(plugin=key, origin="uploaded")).status_code == 404
    assert c.post(f"/api/problems/{PID}/methods/register", json=dict(plugin=f"../alice/plugins/{key}",
                                                                      origin="uploaded")).status_code == 404


def test_trusted_process_mode_refuses_uploads(tmp_path, approved):
    c = make_client(tmp_path, "tp", approved, "trusted-process")
    login(c, "alice")                                                         # a researcher
    m = c.get(f"/api/problems/{PID}/methods").json()
    assert m["can_upload"] is False
    r = c.post(f"/api/problems/{PID}/methods/upload", files=dict(file=("p.zip", plugin_zip(), "application/zip")))
    assert r.status_code == 403
    w = Installation(tmp_path / "tp2", approved, plugin_mode="trusted-process").workspace("admin", "Admin")
    with pytest.raises(ContractError, match="only in the verified sandbox"):    # not even an administrator
        w.upload_plugin(registry.get(PID), plugin_zip(), admin=True)
    with pytest.raises(Forbidden):
        w.upload_plugin(registry.get(PID), plugin_zip())


def test_disabled_plugins_refuse_uploads(tmp_path, approved):
    w = Installation(tmp_path / "d", approved).workspace("alice", "Alice")
    with pytest.raises(ContractError, match="disabled"):
        w.upload_plugin(registry.get(PID), plugin_zip())


def test_hash_pinning_of_an_uploaded_plugin(inst):
    w, p = inst.workspace("alice", "Alice"), registry.get(PID)
    rec = w.upload_plugin(p, plugin_zip())
    reg = w.register_plugin(p, rec["plugin"], origin="uploaded")
    assert reg["origin"] == "uploaded" and reg["code_sha256"] == rec["code_sha256"]
    assert reg["upload_sha256"] == rec["upload_sha256"] and reg["selftest"]["accepted"]
    ref = w.resolve_method(p, dict(source="plugin", method_id="uploaded-greedy", version="1.0.0"))
    assert ref["plugin_file"] == str((w.uploads_dir / rec["plugin"] / "plugin.py").resolve()) and ref["isolation"] == "sandbox"
    f = w.uploads_dir / rec["plugin"] / "plugin.py"
    f.write_bytes(f.read_bytes().replace(b"HEURISTIC", b"OPTIMAL"))          # a modified stored file
    with pytest.raises(ContractError, match="code changed since registration"):
        w.resolve_method(p, dict(source="plugin", method_id="uploaded-greedy", version="1.0.0"))
    assert by(w.available_plugins(p), rec["plugin"], "uploaded")["state"] == "changed"


# ---------------------------------------------------------------- the template ZIP (shared with the CLI)
def test_template_zip_contents(tmp_path):
    c = make_client(tmp_path, "tpl")
    login(c, "alice")
    info = c.get(f"/api/problems/{PID}/methods/template").json()
    assert "pairs" in info["instance_keys"] and "driver_id" in info["decisions"] and "learned" in info["kinds"]
    body = dict(name="my_first_method", display_name="My First Method", author="A. Researcher", kind="hybrid",
                description="Nearest pickup first.")
    r = c.post(f"/api/problems/{PID}/methods/template", json=body)
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["my_first_method/README.md", "my_first_method/plugin.py", "my_first_method/test_plugin.py"]
    src = z.read("my_first_method/plugin.py")
    compile(src, "plugin.py", "exec")                                       # renders to valid Python
    m = check_metadata(P.metadata_from_source(src), registry.get(PID))
    assert (m.method_id, m.name, m.kind, m.author, m.description) == ("my-first-method", "My First Method", "hybrid",
                                                                     "A. Researcher", "Nearest pickup first.")
    readme = z.read("my_first_method/README.md").decode()
    for needle in ("solve(instance, config)", "python -m pytest my_first_method/test_plugin.py",
                   "move-openlab method check my_first_method --bundle", "does not write your algorithm"):
        assert needle in readme, needle
    assert str(tmp_path) not in z.read("my_first_method/test_plugin.py").decode()  # no server path leaks
    name, files = P.inspect_archive(r.content)                              # the template passes the upload checks
    assert name == "my_first_method" and set(files) == {"plugin.py", "test_plugin.py", "README.md"}
    assert c.post(f"/api/problems/{PID}/methods/template", json=dict(body, name="Bad-Name")).status_code == 422
    assert c.post(f"/api/problems/{PID}/methods/template", json=dict(body, kind="magic")).status_code == 422
    assert c.post("/api/problems/no-such-problem/methods/template", json=body).status_code == 404


def test_cli_template_is_the_same_rendering(tmp_path):
    from move_openlab.cli import main
    from move_openlab.method_tools import template_zip
    assert main(["method", "new", "same_method", "--problem", PID, "--dir", str(tmp_path), "--author", "A",
                 "--display-name", "Same", "--kind", "learned", "--description", "D"]) == 0
    z = zipfile.ZipFile(io.BytesIO(template_zip("same_method", PID, "A", "Same", "learned", "D")))
    assert z.read("same_method/plugin.py") == (tmp_path / "same_method" / "plugin.py").read_bytes()
    assert (tmp_path / "same_method" / "README.md").is_file()


# ---------------------------------------------------------------- the complete GUI route, over HTTP
def test_uploaded_completed_template_registers_runs_on_the_demonstration_and_is_validated(tmp_path, approved):
    sandbox_or_skip(tmp_path)
    c = make_client(tmp_path, "gui", approved, "sandbox")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    r = c.post(f"/api/problems/{PID}/methods/template", json=dict(name="my_greedy", display_name="My Greedy"))
    z = zipfile.ZipFile(io.BytesIO(r.content))
    src = z.read("my_greedy/plugin.py").decode()
    done = src[: src.index("def solve(")] + GREEDY.lstrip()
    completed = zbytes([("my_greedy/plugin.py", done.encode()), ("my_greedy/README.md", z.read("my_greedy/README.md")),
                        ("my_greedy/test_plugin.py", z.read("my_greedy/test_plugin.py"))])
    up = c.post(f"/api/problems/{PID}/methods/upload", files=dict(file=("my_greedy.zip", completed, "application/zip")))
    assert up.status_code == 200, up.text
    key = up.json()["upload"]["plugin"]
    chk = c.post(f"/api/problems/{PID}/methods/check", json=dict(plugin=key, origin="uploaded", selftest=True)).json()
    assert chk["ok"] and [s["step"] for s in chk["steps"]] == ["metadata", "registration", "self-test"]
    reg = c.post(f"/api/problems/{PID}/methods/register", json=dict(plugin=key, origin="uploaded"))
    assert reg.status_code == 200 and reg.json()["selftest"]["accepted"]
    again = c.post(f"/api/problems/{PID}/methods/register", json=dict(plugin=key, origin="uploaded"))
    assert again.status_code == 400 and "already registered" in again.json()["detail"]
    ext = c.post(f"/api/campaigns/{base}/extend", json=dict(methods=[["my-greedy", "0.1.0"]])).json()
    wait(c, c.post(f"/api/campaigns/{ext['campaign_id']}/execute").json())
    e = c.get(f"/api/lab/experiments/{ext['campaign_id']}").json()
    assert e["validation"]["accepted"] == e["validation"]["runs"] > 0
    row = next(x for x in e["results"]["rows"] if x["method_id"] == "my-greedy")
    assert row["totals"]["served"] > 0 and not row.get("proven_optimal")
    runs = c.get(f"/api/campaigns/{ext['campaign_id']}").json()["campaign"]["runs"]
    assert all(x["isolation"] == "sandbox" for x in runs if x["method_id"] == "my-greedy")
    log = [json.loads(x) for x in (tmp_path / "gui" / "audit.log").read_text().splitlines()]
    assert {"plugin_uploaded", "plugin_registered"} <= {x["action"] for x in log}
    bad = c.post(f"/api/problems/{PID}/methods/upload", files=dict(file=("evil.zip", zbytes([("../evil.py", b"x")]), "application/zip")))
    assert bad.status_code == 422 and bad.json()["detail"].startswith("ZIP refused")
    assert "plugin_upload_refused" in (tmp_path / "gui" / "audit.log").read_text()


# ---------------------------------------------------------------- the sandbox hides data, credentials, other accounts
PROBE = '''
import os


def _read(p):
    try:
        return open(p, "rb").read(40).decode(errors="replace")
    except Exception as e:
        return "blocked: " + type(e).__name__


def _list(p):
    try:
        return sorted(os.listdir(p))
    except Exception as e:
        return "blocked: " + type(e).__name__


def solve(instance, config):
    d = dict(reads={k: _read(v) for k, v in config["read"].items()}, data_listing=_list(config["data_dir"]),
             own_mount=_read("/sandbox/plugin.py")[:8])
    try:
        open(os.path.join(config["data_dir"], "written-by-plugin"), "w").write("x")
        d["write"] = "written"
    except Exception as e:
        d["write"] = "blocked: " + type(e).__name__
    return dict(decisions=[], status="HEURISTIC", diagnostics=d)
'''


@pytest.fixture
def outside_tmp(tmp_path, approved):
    """An installation whose data directory and credential store are NOT under /tmp (the sandbox's /tmp is a private
    tmpfs, which would hide them anyway): they exist on the host and must still be invisible to the plug-in."""
    sandbox_or_skip(tmp_path)
    # the repository's own cache, unless the repository itself lives under /tmp (a scratch checkout): then /var/tmp,
    # which the sandbox does not replace either
    parent = ROOT / ".pytest_cache" if not str(ROOT.resolve()).startswith("/tmp/") else Path("/var/tmp")
    base = parent / f"onboarding-{os.getpid()}-{os.urandom(4).hex()}"
    base.mkdir(parents=True)
    try:
        (base / "auth.sqlite3").write_text("credential store")
        yield Installation(base / "data", approved, "inst-probe", plugin_mode="sandbox", protected=(base / "auth.sqlite3",)), base
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_an_uploaded_plugin_cannot_read_the_data_directory_credentials_or_other_accounts(outside_tmp):
    inst, tmp_path = outside_tmp
    assert not str(inst.data.resolve()).startswith("/tmp/")
    p = registry.get(PID)
    bob = inst.workspace("bob", "Bob")
    bob_rec = bob.upload_plugin(p, plugin_zip("bobs_method"))
    bob_file = bob.uploads_dir / bob_rec["plugin"] / "plugin.py"
    secret = inst.data / "workspaces" / "bob" / "campaigns" / "c-secret" / "campaign.json"
    secret.parent.mkdir(parents=True)
    secret.write_text('{"secret": "bob data"}')
    alice = inst.workspace("alice", "Alice")
    alice_dir = alice.uploads_dir / "probe_method@1.0.0"
    cfg = dict(data_dir=str(inst.data), read=dict(credentials=str(tmp_path / "auth.sqlite3"),
                                                  installation=str(inst.data / "installation.json"),
                                                  other_account_plugin=str(bob_file), other_account_campaign=str(secret),
                                                  own_stored_file=str(alice_dir / "plugin.py"),
                                                  own_upload_record=str(alice_dir / "upload.json")))
    rec = alice.upload_plugin(p, plugin_zip("probe_method", meta_src("probe-method", default_config=cfg, body=PROBE)))
    assert rec["plugin"] == "probe_method@1.0.0"
    alice.register_plugin(p, rec["plugin"], origin="uploaded")                  # its self-test runs in the sandbox
    ref = alice.resolve_method(p, dict(source="plugin", method_id="probe-method", version="1.0.0"))
    r = run_once(p, ref, p.selftest_instance(), {}, sandbox=inst.sandbox_spec)
    assert r["isolation"] == "sandbox" and r["accepted"], r.get("error")
    d = r["diagnostics"]
    assert d["own_mount"] == "METADATA"                                     # the one bound file is readable ...
    assert all(str(v).startswith("blocked") for v in d["reads"].values()), d["reads"]   # ... nothing else
    assert str(d["data_listing"]).startswith("blocked") and str(d["write"]).startswith("blocked")
    assert not (inst.data / "written-by-plugin").exists()
    assert Path(ref["plugin_file"]).is_relative_to(inst.data.resolve())       # bound from under the data directory
    for v in cfg["read"].values():
        assert Path(v).is_file()                                            # they all exist on the host
