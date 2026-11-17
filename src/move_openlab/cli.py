"""Command line: ``move-openlab serve``, ``open``, ``service …``, ``setup-link``, ``users add``, ``users reset-password``,
``method new`` and ``method check``."""
from __future__ import annotations

import argparse
import getpass
import sys

from .settings import Settings


def _users_add(args) -> int:
    from .auth import Auth
    s = Settings.from_env()
    auth = Auth(s)
    pw = None
    if args.set_password:
        pw = getpass.getpass("Initial password (min. 12 characters; must be changed at first sign-in): ")
    try:
        user, temp = auth.create_user(args.username, args.display_name or args.username, args.role, password=pw,
                                      supervisor=args.supervisor)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"created {user.username} ({user.role}) in {s.auth_db or 'memory'}")
    if pw is None:
        print("temporary password (shown once, must be changed at first sign-in):")
        print(temp)
    return 0


def _users_reset(args) -> int:
    """Operator recovery on the host (for example a locked-out administrator): new temporary password, forced change
    at the next sign-in, every open session of that account ended."""
    from .auth import Auth
    s = Settings.from_env()
    try:
        user, temp = Auth(s).reset_password(args.username)
    except KeyError:
        print(f"error: unknown user {args.username}", file=sys.stderr)
        return 2
    print(f"temporary password for {user.username} (shown once, must be changed at first sign-in):", file=sys.stderr)
    print(temp)
    return 0


def _method_new(args) -> int:
    from pathlib import Path
    from .method_tools import new_method
    try:
        d = new_method(args.name, args.problem, Path(args.dir), args.author or "", args.display_name or "",
                       args.kind, args.description or "")
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"created {d}/plugin.py, {d}/test_plugin.py and {d}/README.md")
    print(f"next: edit solve(), then  move-openlab method check {d} --bundle <experiment bundle>")
    return 0


def _method_check(args) -> int:
    import json
    from pathlib import Path
    from .method_tools import check_method
    try:
        bundle = Path(args.bundle).read_bytes() if args.bundle else None
    except OSError as e:
        print(f"error: cannot read the bundle: {e}", file=sys.stderr)
        return 2
    if args.json:                       # solvers print banners on the C-level stdout: keep it for the JSON report only
        import os
        sys.stdout.flush()
        saved = os.dup(1)
        os.dup2(2, 1)
        try:
            rep = check_method(Path(args.path), bundle)
        finally:
            sys.stdout.flush()
            os.dup2(saved, 1)
            os.close(saved)
        print(json.dumps(rep, indent=1))
        return 0 if rep["ok"] else 1
    rep = check_method(Path(args.path), bundle)
    if args.json:
        print(json.dumps(rep, indent=1))
    else:
        for s in rep["steps"]:
            print(f"[{'ok' if s['ok'] else 'FAILED'}] {s['step']}: {s['detail']}")
            for bad in s.get("invalid") or []:
                print(f"    {bad['instance']}: {'; '.join(map(str, bad['errors']))[:300]}")
            for row in s.get("comparison") or []:
                print(f"    {row['method_id']:<28} valid={row['valid']} totals={row['totals']} optimal={row['optimal']}")
    return 0 if rep["ok"] else 1


def _serve(args) -> int:
    from pathlib import Path
    from . import service as SV
    cfg = None
    if args.config:
        cfg = SV.load_config(args.config)
        SV.prepare_environment(cfg)
        args.host, args.port = cfg.get("host", "127.0.0.1"), int(cfg["port"])
        args.log_file = args.log_file or str(SV.log_dir(cfg) / "server.log")      # a background service has no console
    if args.log_file:
        SV.log_to_file(Path(args.log_file))
    if not SV.port_free(args.port, args.host):
        print(f"error: port {args.port} on {args.host} is already in use"
              + (" by MOVE OpenLab (it is already running)" if SV.health(args.port) else " by another application")
              + "; stop it or use --port", file=sys.stderr)
        return SV.EXIT_PORT_IN_USE
    import uvicorn
    from .api import create_app
    from .sandbox import harden_current_process
    hardened = harden_current_process()          # other same-user processes can no longer read our environment/memory
    settings = Settings.from_env()
    app = create_app(settings)
    st = app.state.installation.plugin_status()
    print(f"process hardening: {'on' if hardened else 'unavailable'} · plugins: "
          f"{'enabled (' + st['isolation'] + ')' if st['enabled'] else 'off — ' + str(st['reason'])}")
    from .auth import setup as first_run
    if first_run.needed(app.state.auth):
        print("no account yet: open MOVE OpenLab with its launcher or 'move-openlab open' to create the administrator")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", log_config=None if args.log_file else uvicorn.config.LOGGING_CONFIG)
    return 0


