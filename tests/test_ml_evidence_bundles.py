"""ML evaluation evidence travels with an experiment bundle (section ``ml_evaluations/``): included documents are
re-validated and every figure is recomputed at import; references carry provenance and recorded figures and are shown as
not recomputable; withdrawn evidence and adapter evaluations never travel; a bundle whose evidence does not give the
recorded figures, or that attaches evidence to a method without predictions, is refused before anything is stored."""
import io
import json
import shutil
import zipfile

import pytest
from fastapi.testclient import TestClient

from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.hashing import canonical, sha256_bytes
from test_api import make_settings, wait
from test_lab import _rewrite
from test_ml_evaluation import KNOWN, LEARNED, RIDE, ROOT, tagged, upload

PW = "Operator-Key-2026-xyz"


def installation(tmp, name: str, with_plugin: bool) -> TestClient:
    plugins = tmp / f"{name}-plugins"
    plugins.mkdir()
    if with_plugin:
        shutil.copytree(ROOT / "plugins" / "example_scored_filter", plugins / "example_scored_filter")
    s = make_settings(tmp, name, plugin_dir=plugins, plugin_mode="trusted-process")
    auth = Auth(s, UserStore(None))
    auth.create_user("root", "Root", role="admin", password=PW)
    auth.store.set_password("root", hash_password(PW), must_change=False)
    c = TestClient(create_app(s, auth))
    assert c.post("/api/auth/login", json=dict(username="root", password=PW)).status_code == 200
    return c


@pytest.fixture(scope="module")
def src(tmp_path_factory):
    """Researcher A: the demonstration extended with the example learned method, locked, with imported evidence."""
    tmp = tmp_path_factory.mktemp("mlbundles")
    a = installation(tmp, "a", True)
    base = a.post("/api/lab/demo").json()["baseline_id"]
    assert a.post(f"/api/problems/{RIDE}/methods/register", json=dict(plugin="example_scored_filter")).status_code == 200
    cid = a.post(f"/api/campaigns/{base}/extend", json=dict(methods=[[LEARNED, "1.0.0"]])).json()["campaign_id"]
    wait(a, a.post(f"/api/campaigns/{cid}/execute").json())
    a.post(f"/api/campaigns/{cid}/lock")
    url = f"/api/lab/experiments/{cid}/evaluation"
    r = upload(a, url, tagged("bundle"))
    assert r.status_code == 200, r.text
    withdrawn = upload(a, url, tagged("withdrawn")).json()["evidence_sha256"]
    assert a.post(f"{url}/evidence/{withdrawn}/withdraw").status_code == 200
    return dict(tmp=tmp, a=a, cid=cid, base=base, sha=r.json()["evidence_sha256"], withdrawn=withdrawn)


def bundle(src, mode: str) -> bytes:
    r = src["a"].get(f"/api/campaigns/{src['cid']}/export", params=dict(ml_evidence=mode))
    assert r.status_code == 200, r.text
    assert r.headers["X-Bundle-ML-Evidence"] == mode
    return r.content


def members(data: bytes) -> dict[str, bytes]:
    z = zipfile.ZipFile(io.BytesIO(data))
    return {n: z.read(n) for n in z.namelist()}


def test_the_export_dialog_is_told_what_evidence_exists(src):
    p = src["a"].get(f"/api/lab/export/{src['cid']}").json()
    assert p["ml_evaluations"] == dict(documents=1, references=0, records=400)          # the withdrawn one is not counted


def test_full_export_carries_the_documents_and_the_receiver_recomputes_them(src):
    data = bundle(src, "full")
    m = members(data)
    man = json.loads(m["manifest.json"])
    assert man["ml_evaluations"]["mode"] == "full" and man["ml_evaluations"]["recomputable"] is True
    assert f"ml_evaluations/{src['sha']}.json" in m and f"ml_evaluations/{src['withdrawn']}.json" not in m
    assert sha256_bytes(m[f"ml_evaluations/{src['sha']}.json"]) == src["sha"]
    idx = json.loads(m["ml_evaluations/index.json"])
    e = idx["entries"][0]
    assert {"dataset", "decision", "model", "feature_pipeline", "positive_label", "recorded", "evidence_sha256"} <= set(e)
    assert e["decision"] == dict(rule="score>=threshold", threshold=0.5) and e["recorded"]["confusion"] == KNOWN
    assert {d["id"] for d in idx["metric_definitions"]} >= {"accuracy", "precision", "recall", "f1", "pr_auc", "roc_auc"}
    b = installation(src["tmp"], "b", False)                    # researcher B: another installation, plugin not installed
    rep = b.post("/api/import", files=dict(file=("x.zip", data, "application/zip"))).json()
    assert rep["ml_evaluations"]["recomputed"] == 1 and rep["ml_evaluations"]["references"] == 0
    got = b.get(f"/api/lab/experiments/{src['cid']}/evaluation", params=dict(method_id=LEARNED)).json()
    ev = next(x for x in got["evaluations"] if x.get("evidence_sha256") == src["sha"])
    assert ev["origin"] == "imported" and ev["confusion"] == KNOWN and ev["threshold_adjustable"] is True
    assert ev["source"]["name"].startswith("bundle ")
    # the threshold can be explored on the received evidence: it is really there
    again = b.get(f"/api/lab/experiments/{src['cid']}/evaluation", params=dict(method_id=LEARNED, threshold=0.7)).json()
    assert next(x for x in again["evaluations"] if x.get("evidence_sha256") == src["sha"])["exploratory"] is True
    assert b.get(f"/api/lab/experiments/{src['cid']}/evaluation/evidence/{src['sha']}").content == m[f"ml_evaluations/{src['sha']}.json"]
    # the received record is untouched: same checksum as at the source
    assert b.get(f"/api/campaigns/{src['cid']}").json()["campaign"]["checksum"] == \
        src["a"].get(f"/api/campaigns/{src['cid']}").json()["campaign"]["checksum"]


