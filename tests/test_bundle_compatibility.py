"""Bundle compatibility between installations and versions: newer formats and sections are refused with a clear message
and nothing written; a bundle whose method is not available here says it cannot be re-executed (and Run again is
refused); a complete exchange between two isolated researcher accounts verifies, imports, reproduces and compares."""
import hashlib
import io
import json
import shutil
import zipfile

from conftest import ROOT, sandbox_or_skip
from test_api import login, make_client, wait


def _rewrite(data: bytes, edit) -> bytes:
    """Rebuild a bundle after ``edit(members, manifest)``, with consistent member digests and manifest digest — the
    bundle a newer exporter would write, not a corrupted one."""
    z = zipfile.ZipFile(io.BytesIO(data))
    members = {n: z.read(n) for n in z.namelist() if n not in ("manifest.json", "manifest.sha256")}
    man = json.loads(z.read("manifest.json"))
    edit(members, man)
    man["files"] = {n: hashlib.sha256(b).hexdigest() for n, b in sorted(members.items())}
    mb = json.dumps(man, sort_keys=True, separators=(",", ":")).encode()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as w:
        for n, b in sorted(members.items()):
            w.writestr(n, b)
        w.writestr("manifest.json", mb)
        w.writestr("manifest.sha256", hashlib.sha256(mb).hexdigest())
    return out.getvalue()


def _export(c, user="alice"):
    login(c, user)
    base = c.post("/api/lab/demo").json()["baseline_id"]
    return base, c.get(f"/api/campaigns/{base}/export").content


def test_newer_format_and_unknown_sections_are_refused_clearly(tmp_path):
    c = make_client(tmp_path, "compat")
    _, data = _export(c)
    c.post("/api/auth/logout")
    login(c, "bob")
    cases = {
        "format": _rewrite(data, lambda m, man: man.update(format="move-openlab-bundle/3")),
        "section": _rewrite(data, lambda m, man: m.update({"metrics/values.json": b"{}"})),
    }
    for kind, b in cases.items():
        for url in ("/api/lab/inspect", "/api/import"):
            r = c.post(url, files={"file": (f"{kind}.zip", b, "application/zip")})
            assert r.status_code == 422, (kind, url, r.text)
            assert "newer version of MOVE OpenLab" in r.json()["detail"], r.json()["detail"]
    assert c.get("/api/campaigns").json()["campaigns"] == []            # nothing written
    # the rewrite itself is faithful: the unmodified bundle rebuilt the same way still imports
    same = _rewrite(data, lambda m, man: None)
    assert c.post("/api/import", files={"file": ("same.zip", same, "application/zip")}).status_code == 200


def test_complete_exchange_and_missing_method(tmp_path):
    """Alice extends the demonstration with a registered plug-in and exports it; Bob (isolated workspace, method not
    registered) verifies and imports it: the bundle says it cannot be re-executed here and Run again is refused; once
    Bob registers the same pinned code, the re-execution reproduces Alice's validated results."""
    sandbox_or_skip(tmp_path)
    plugins = tmp_path / "plugins"
    shutil.copytree(ROOT / "plugins" / "my_greedy_matching", plugins / "my_greedy_matching")
    c = make_client(tmp_path, "xchg", plugin_dir=plugins, plugin_mode="sandbox")
    login(c, "alice")
    base = c.post("/api/lab/demo").json()["baseline_id"]
    r = c.post("/api/problems/public-ride-matching/methods/register", json=dict(plugin="my_greedy_matching"))
    assert r.status_code == 200, r.text
    ext = c.post(f"/api/campaigns/{base}/extend", json=dict(methods=[["my-greedy-matching", "1.0.0"]])).json()
    wait(c, c.post(f"/api/campaigns/{ext['campaign_id']}/execute").json())
    c.post(f"/api/campaigns/{ext['campaign_id']}/lock")
    data = c.get(f"/api/campaigns/{ext['campaign_id']}/export?evidence=true").content
    alice = c.get(f"/api/lab/experiments/{ext['campaign_id']}").json()
    c.post("/api/auth/logout")

    login(c, "bob")
    assert c.get(f"/api/lab/experiments/{ext['campaign_id']}").status_code == 404     # isolated before the exchange
    files = {"file": ("ext.zip", data, "application/zip")}
    seen = c.post("/api/lab/inspect", files=files).json()
    assert seen["ok"] and seen["importable"] and seen["reproducible_here"] is False
    assert any("my-greedy-matching 1.0.0" in w for w in seen["warnings"])
    assert seen["evidence"]["format"] == "move-openlab-evidence/1"
    assert c.post("/api/import", files=files).status_code == 200
    refused = c.post(f"/api/campaigns/{ext['campaign_id']}/reproduce")
    assert refused.status_code == 422 and "my-greedy-matching" in refused.json()["detail"]
    assert c.post("/api/problems/public-ride-matching/methods/register", json=dict(plugin="my_greedy_matching")).status_code == 200
    assert c.post("/api/lab/inspect", files=files).json()["reproducible_here"] is True
    rep = c.post(f"/api/campaigns/{ext['campaign_id']}/reproduce").json()
    wait(c, c.post(f"/api/campaigns/{rep['campaign_id']}/execute").json())
    e = c.get(f"/api/lab/experiments/{rep['campaign_id']}").json()
    assert e["campaign"]["kind"] == "reproduction" and e["reproduction"]["reproduced"] is True
    assert e["validation"]["accepted"] == e["validation"]["runs"] > 0
    mine = {r["method_id"]: r["totals"] for r in e["results"]["rows"] if r["campaign_id"] == rep["campaign_id"]}
    theirs = {r["method_id"]: r["totals"] for r in alice["results"]["rows"] if r["campaign_id"] == ext["campaign_id"]}
    assert mine == theirs and "my-greedy-matching" in mine
