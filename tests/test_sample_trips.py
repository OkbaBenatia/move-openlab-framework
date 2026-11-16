"""The public sample trip dataset (scenario import example): shipped bytes, checksum, licence, and the real CSV import."""
import hashlib
import json
from pathlib import Path

from move_openlab import samples
from test_api import login, make_client

ROOT = Path(__file__).resolve().parents[1]


def test_the_shipped_file_is_the_documented_public_example():
    info = samples.trips_info()
    assert samples.trips_available() and info["synthetic"] is True and info["licence"]["id"] == "CC0-1.0"
    raw = samples.trips_bytes()
    assert hashlib.sha256(raw).hexdigest() == info["sha256"] and len(raw) == info["bytes"]
    example = ROOT / "examples" / "scenario-import" / info["filename"]
    assert example.read_bytes() == raw                                    # the file under examples/ is the same file
    assert (ROOT / "examples" / "scenario-import" / "SHA256SUMS").read_text().split()[0] == info["sha256"]
    lines = raw.decode("utf-8").splitlines()
    assert lines[0].split(",") == info["columns"] and len(lines) - 1 == info["rows"]
    s, w, n, e = info["bbox"]
    for row in lines[1:]:
        _d, _t, ola, olo, dla, dlo, role = row.split(",")
        assert s < float(ola) < n and s < float(dla) < n and w < float(olo) < e and w < float(dlo) < e and role in ("driver", "rider")


def test_download_and_import_through_the_normal_csv_path(tmp_path):
    c = make_client(tmp_path, "a")
    assert c.get("/api/lab/sample/trips").status_code == 401                 # signed-in accounts only
    login(c, "alice")
    st = c.get("/api/lab/state").json()["sample_trips"]
    r = c.get("/api/lab/sample/trips")
    assert r.status_code == 200 and hashlib.sha256(r.content).hexdigest() == st["sha256"] and st["filename"] in r.headers["content-disposition"]
    files = dict(file=(st["filename"], r.content, "text/csv"))
    seen = c.post("/api/datasets/csv/inspect", files=files).json()
    assert seen["delimiter"] == "," and set(st["mapping"].values()) <= set(seen["columns"])
    rep = c.post("/api/datasets/csv/import", files=files, data=dict(mapping=json.dumps(st["mapping"]), name="Sample trips", save="true")).json()
    assert rep["saved"] is True and rep["report"]["rows_kept"] == st["rows"] == rep["report"]["rows_read"] and not rep["report"]["rejected"]
    assert any(d.get("name") == "Sample trips" for d in c.get("/api/datasets").json()["mine"])


def test_a_scenario_from_an_uploaded_dataset_opens_in_the_workspace(tmp_path):
    """An uploaded dataset states its licence as text (an open-data release as a record): the Workspace reads both."""
    from move_openlab.api.lab import _licence_name
    assert _licence_name("as declared by the uploader") == "as declared by the uploader"
    assert _licence_name(dict(id="fr-lo", name="Licence Ouverte", url="https://example.org")) == "Licence Ouverte"
    assert _licence_name(None) is None and _licence_name("") is None
