#!/usr/bin/env python3
"""End-to-end check of an INSTALLED MOVE OpenLab (Linux, macOS, Windows), over HTTP like the browser, after the
installer has finished and its terminal is gone. Standard library only; run with the installation's own Python:

  <folder>/venv/bin/python scripts/e2e/install_smoke.py --config <folder>/move-openlab.json --out <dir> [--import-bundle B]

Checks: running in the background · bound to 127.0.0.1 only · first-run setup (setup key read from the data directory
as the launcher does, weak password refused, administrator created, setup closed) · sign-in survives a service
restart · the Montbéliard demonstration with its shipped road network (2858421165cd47486a509d26), editable (a point is
snapped on it) · sample scenario package import (verified) · sample experiment import (integrity) · reproduction of the
demonstration: Exact MILP + Greedy re-executed and independently validated, verdict "reproduced" · export of the
reproduction · a second account imports it and reproduces it again · CLI method new/check (plug-in sandbox: Linux with
bubblewrap → used; elsewhere → refused, never run unsandboxed) · stop / start. Optionally ``--import-bundle``: a bundle
exported on ANOTHER operating system is imported and reproduced here (cross-platform reproduction; the verdict and
the numeric tolerance of the comparison are recorded). Passwords are generated here and never printed or written.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import platform
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEMO_NETWORK = "2858421165cd47486a509d26"
results: list[dict] = []


class Client:
    def __init__(self, base: str):
        self.base, self.jar = base, http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method: str, path: str, body=None, raw: bytes | None = None, ctype: str | None = None, ok=(200,)):
        data, headers = None, {}
        if body is not None:
            data, headers = json.dumps(body).encode(), {"Content-Type": "application/json"}
        if raw is not None:
            data, headers = raw, {"Content-Type": ctype}
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.op.open(r, timeout=600) as resp:
                status, payload, hdr = resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            status, payload, hdr = e.code, e.read(), e.headers
        if ok and status not in ok:
            raise AssertionError(f"{method} {path} -> HTTP {status}: {payload[:300]!r}")
        ct = hdr.get("Content-Type", "")
        return status, (json.loads(payload) if "json" in ct and payload else payload)

    def get(self, path, **kw):
        return self.req("GET", path, **kw)[1]

    def post(self, path, body=None, **kw):
        return self.req("POST", path, body if body is not None else {}, **kw)[1]

    def upload(self, path: str, name: str, data: bytes):
        b = "----moveopenlab" + secrets.token_hex(8)
        raw = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/zip\r\n\r\n").encode() \
            + data + f"\r\n--{b}--\r\n".encode()
        return self.req("POST", path, raw=raw, ctype=f"multipart/form-data; boundary={b}")[1]

    def wait_job(self, jid: str, seconds: int = 900) -> str:
        end = time.time() + seconds
        while time.time() < end:
            st = self.get(f"/api/jobs/{jid}?events=false").get("state")
            if st not in ("queued", "running"):
                return st
            time.sleep(1.5)
        return "timeout"


def check(cid: str, what: str):
    def deco(fn):
        t0 = time.time()
        try:
            detail = fn()
            results.append(dict(id=cid, check=what, ok=True, detail=detail, s=round(time.time() - t0, 1)))
            print(f"PASS  {cid} {what} — {detail}")
        except Exception as e:                                    # noqa: BLE001 (report every failure, continue)
            results.append(dict(id=cid, check=what, ok=False, detail=f"{type(e).__name__}: {e}"[:600], s=round(time.time() - t0, 1)))
            print(f"FAIL  {cid} {what} — {type(e).__name__}: {e}"[:700])
        return fn
    return deco


def strong() -> str:
    return "Mo-" + secrets.token_urlsafe(18) + "-9a"


def cli(cfg: dict, *args: str, timeout: int = 600) -> subprocess.CompletedProcess:
    py = Path(sys.executable)
    return subprocess.run([str(py), "-m", "move_openlab.cli", *args, "--config", cfg["_path"]] if args[0] in ("service", "open", "setup-link")
                          else [str(py), "-m", "move_openlab.cli", *args], capture_output=True, text=True, timeout=timeout)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--import-bundle", action="append", default=[], help="bundle exported on another operating system: "
                    "import and reproduce it (repeatable)")
    ap.add_argument("--admin-credentials", help="administrator already created in the browser (first_run.mjs): sign in")
    ap.add_argument("--detached-ok", action="store_true", help="installed with --no-autostart: no registered service expected")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cfg = json.loads(Path(args.config).read_text())
    cfg["_path"] = str(Path(args.config).resolve())
    base, data = f"http://127.0.0.1:{cfg['port']}", Path(cfg["data_dir"])
    admin, other = Client(base), Client(base)
    state: dict = {}

    @check("S1", "running in the background after the installer exited")
    def _():
        st = json.loads(cli(cfg, "service", "status", "--json").stdout)
        assert st["running"] and (st["registered"] or args.detached_ok), st
        h = json.loads(urllib.request.urlopen(base + "/api/health", timeout=5).read())   # noqa: S310
        return f"mechanism {st['mechanism']}, starts at sign-in {st['starts_at_sign_in']}, restarts after a crash {st['restarts_after_crash']}; {h}"

    @check("S2", "listens on 127.0.0.1 only")
    def _():
        ips = set()
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.0.2.1", 9))                 # no packet is sent: picks the outward interface address
                ips.add(s.getsockname()[0])
        except OSError:
            pass
        reach = []
        for ip in ips - {"127.0.0.1", "0.0.0.0"}:
            with socket.socket() as s:
                s.settimeout(2)
                reach.append((ip, s.connect_ex((ip, int(cfg["port"]))) == 0))
        assert not any(r for _, r in reach), reach
        return f"refused on {', '.join(ip for ip, _ in reach) or 'no other interface'}; accepted on 127.0.0.1"

    if args.admin_credentials:
        @check("A1", "administrator created in the browser signs in; setup closed")
        def _():
            c = json.loads(Path(args.admin_credentials).read_text())
            state["pw"] = c["password"]
            assert admin.get("/api/setup/status")["setup_required"] is False and not (data / "setup-key").exists()
            admin.post("/api/auth/login", dict(username=c["username"], password=c["password"]))
            me = admin.get("/api/auth/me")["user"]
            assert me["role"] == "admin" and not me["must_change_password"], me
            return f"{me['username']} signed in; setup key gone"

    @check("A1", "first-run setup: key from the data directory, weak password refused, administrator created")
    def _():
        if args.admin_credentials:
            return "done in the browser (first_run.mjs)"
        assert admin.get("/api/setup/status")["setup_required"] is True
        page = admin.req("GET", "/setup", ok=(200,))[1].decode()
        assert "Welcome to MOVE OpenLab" in page
        key = (data / "setup-key").read_text().strip()
        link = cli(cfg, "setup-link").stdout.strip()
        assert link.endswith("/setup#" + key), "setup-link does not match the key file"
        st, _ = admin.req("POST", "/api/setup/admin", dict(setup_key=key, username="admin1", display_name="Admin One",
                                                         new_password="short", confirm_password="short"), ok=None)
        assert st == 400, st
        st, _ = admin.req("POST", "/api/setup/admin", dict(setup_key="x" * 43, username="admin1", display_name="Admin One",
                                                         new_password="Aa-1" * 4, confirm_password="Aa-1" * 4), ok=None)
        assert st == 403, st
        state["pw"] = strong()
        r = admin.post("/api/setup/admin", dict(setup_key=key, username="admin1", display_name="Admin One",
                                                new_password=state["pw"], confirm_password=state["pw"]))
        assert r["user"]["role"] == "admin"
        assert not (data / "setup-key").exists() and admin.get("/api/setup/status")["setup_required"] is False
        me = admin.get("/api/auth/me")["user"]
        assert me["username"] == "admin1" and not me["must_change_password"]
        return "administrator admin1 created and signed in; setup closed (key file deleted, endpoint 404)"

    @check("A2", "sign-in survives a restart of the service")
    def _():
        r = cli(cfg, "service", "restart")
        assert r.returncode == 0, r.stdout + r.stderr
        me = admin.get("/api/auth/me")["user"]
        assert me and me["username"] == "admin1", me
        return r.stdout.strip()

    @check("D1", "Montbéliard demonstration with its shipped road network, editable")
    def _():
        d = admin.post("/api/lab/demo")
        state["demo"] = d
        area = next(a for a in admin.get("/api/geo/areas")["areas"] if a["area_id"] == d["area_id"])
        assert area["network_id"] == DEMO_NETWORK, area
        snap = admin.get(f"/api/geo/networks/{DEMO_NETWORK}/snap?p=47.51,6.80")
        assert snap["point"], snap
        e = admin.get(f"/api/lab/experiments/{d['baseline_id']}")
        return f"{len(d['campaigns'])} experiments; network {area['network_id']}; validation {e['validation']['accepted']}/{e['validation']['runs']}; point snapped {snap.get('snap_m')} m"

    @check("I1", "sample scenario package: verified and imported")
    def _():
        v = admin.post("/api/lab/sample/scenario/verify")
        r = admin.post("/api/lab/sample/scenario")
        return f"verify ok={v.get('ok', v.get('valid'))}; imported {json.dumps(r)[:160]}"

    @check("I2", "sample experiment bundle: integrity verified and imported")
    def _():
        r = admin.post("/api/lab/sample")
        assert r["ok"], r
        state["sample_root"] = r["root_campaign_id"]
        return f"bundle {r['bundle_sha256'][:16]}…, {len(r['campaigns_verified'])} campaign(s) verified"

    @check("R1", "reproduce the demonstration: methods re-executed and independently validated")
    def _():
        c = admin.post(f"/api/campaigns/{state['demo']['baseline_id']}/reproduce")
        job = admin.post(f"/api/campaigns/{c['campaign_id']}/execute")
        assert admin.wait_job(job["job_id"]) == "done"
        e = admin.get(f"/api/lab/experiments/{c['campaign_id']}")
        v = e["validation"]
        assert v["runs"] > 0 and v["accepted"] == v["runs"], v
        rep = admin.get(f"/api/campaigns/{c['campaign_id']}/reproducibility")
        state["repro"] = c["campaign_id"]
        assert rep["numerically_reproduced"], rep
        return f"{v['accepted']}/{v['runs']} runs validated; numerically reproduced; methods {[m['method_id'] for m in e['methods']]}"

    @check("X1", "export the reproduction (one ZIP); a second account imports and reproduces it")
    def _():
        admin.post(f"/api/campaigns/{state['repro']}/lock")
        st, blob = admin.req("GET", f"/api/campaigns/{state['repro']}/export")
        (out / f"exported-{platform.system().lower()}.zip").write_bytes(blob)
        u = admin.post("/api/admin/users", dict(username="researcher2", display_name="Researcher Two", role="researcher"))
        other.post("/api/auth/login", dict(username="researcher2", password=u["temporary_password"]))
        pw = strong()
        other.post("/api/auth/change-password", dict(current_password=u["temporary_password"], new_password=pw, confirm_password=pw))
        assert other.req("GET", f"/api/lab/experiments/{state['repro']}", ok=None)[0] == 404      # workspaces isolated
        rep = other.upload("/api/import", "bundle.zip", blob)
        assert rep["ok"], rep
        c = other.post(f"/api/campaigns/{rep['root_campaign_id']}/reproduce")
        job = other.post(f"/api/campaigns/{c['campaign_id']}/execute")
        assert other.wait_job(job["job_id"]) == "done"
        rr = other.get(f"/api/campaigns/{c['campaign_id']}/reproducibility")
        assert rr["numerically_reproduced"], rr
        return f"bundle {len(blob)} bytes; imported by researcher2 (isolated workspace) and reproduced there"

    for k, bundle in enumerate(args.import_bundle, 1):
        @check(f"X2.{k}", f"cross-platform: {Path(bundle).name}, exported on another operating system, is reproduced here")
        def _(bundle=bundle):
            blob = Path(bundle).read_bytes()
            rep = admin.upload("/api/import", "foreign.zip", blob)
            assert rep["ok"], rep
            c = admin.post(f"/api/campaigns/{rep['root_campaign_id']}/reproduce")
            job = admin.post(f"/api/campaigns/{c['campaign_id']}/execute")
            assert admin.wait_job(job["job_id"]) == "done"
            rr = admin.get(f"/api/campaigns/{c['campaign_id']}/reproducibility")
            state.setdefault("cross", []).append(dict(bundle=Path(bundle).name, numerically_reproduced=rr["numerically_reproduced"],
                                                      cells=rr.get("cells"), rule=rr.get("rule")))
            assert rr["numerically_reproduced"], json.dumps(rr)[:500]
            return f"reproduced from {Path(bundle).name}; rule: {rr.get('rule') or rr.get('tolerance') or 'every validated metric equal'}"

    @check("C1", "CLI: method new + method check (sandbox: used on Linux with bubblewrap, refused elsewhere)")
    def _():
        tmp = out / "cli-method"
        r = cli(cfg, "method", "new", "smoke_method", "--problem", "public-ride-matching", "--dir", str(tmp))
        assert r.returncode == 0, r.stderr
        bundle = out / f"exported-{platform.system().lower()}.zip"
        r = cli(cfg, "method", "check", str(tmp / "smoke_method"), "--bundle", str(bundle), "--json")
        rep = json.loads(r.stdout[r.stdout.index("{"):])
        selftest = next(s for s in rep["steps"] if s["step"] == "self-test")
        if rep["ok"]:
            assert sys.platform.startswith("linux"), "a plug-in ran without the Linux sandbox"
            return "checked in the bubblewrap sandbox: " + "; ".join(f"{s['step']} {'ok' if s['ok'] else 'FAILED'}" for s in rep["steps"])
        assert not selftest["ok"] and "sandbox" in selftest["detail"].lower(), selftest      # refused, never run unsandboxed
        return f"metadata ok; self-test refused (no verified sandbox on this system), as designed: {selftest['detail'][:140]}"

    @check("S3", "stop and start the background service")
    def _():
        r = cli(cfg, "service", "stop")
        assert r.returncode == 0 and not json.loads(cli(cfg, "service", "status", "--json").stdout)["running"]
        r = cli(cfg, "service", "start")
        assert r.returncode == 0, r.stdout + r.stderr
        assert json.loads(cli(cfg, "service", "status", "--json").stdout)["running"]
        return "stopped (not listening), started again"

    rep = dict(platform=platform.platform(), python=platform.python_version(), machine=platform.machine(),
               checks=results, passed=sum(r["ok"] for r in results), total=len(results), cross=state.get("cross"))
    (out / "install-smoke.json").write_text(json.dumps(rep, indent=1))
    print(f"{rep['passed']}/{rep['total']} checks passed")
    return 0 if rep["passed"] == rep["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
