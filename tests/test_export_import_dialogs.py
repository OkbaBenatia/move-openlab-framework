"""Export dialog (preview, optional replay geometry, evidence report), import dialog (inspection without side effect,
new / identical / conflicting records, method availability), and the working area chosen in the Library (Use)."""
import io
import json
import zipfile

from test_api import login, make_client


def _demo(c):
    r = c.post("/api/lab/demo").json()
    return r["baseline_id"], next(x for x in r["campaigns"] if x != r["baseline_id"]), r


def test_export_preview_describes_the_bundle_without_building_it(tmp_path):
    c = make_client(tmp_path, "exp")
    login(c, "alice")
    base, variant, _ = _demo(c)
    p = c.get(f"/api/lab/export/{variant}").json()
    assert p["locked"] and p["format"] == "move-openlab-bundle/2"
    assert [x["kind"] for x in p["campaigns"]] == ["variant", "baseline"]                  # the whole lineage
    assert all(x["runs"] == x["accepted"] == 18 for x in p["campaigns"])
    assert len(p["scenarios"]) == 6 and p["geometry"] == dict(available=6, scenarios=6)    # imported replay geometry
    assert p["datasets"][0]["release"] == "2026-10" and p["networks"][0]["network_id"]
    assert p["vehicles"] >= 2 and {e["scope"] for e in p["emissions"]} == {"operational-energy"}
    assert {m["method_id"] for m in p["methods"]} == {"exact-matching-highs", "greedy-min-detour"}
    assert c.get("/api/lab/export/c-20990101T000000-000000").status_code == 404


def test_export_without_geometry_still_verifies_and_imports_elsewhere(tmp_path):
    c = make_client(tmp_path, "nogeo")
    login(c, "alice")
    base, _, _ = _demo(c)
    full = c.get(f"/api/campaigns/{base}/export").content
    lean = c.get(f"/api/campaigns/{base}/export?geometry=false").content
    names = zipfile.ZipFile(io.BytesIO(lean)).namelist()
    assert not [n for n in names if n.startswith("geometry/")] and len(lean) < len(full)
    c.post("/api/auth/logout")
    login(c, "bob")
    seen = c.post("/api/lab/inspect", files={"file": ("lean.zip", lean, "application/zip")}).json()
    assert seen["ok"] and seen["geometry_verified"] == 0 and any("No replay geometry" in w for w in seen["warnings"])
    assert c.post("/api/import", files={"file": ("lean.zip", lean, "application/zip")}).status_code == 200


