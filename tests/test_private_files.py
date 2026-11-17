"""Files holding secrets or personal data are owner-only (0600) from creation, whatever the umask, and an existing
wider file is tightened without touching its content: the credential store, its SQLite side files, the audit log and
the development credentials."""
import importlib.util
import json
import os
import stat

import pytest
from fastapi.testclient import TestClient

from move_openlab import privatefiles
from move_openlab.api import create_app
from move_openlab.auth import Auth, hash_password
from move_openlab.auth.store import UserStore
from move_openlab.settings import Settings

from test_api import make_settings

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits; on Windows the data directory is protected by the user profile's access-control list")

ROOT = __import__("pathlib").Path(__file__).resolve().parents[1]


def mode(p) -> int:
    return stat.S_IMODE(os.stat(p).st_mode)


@pytest.fixture
def open_umask():
    old = os.umask(0o002)                          # a permissive umask: files would be 0664 by default
    yield
    os.umask(old)


def test_new_credential_store_is_owner_only(tmp_path, open_umask):
    db = tmp_path / "data" / "auth.sqlite3"
    s = UserStore(db)
    assert mode(db) == 0o600
    s.create("alice", "Alice", hash_password("x" * 16))
    assert s.get("alice") and mode(db) == 0o600                    # writes never widen it
    for side in ("-journal", "-wal", "-shm"):
        assert not os.path.exists(f"{db}{side}") or mode(f"{db}{side}") & 0o077 == 0


def test_existing_wider_store_is_tightened_and_kept(tmp_path, open_umask):
    db = tmp_path / "auth.sqlite3"
    UserStore(db).create("bob", "Bob", hash_password("y" * 16))
    os.chmod(db, 0o644)                            # as created by earlier versions
    journal = tmp_path / "auth.sqlite3-journal"
    journal.write_bytes(b"")
    os.chmod(journal, 0o664)
    again = UserStore(db)
    assert mode(db) == 0o600 and mode(journal) == 0o600
    assert again.get("bob").display_name == "Bob"                  # content untouched


def test_audit_log_is_owner_only(tmp_path, open_umask):
    s = make_settings(tmp_path, "audit")
    auth = Auth(s, UserStore(None))
    auth.create_user("root", "Root", role="admin", password="Admin-password-123!")
    auth.store.set_password("root", hash_password("Admin-password-123!"), must_change=False)
    c = TestClient(create_app(s, auth))
    assert c.post("/api/auth/login", json=dict(username="root", password="Admin-password-123!")).status_code == 200
    assert c.post("/api/admin/users", json=dict(username="carol", display_name="Carol")).status_code == 200
    log = s.data_dir / "audit.log"
    assert mode(log) == 0o600 and json.loads(log.read_text().splitlines()[-1])["target"] == "carol"
    os.chmod(log, 0o664)                           # an older, wider log is tightened at the next entry
    c.post("/api/admin/users/carol/deactivate")
    assert mode(log) == 0o600 and len(log.read_text().splitlines()) == 2
    os.chmod(log, 0o664)                           # ... and when the application starts
    creds = s.data_dir / "dev-credentials.json"
    creds.write_text("{}")
    os.chmod(creds, 0o644)
    create_app(s, auth)
    assert mode(log) == 0o600 and mode(creds) == 0o600


def test_private_write_and_development_credentials(tmp_path, open_umask, monkeypatch):
    f = tmp_path / "secret.json"
    privatefiles.write(f, "{}")
    assert mode(f) == 0o600
    os.chmod(f, 0o644)
    privatefiles.write(f, '{"a": 1}')              # replaced atomically by a new 0600 file
    assert mode(f) == 0o600 and json.loads(f.read_text()) == {"a": 1}
    assert not list(tmp_path.glob(".secret.json.tmp*"))
    data = tmp_path / "dev"
    monkeypatch.setenv("MOVE_OPENLAB_DATA_DIR", str(data))
    monkeypatch.delenv("MOVE_OPENLAB_AUTH_DB", raising=False)
    monkeypatch.delenv("MOVE_OPENLAB_ENV", raising=False)
    spec = importlib.util.spec_from_file_location("dev_provision", ROOT / "scripts" / "dev_provision.py")
    dp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dp)
    assert dp.main(["--admin", "--temporary", "admin"]) == 0
    assert mode(data / "dev-credentials.json") == 0o600 and mode(data / "auth.sqlite3") == 0o600
    assert Auth(Settings.from_env()).store.get("admin").must_change_password