def test_reference_export_is_shown_as_not_recomputable(src):
    data = bundle(src, "reference")
    m = members(data)
    assert not any(n.startswith("ml_evaluations/") and n != "ml_evaluations/index.json" for n in m)   # no predictions
    idx = json.loads(m["ml_evaluations/index.json"])
    assert all(isinstance(e["records"], int) for e in idx["entries"])                     # a count, not the records
    assert not any(isinstance(v, list) and v and isinstance(v[0], dict) and "label" in v[0] for e in idx["entries"] for v in e.values())
    c = installation(src["tmp"], "c", False)
    rep = c.post("/api/import", files=dict(file=("x.zip", data, "application/zip"))).json()
    assert rep["ml_evaluations"]["recomputed"] == 0 and rep["ml_evaluations"]["references"] == 1
    got = c.get(f"/api/lab/experiments/{src['cid']}/evaluation", params=dict(method_id=LEARNED)).json()
    ev = got["evaluations"][0]
    assert ev["origin"] == "bundle-reference" and ev["recomputable"] is False and ev["confusion"] == KNOWN
    assert ev["sweep"] == [] and ev["threshold_adjustable"] is False and "cannot be recomputed" in ev["reason"]
    assert c.get(f"/api/lab/experiments/{src['cid']}/evaluation/evidence/{src['sha']}").status_code == 404
    # passed on again, a reference stays a reference (even when "full" is asked)
    again = members(c.get(f"/api/campaigns/{src['cid']}/export", params=dict(ml_evidence="full")).content)
    e2 = json.loads(again["ml_evaluations/index.json"])["entries"][0]
    assert e2["included"] is False and e2["recomputable"] is False and e2["recorded"]["confusion"] == KNOWN


def test_none_and_experiments_without_evidence_carry_no_section(src):
    assert not any(n.startswith("ml_evaluations/") for n in members(bundle(src, "none")))
    base = members(src["a"].get(f"/api/campaigns/{src['base']}/export").content)          # the demonstration: no evidence
    assert not any(n.startswith("ml_evaluations/") for n in base) and "ml_evaluations" not in json.loads(base["manifest.json"])


def _forge(data: bytes, change) -> bytes:
    def fn(man, mem):
        change(man, mem)
        man["files"] = {k: sha256_bytes(v) for k, v in sorted(mem.items())}
        return man, mem
    return _rewrite(data, fn)


def test_forged_evidence_is_refused_before_anything_is_stored(src):
    data = bundle(src, "full")
    d = installation(src["tmp"], "d", False)

    def flip_a_label(man, mem):
        name = f"ml_evaluations/{src['sha']}.json"
        doc = json.loads(mem[name])
        doc["records"][0]["label"] = 1 - doc["records"][0]["label"]
        raw = canonical(doc)
        new = sha256_bytes(raw)
        del mem[name]
        mem[f"ml_evaluations/{new}.json"] = raw
        idx = json.loads(mem["ml_evaluations/index.json"])
        idx["entries"][0].update(evidence_sha256=new, file=f"ml_evaluations/{new}.json")
        mem["ml_evaluations/index.json"] = canonical(idx)

    def to_exact_method(man, mem):
        idx = json.loads(mem["ml_evaluations/index.json"])
        idx["entries"][0].update(method_id="exact-matching-highs", campaign_id=src["base"])    # the record that ran it
        mem["ml_evaluations/index.json"] = canonical(idx)

    def stray_file(man, mem):
        mem["ml_evaluations/" + "0" * 64 + ".json"] = b"{}"

    def renamed(man, mem):
        mem[f"ml_evaluations/{'1' * 64}.json"] = mem.pop(f"ml_evaluations/{src['sha']}.json")

    for change, message in ((flip_a_label, "recomputed here differ"), (to_exact_method, "makes no predictions"),
                            (stray_file, "not referenced by the index"), (renamed, "announced but not in the bundle")):
        r = d.post("/api/import", files=dict(file=("x.zip", _forge(data, change), "application/zip")))
        assert r.status_code == 422 and message in r.json()["detail"], (message, r.text)
    assert d.get("/api/campaigns").json()["campaigns"] == []                                 # nothing was stored
