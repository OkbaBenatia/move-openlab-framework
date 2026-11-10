#!/usr/bin/env python3
"""Development only: create local test accounts with random passwords for a local installation.

Refuses to run when MOVE_OPENLAB_ENV=production. Passwords are written to <data dir>/dev-credentials.json (mode 0600,
inside the git-ignored data directory) and never printed.
Usage: python scripts/dev_provision.py [--admin] [--temporary] researcher1 [...]
  --admin       create administrator accounts
  --temporary   the password is temporary: it must be changed at the first sign-in
"""
from __future__ import annotations

import json
import secrets
import sys

from move_openlab import privatefiles
from move_openlab.auth import Auth, hash_password
from move_openlab.settings import Settings


def main(args: list[str]) -> int:
    admin, temporary = "--admin" in args, "--temporary" in args
    names = [a for a in args if not a.startswith("--")]
    s = Settings.from_env()
    if s.production:
        print("refusing to provision test accounts in production", file=sys.stderr)
        return 2
    auth = Auth(s)
    f = s.data_dir / "dev-credentials.json"
    creds = json.loads(f.read_text()) if f.exists() else {}
    for n in names or ["researcher1"]:
        if auth.store.get(n):
            print(f"{n}: exists")
            continue
        pw = secrets.token_urlsafe(18)
        auth.create_user(n, n.replace("researcher", "Researcher "), role="admin" if admin else "researcher", password=pw,
                         created_by="dev_provision")
        if not temporary:
            auth.store.set_password(n, hash_password(pw), must_change=False)
        creds[n] = pw
        print(f"{n}: created as {'admin' if admin else 'researcher'}{', temporary password' if temporary else ''} "
              f"(password stored in {f})")
    privatefiles.write(f, json.dumps(creds, indent=1))      # 0600 from the start, replaced atomically
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
