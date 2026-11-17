#!/usr/bin/env python3
"""Confidentiality and hygiene gate for the public repository (run locally and in CI).

Checks every file that Git would track (tracked + untracked, honouring .gitignore):

1. denylisted terms — case-insensitive, accent-insensitive substring checks against a list that is NEVER stored in
   the repository (not even hashed: hashes of short words are reversible by dictionary search). The list comes from
   ``--denylist FILE`` or the ``MOVE_OPENLAB_DENYLIST`` environment variable (one term per line; a CI secret). Matched
   terms are never printed;
2. secrets — private keys, common cloud and code-hosting token formats, non-example ``.env`` files;
3. archives and large binaries;
4. absolute home-directory paths;
5. global import-path mutation (``sys.path.insert`` / ``sys.path.append``) in Python sources;
6. automated co-author or tool-attribution trailers in files.

Exit code 0 = clean, 1 = findings (printed as ``path:line: reason`` without echoing the matched secret).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = re.compile(r"\.(zip|tar|tgz|gz|bz2|xz|7z|rar|whl|jar|joblib|pkl|pickle|npz|parquet|onnx)$", re.I)
MAX_BYTES = 1_000_000
SECRET_PATTERNS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "cloud access key id"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"), "code-hosting token"),
    (re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}\b"), "chat token"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "API secret key"),
    (re.compile(r"postgres(ql)?://[^\s:/@]+:[^\s@]+@(?!localhost|127\.0\.0\.1)"), "database URL with credentials"),
    (re.compile(r"scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]{10,}\$[A-Za-z0-9_-]{20,}"), "password hash"),
]
HOME_PATH = re.compile(r"(/home/[a-z_][a-z0-9_-]*/|/Users/[A-Za-z][A-Za-z0-9._-]*/|[A-Z]:\\\\Users\\\\)")
SYS_PATH = re.compile(r"sys\.path\.(insert|append|extend)\s*\(")
ATTRIBUTION = re.compile(r"(co-authored-by:|generated with \[|\bnoreply@anthropic\b)", re.I)


def files() -> list[Path]:
    out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT,
                         capture_output=True, check=True).stdout.decode().split("\0")
    return [ROOT / f for f in out if f and (ROOT / f).is_file()]


# lockfile integrity values are random base64 digests (sha1/sha512), not authored text: a short screening term can occur
# in them by chance, so they are left out of the denylist screening only (secret patterns still see the whole line)
LOCK_DIGEST = re.compile(r'("integrity"\s*:\s*")sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*(")')


def screened(rel: str, line: str) -> str:
    """The text of one line that the denylist screening reads."""
    return LOCK_DIGEST.sub(r"\1\2", line) if rel.endswith("package-lock.json") else line


def norm(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def scan(denylist_terms: list[str]) -> list[str]:
    findings = []
    me = Path(__file__).resolve()
    for f in files():
        rel = f.relative_to(ROOT).as_posix()
        if ARCHIVE.search(rel):
            findings.append(f"{rel}: archive or serialized model file")
            continue
        if f.stat().st_size > MAX_BYTES and not rel.endswith("package-lock.json"):
            findings.append(f"{rel}: file larger than {MAX_BYTES} bytes")
            continue
        name = f.name
        if (name == ".env" or name.startswith(".env.")) and name != ".env.example":
            findings.append(f"{rel}: environment file")
        try:
            text = f.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue                                    # binary assets (images) are only size-checked
        is_self = f.resolve() == me
        for n, line in enumerate(text.splitlines(), 1):
            low = norm(screened(rel, line))
            if any(term in low for term in denylist_terms):
                findings.append(f"{rel}:{n}: denylisted term")
            if is_self:
                continue
            for pat, why in SECRET_PATTERNS:
                if pat.search(line):
                    findings.append(f"{rel}:{n}: possible {why}")
            if HOME_PATH.search(line):
                findings.append(f"{rel}:{n}: absolute home-directory path")
            if rel.endswith(".py") and SYS_PATH.search(line):
                findings.append(f"{rel}:{n}: global import-path mutation")
            if ATTRIBUTION.search(line):
                findings.append(f"{rel}:{n}: automated attribution trailer")
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--denylist", type=Path, help="plain-text list of terms (one per line), kept outside the repository")
    ap.add_argument("--require-denylist", action="store_true", help="fail when no denylist is supplied (CI)")
    a = ap.parse_args()
    raw = a.denylist.read_text() if a.denylist else os.environ.get("MOVE_OPENLAB_DENYLIST", "")
    terms = [norm(t.strip()) for t in raw.splitlines() if t.strip() and not t.strip().startswith("#")]
    if not terms:
        print("no denylist supplied: only the generic checks ran", file=sys.stderr)
        if a.require_denylist:
            return 2
    findings = scan(terms)
    for x in findings:
        print(x)
    print(f"{len(findings)} finding(s) in {len(files())} file(s); {len(terms)} denylist term(s) checked", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
