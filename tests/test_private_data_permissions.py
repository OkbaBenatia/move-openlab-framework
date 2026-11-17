"""The data directory is owner-only: existing data is tightened at start, new data is created 0600 / 0700."""
from __future__ import annotations

import os
import stat

import pytest

from move_openlab import privatefiles
from move_openlab.api import create_app
from move_openlab.settings import Settings

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits; on Windows the data directory is protected by the user profile's access-control list")


def mode(p) -> int:
    return stat.S_IMODE(os.lstat(p).st_mode)


def test_secure_tree_tightens_without_following_links(tmp_path):
    data, outside = tmp_path / "data", tmp_path / "outside.txt"
    (data / "workspaces" / "w1").mkdir(parents=True)
    f, tool = data / "workspaces" / "w1" / "campaign.json", data / "tool.sh"
    f.write_text("{}"); tool.write_text("#!/bin/sh\n"); outside.write_text("x")
    for p, m in ((data, 0o775), (data / "workspaces", 0o775), (data / "workspaces" / "w1", 0o775), (f, 0o664),
                 (tool, 0o775), (outside, 0o644)):
        os.chmod(p, m)
    os.symlink(outside, data / "link")
    assert privatefiles.secure_tree(data) == 5
    assert mode(data) == mode(data / "workspaces") == mode(data / "workspaces" / "w1") == 0o700
    assert mode(f) == 0o600 and mode(tool) == 0o700          # owner executable bit kept
    assert mode(outside) == 0o644                              # the link target outside is never touched
    assert privatefiles.secure_tree(data) == 0                 # idempotent


def test_secure_tree_skips_entries_it_cannot_open(tmp_path, monkeypatch):
    data = tmp_path / "data"; data.mkdir(); f = data / "x.json"; f.write_text("{}"); os.chmod(f, 0o664)
    real_open = os.open
    monkeypatch.setattr(os, "open", lambda p, *a, **k: (_ for _ in ()).throw(PermissionError(p)) if str(p) == str(f) else real_open(p, *a, **k))
    privatefiles.secure_tree(data)                             # never raises: startup must not fail
    assert mode(f) == 0o664


def test_server_start_secures_existing_data_and_new_files(tmp_path, monkeypatch):
    data = tmp_path / "data"; (data / "jobs").mkdir(parents=True)
    old = data / "jobs" / "old.json"; old.write_text("{}"); os.chmod(old, 0o664); os.chmod(data / "jobs", 0o775)
    monkeypatch.setenv("MOVE_OPENLAB_DATA_DIR", str(data))
    previous = os.umask(0o022)
    try:
        create_app(Settings.from_env())
        assert mode(old) == 0o600 and mode(data / "jobs") == 0o700
        new = data / "jobs" / "new.json"; new.write_text("{}"); (data / "newdir").mkdir()
        assert mode(new) == 0o600 and mode(data / "newdir") == 0o700
        assert not any(mode(os.path.join(t, n)) & 0o077 for t, ds, fs in os.walk(data) for n in ds + fs)
    finally:
        os.umask(previous)
