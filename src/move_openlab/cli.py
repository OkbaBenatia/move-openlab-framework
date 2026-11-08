"""Command line: ``move-openlab serve``, ``users add``, ``users reset-password``, ``method new`` and ``method check``."""
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
        user, temp = auth.create_user(args.username, args.display_name or args.username, args.role, password=pw)
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
        d = new_method(args.name, args.problem, Path(args.dir), args.author or "")
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(f"created {d}/plugin.py and {d}/test_plugin.py")
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
    import uvicorn
    from .api import create_app
    from .sandbox import harden_current_process
    hardened = harden_current_process()          # other same-user processes can no longer read our environment/memory
    settings = Settings.from_env()
    app = create_app(settings)
    st = app.state.installation.plugin_status()
    print(f"process hardening: {'on' if hardened else 'unavailable'} · plugins: "
          f"{'enabled (' + st['isolation'] + ')' if st['enabled'] else 'off — ' + str(st['reason'])}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="move-openlab", description="MOVE OpenLab experimentation framework")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sv = sub.add_parser("serve", help="run the web application")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8765)
    sv.set_defaults(fn=_serve)
    us = sub.add_parser("users", help="manage local accounts")
    us_sub = us.add_subparsers(dest="ucmd", required=True)
    add = us_sub.add_parser("add", help="create an account (temporary password, forced change at first sign-in)")
    add.add_argument("username")
    add.add_argument("--display-name")
    add.add_argument("--role", choices=["researcher", "admin"], default="researcher")
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