def test_inspect_reports_what_an_import_would_do_and_writes_nothing(tmp_path):
    c = make_client(tmp_path, "insp")
    login(c, "alice")
    _, variant, _ = _demo(c)
    data = c.get(f"/api/campaigns/{variant}/export").content
    c.post("/api/auth/logout")
    login(c, "bob")
    files = {"file": ("variant.zip", data, "application/zip")}
    r = c.post("/api/lab/inspect", files=files).json()
    assert r["ok"] and r["importable"] and r["reproducible_here"] and r["adds"] == 2
    assert set(r["present"].values()) == {"new"} and r["filename"] == "variant.zip" and r["bytes"] == len(data)
    assert r["problem_title"] and len(r["scenarios"]) == 6 and r["vehicles"] >= 2 and r["exported_by"] == "Alice"
    assert {x["kind"] for x in r["campaigns_verified"]} == {"variant", "baseline"} and r["warnings"] == []
    assert "runtimes only with conditions" in r["comparable"]
    assert c.get("/api/campaigns").json()["campaigns"] == []                   # inspection imports nothing
    assert c.post("/api/import", files=files).status_code == 200
    again = c.post("/api/lab/inspect", files=files).json()
    assert set(again["present"].values()) == {"identical"} and again["adds"] == 0
    assert any("Already in your workspace" in w for w in again["warnings"])
    bad = bytearray(data)
    bad[len(bad) // 2] ^= 0xFF
    r = c.post("/api/lab/inspect", files={"file": ("bad.zip", bytes(bad), "application/zip")})
    assert r.status_code == 422 and r.json()["detail"]                       # same refusal as the import itself


def test_evidence_report_separates_validation_reproducibility_comparability(tmp_path):
    from test_api import wait
    c = make_client(tmp_path, "evid")
    login(c, "alice")
    base, variant, _ = _demo(c)
    r = c.get(f"/api/lab/experiments/{variant}/evidence")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    e = json.loads(r.content)
    assert e["format"] == "move-openlab-evidence/1" and e["validation"]["accepted"] == e["validation"]["runs"] == 18
    assert e["reproducibility"]["applicable"] is False and e["comparability_with_parent"]["quality"] == "direct"
    assert e["fingerprints"]["experiment"] and e["fingerprints"]["semantic"] and e["results"]
    repro = c.post(f"/api/campaigns/{base}/reproduce").json()
    wait(c, c.post(f"/api/campaigns/{repro['campaign_id']}/execute").json())
    e2 = json.loads(c.get(f"/api/lab/experiments/{repro['campaign_id']}/evidence").content)
    assert e2["reproducibility"]["reproduced"] is True and e2["fingerprints"] is None   # not locked yet


def test_working_area_preference_is_validated(tmp_path):
    c = make_client(tmp_path, "area")
    login(c, "alice")
    _, _, r = _demo(c)
    assert c.put("/api/lab/preferences", json=dict(area_id="../etc")).status_code == 400
    assert c.put("/api/lab/preferences", json=dict(area_id="a-20990101T000000-abcdef")).status_code == 404
    st = c.put("/api/lab/preferences", json=dict(area_id=r["area_id"])).json()
    assert st["preferences"]["area_id"] == r["area_id"]
    assert c.put("/api/lab/preferences", json=dict(area_id="")).json()["preferences"]["area_id"] == ""


def _zip_rewrite(data: bytes, fn, resign: bool = True) -> bytes:
    """Rewrite members with ``fn(manifest, members)``; ``resign`` recomputes manifest.sha256 (a consistent edit)."""
    from move_openlab.hashing import canonical, sha256_bytes
    z = zipfile.ZipFile(io.BytesIO(data))
    members = {n: z.read(n) for n in z.namelist() if n not in ("manifest.json", "manifest.sha256")}
    old = z.read("manifest.sha256")
    man, members = fn(json.loads(z.read("manifest.json")), members)
    mb = canonical(man) if isinstance(man, (dict, list)) else man
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n, b in members.items():
            out.writestr(n, b)
        out.writestr("manifest.json", mb)
        out.writestr("manifest.sha256", sha256_bytes(mb) if resign else old)
    return buf.getvalue()


def test_one_zip_carries_the_evidence_report_and_verification_protects_it(tmp_path):
    from move_openlab.bundles import EVIDENCE, check_manifest
    from move_openlab.hashing import sha256_bytes
    c = make_client(tmp_path, "ev")
    login(c, "alice")
    base, _, _ = _demo(c)
    r = c.get(f"/api/campaigns/{base}/export?evidence=true")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip" and r.headers["x-bundle-evidence"] == "included"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    man = json.loads(z.read("manifest.json"))
    assert z.read("manifest.sha256").decode() == sha256_bytes(z.read("manifest.json"))          # manifest digest
    assert all(sha256_bytes(z.read(n)) == d for n, d in man["files"].items())                  # every member's digest
    assert set(z.namelist()) == set(man["files"]) | {"manifest.json", "manifest.sha256"} and check_manifest(man) == []
    ev = json.loads(z.read(EVIDENCE))
    assert man["evidence"]["file"] == EVIDENCE and ev["experiment"]["campaign_id"] == base and ev["fingerprints"] == man["fingerprints"]
    plain = c.get(f"/api/campaigns/{base}/export")
    assert plain.headers["x-bundle-evidence"] == "not-included" and "evidence/" not in str(zipfile.ZipFile(io.BytesIO(plain.content)).namelist())
    c.post("/api/auth/logout")
    login(c, "bob")
    ok = c.post("/api/lab/inspect", files={"file": ("b.zip", r.content, "application/zip")}).json()
    assert ok["ok"] and ok["evidence"]["sha256"] == man["files"][EVIDENCE]

    def refused(data):
        res = c.post("/api/lab/inspect", files={"file": ("x.zip", data, "application/zip")})
        assert res.status_code in (400, 422) or not res.json().get("ok"), res.text
        return res.text

    def edit_evidence(fn, resign_member=True):
        def go(man, m):
            doc = json.loads(m[EVIDENCE]); fn(doc); m[EVIDENCE] = json.dumps(doc).encode()
            if resign_member:
                man["files"][EVIDENCE] = sha256_bytes(m[EVIDENCE])
            return man, m
        return go
    # an edited report without updated digests, then with consistent digests but another experiment's figures
    assert "checksum mismatch" in refused(_zip_rewrite(r.content, edit_evidence(lambda d: d.update(note="edited"), resign_member=False)))
    assert "does not describe this bundle" in refused(_zip_rewrite(r.content, edit_evidence(lambda d: d["experiment"].update(campaign_id="c-other"))))
    assert "does not describe this bundle" in refused(_zip_rewrite(r.content, edit_evidence(lambda d: d.update(fingerprints=None))))
    # the manifest itself: digest mismatch, missing or mistyped fields, unlisted evidence-like members
    assert "manifest digest mismatch" in refused(_zip_rewrite(r.content, lambda man, m: (dict(man, exported_by="mallory"), m), resign=False))
    for bad in (lambda man: man.pop("files"), lambda man: man.update(instances="all"), lambda man: man.update(fingerprints=[]),
                lambda man: man.update(campaigns=[{"campaign_id": base}]), lambda man: man["files"].update({"x.json": "nothex"})):
        def f(man, m, bad=bad):
            bad(man)
            return man, m
        assert "malformed manifest" in refused(_zip_rewrite(r.content, f))
    assert "unsupported bundle format" in refused(_zip_rewrite(r.content, lambda man, m: ([man], m)))   # not an object
    def extra(man, m):
        m["evidence/notes.json"] = b"{}"; man["files"]["evidence/notes.json"] = sha256_bytes(b"{}")
        return man, m
    assert "unexpected member" in refused(_zip_rewrite(r.content, extra))
    # backward compatibility: a bundle without the report verifies as before (format 1 bundles: test_lab)
    old = c.post("/api/lab/inspect", files={"file": ("p.zip", plain.content, "application/zip")}).json()
    assert old["ok"] and old["evidence"] is None
