"""After signing in, ``next`` only ever leads to a page of this site (server form and the sign-in page's script)."""
import json
import shutil
import subprocess

import pytest

from move_openlab.api.web import AUTH_JS, _safe_next

OFFSITE = ["//evil.example", "/\\evil.example", "/\\\\evil.example", "/\t/evil.example", "/\n/evil.example",
           "/\r//evil.example", "https://evil.example", "evil.example", "/login", "/login?next=/x", "", None]
LOCAL = ["/", "/#/workspace/abc", "/lab?x=1#y", "/api/../#/admin"]


@pytest.mark.parametrize("n", OFFSITE)
def test_server_refuses_paths_that_leave_the_site(n):
    assert _safe_next(n) == "/"


@pytest.mark.parametrize("n", LOCAL)
def test_server_keeps_local_paths(n):
    assert _safe_next(n) == n


@pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")
def test_sign_in_page_script_refuses_the_same_paths():
    src = AUTH_JS[AUTH_JS.index("  function safeNext(n) {"):AUTH_JS.index("  var next = safeNext(")]
    probe = ("var location = { origin: 'http://127.0.0.1:8765' };\n" + src +
             f"\nconsole.log(JSON.stringify({json.dumps([x for x in OFFSITE if x is not None] + LOCAL)}.map(function (n) {{"
             " var r = safeNext(n); return [r, new URL(r, location.origin).origin]; })));")
    out = json.loads(subprocess.run(["node", "-e", probe], capture_output=True, text=True, check=True).stdout)
    offsite = len([x for x in OFFSITE if x is not None])
    assert all(r == "/" for r, _ in out[:offsite])
    assert all(origin == "http://127.0.0.1:8765" for _, origin in out)
    assert [r for r, _ in out[offsite:]] == ["/", "/#/workspace/abc", "/lab?x=1#y", "/#/admin"]