def _service(args) -> int:
    import json
    from pathlib import Path
    from . import service as SV
    if args.scmd == "install":
        rep = SV.install(Path(args.home), args.port, Path(args.data_dir) if args.data_dir else None,
                         launcher=not args.no_launcher, autostart=not args.no_autostart, browser=not args.no_browser)
        rep["cli"] = SV.cli_path(dict(home=rep["installation"]))
        print(json.dumps(rep, indent=1) if args.json else ("\n" + SV.completion_message(rep) + "\n" if rep["running"] else
              f"MOVE OpenLab {rep['version']} was installed but did not start: see {rep['cli']} service logs"))
        return 0 if rep["running"] else 1
    cfg = SV.load_config(args.config)
    if args.scmd == "status":
        st = SV.status(cfg)
        print(json.dumps(st, indent=1) if args.json else "\n".join(f"{k}: {v}" for k, v in st.items()))
        return 0 if st["running"] else 3
    if args.scmd == "start":
        SV.start(cfg)
        ok = SV.wait_until_up(int(cfg["port"]))
        print(f"MOVE OpenLab {'is running at ' + SV.base_url(cfg) if ok else 'did not start: see ' + str(SV.log_dir(cfg))}")
        return 0 if ok else 1
    if args.scmd == "stop":
        SV.stop(cfg)
        print("MOVE OpenLab stopped" + (" (it starts again at your next sign-in)" if SV.status(cfg)["registered"] else ""))
        return 0
    if args.scmd == "restart":
        SV.restart(cfg)
        ok = SV.wait_until_up(int(cfg["port"]))
        print("MOVE OpenLab restarted" if ok else "MOVE OpenLab did not start again: see " + str(SV.log_dir(cfg)))
        return 0 if ok else 1
    if args.scmd == "logs":
        f = SV.log_dir(cfg) / "server.log"
        lines = f.read_text(errors="replace").splitlines()[-args.lines:] if f.is_file() else []
        print("\n".join(lines) or f"no log yet ({f})")
        return 0
    if args.scmd == "uninstall":
        if args.remove_data and not args.yes:
            print("error: --remove-data deletes every account, experiment and result of this installation; "
                  "add --yes to confirm", file=sys.stderr)
            return 2
        rep = SV.uninstall(cfg, remove_data=args.remove_data)
        print(json.dumps(rep, indent=1) if args.json else
              f"background service and launcher removed; data {'deleted' if rep['data_removed'] else 'kept in ' + rep['data_dir']}; "
              f"you can now delete the folder {rep['folder']}")
        return 0
    return 2


def _open(args) -> int:
    """What the "MOVE OpenLab" launcher runs: start the background service if the server is not answering (never a
    second server), wait until it is ready, then open the browser. A failure is explained to the person who clicked."""
    import webbrowser
    from . import service as SV
    cfg = SV.load_config(args.config)
    port = int(cfg["port"])
    if not SV.health(port):
        try:
            SV.start(cfg)                    # refuses when another application holds the port; no-op if already starting
        except SystemExit as e:
            SV.alert("MOVE OpenLab could not start", f"{str(e).removeprefix('error: ')}\n\nDetails: {SV.cli_path(cfg)} service logs",
                     SV.log_dir(cfg))
            return 1
        if not SV.wait_until_up(port, 60):
            SV.alert("MOVE OpenLab could not start", f"The server did not answer within a minute.\n\nDetails: "
                     f"{SV.cli_path(cfg)} service logs (log folder: {SV.log_dir(cfg)})", SV.log_dir(cfg))
            return 1
    url = SV.open_url(cfg)
    if not args.no_browser:
        webbrowser.open(url)
    print(f"MOVE OpenLab: {SV.base_url(cfg)}/")
    return 0


