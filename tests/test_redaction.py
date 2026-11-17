"""Messages that reach users (and run records, bundles, job errors) carry no absolute server paths (CodeQL review)."""
import sys
import tempfile
from pathlib import Path

import move_openlab
from move_openlab import redact
from move_openlab.jobs import Jobs


def test_paths_are_reduced_to_placeholders_or_file_names():
    pkg = str(Path(move_openlab.__file__).resolve().parent)
    msg = (f"[Errno 13] Permission denied: '{Path.home()}/lab/plugins/x/plugin.py'; File \"{pkg}/worker.py\", line 3; "
           f"{sys.prefix}/lib/python3/site-packages/highspy/__init__.py; {tempfile.gettempdir()}/move-openlab-run-1/a.json; "
           "/srv/data/workspaces/alice/campaigns/c-1/campaign.json; D:\\Lab\\alice\\data\\x.json")
    out = redact.paths(msg)
    assert str(Path.home()) not in out and pkg not in out and sys.prefix not in out and tempfile.gettempdir() not in out
    assert "/srv/data" not in out and "D:\\Lab" not in out and "alice" not in out
    assert "plugin.py" in out and "worker.py" in out and "campaign.json" in out and "Permission denied" in out
    assert redact.paths("plain message, 12 runs, ratio 3/4") == "plain message, 12 runs, ratio 3/4"


def test_os_errors_are_reported_by_type_only():
    e = PermissionError(13, "Permission denied", "/srv/someone/secret/plugin.py")
    assert redact.exception(e) == "PermissionError (details in the server log)"
    assert "/srv/someone" not in redact.exception(ValueError("bad file /srv/someone/x.json"))


def test_a_failed_job_keeps_no_server_path(tmp_path):
    jobs = Jobs(tmp_path / "jobs")

    def work(mon):
        raise FileNotFoundError(2, "No such file or directory", str(tmp_path / "deep" / "missing.json"))
    jobs.start("alice", "execute", "alice/c-1", work, title="t")
    import time
    for _ in range(200):                                   # the record on disk is written last
        saved = "".join(p.read_text() for p in (tmp_path / "jobs").rglob("*.json"))
        if '"state": "error"' in saved:
            break
        time.sleep(0.05)
    saved = "".join(p.read_text() for p in (tmp_path / "jobs").rglob("*.json"))
    assert "FileNotFoundError" in saved and str(tmp_path) not in saved