def _setup_link(args) -> int:
    """For a computer without a browser on the same desktop (headless): print the one-time setup link."""
    from . import service as SV
    cfg = SV.load_config(args.config)
    url = SV.open_url(cfg)
    if "/setup#" not in url:
        print("setup is complete: sign in at " + SV.base_url(cfg) + "/", file=sys.stderr)
        return 1
    print(url)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="move-openlab", description="MOVE OpenLab experimentation framework")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sv = sub.add_parser("serve", help="run the web application")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8765)
    sv.add_argument("--config", help="installation configuration (move-openlab.json): port, data directory, frontend")
    sv.add_argument("--log-file", help="write the server log to this file (default with --config: <data>/logs/server.log)")
    sv.set_defaults(fn=_serve)
    op = sub.add_parser("open", help="open MOVE OpenLab in the browser (starts its background service if needed)")
    op.add_argument("--config")
    op.add_argument("--no-browser", action="store_true", help="only start it and print the address")
    op.set_defaults(fn=_open)
    sl = sub.add_parser("setup-link", help="print the one-time first-run setup link (computers without a local browser)")
    sl.add_argument("--config")
    sl.set_defaults(fn=_setup_link)
    se = sub.add_parser("service", help="background service of this installation: install, status, start, stop, restart, logs, uninstall")
    se_sub = se.add_subparsers(dest="scmd", required=True)
    si = se_sub.add_parser("install", help="register the background service, create the launcher, start and open (used by the installer)")
    si.add_argument("--home", required=True, help="installation folder (contains app/ and venv/)")
    si.add_argument("--port", type=int, help="port on 127.0.0.1 (default: 8765, or the next free one)")
    si.add_argument("--data-dir", help="data directory (default: the operating system's application-data folder)")
    si.add_argument("--no-launcher", action="store_true")
    si.add_argument("--no-autostart", action="store_true", help="do not register a background service (start by hand)")
    si.add_argument("--no-browser", action="store_true")
    si.add_argument("--json", action="store_true")
    for name, hlp in (("status", "is it registered and running"), ("start", "start it"), ("stop", "stop it"),
                      ("restart", "stop and start it"), ("logs", "last lines of the server log"),
                      ("uninstall", "remove the service and the launcher (the data is kept unless --remove-data --yes)")):
        x = se_sub.add_parser(name, help=hlp)
        x.add_argument("--config")
        x.add_argument("--json", action="store_true")
        if name == "logs":
            x.add_argument("--lines", type=int, default=60)
        if name == "uninstall":
            x.add_argument("--remove-data", action="store_true")
            x.add_argument("--yes", action="store_true")
    se.set_defaults(fn=_service)
    us = sub.add_parser("users", help="manage local accounts")
    us_sub = us.add_subparsers(dest="ucmd", required=True)
    add = us_sub.add_parser("add", help="create an account (temporary password, forced change at first sign-in)")
    add.add_argument("username")
    add.add_argument("--display-name")
    add.add_argument("--role", choices=["researcher", "admin", "student"], default="researcher")
    add.add_argument("--supervisor", help="students: username of the supervising researcher (or an administrator)")
    add.add_argument("--set-password", action="store_true", help="prompt for the initial password instead of generating one")
    add.set_defaults(fn=_users_add)
    rs = us_sub.add_parser("reset-password", help="operator recovery: new temporary password (forced change at next sign-in)")
    rs.add_argument("username")
    rs.set_defaults(fn=_users_reset)
    me = sub.add_parser("method", help="create and check a method plugin")
    me_sub = me.add_subparsers(dest="mcmd", required=True)
    mn = me_sub.add_parser("new", help="create a method from the template")
    mn.add_argument("name", help="directory and method name (lowercase letters, digits, '_')")
    mn.add_argument("--problem", required=True, help="problem id, e.g. public-ride-matching")
    mn.add_argument("--dir", default=".", help="where to create the method directory")
    mn.add_argument("--author")
    mn.add_argument("--display-name", help="name shown in the interface (default: from the directory name)")
    mn.add_argument("--kind", default="heuristic", choices=("exact", "heuristic", "learned", "hybrid"))
    mn.add_argument("--description", help="one-sentence description of the rule the method follows")
    mn.set_defaults(fn=_method_new)
    mc = me_sub.add_parser("check", help="metadata, sandboxed self-test, optional run on an experiment bundle")
    mc.add_argument("path", help="method directory (or its plugin.py)")
    mc.add_argument("--bundle", help="experiment bundle (.zip) whose instances the method must solve")
    mc.add_argument("--json", action="store_true")
    mc.set_defaults(fn=_method_check)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
