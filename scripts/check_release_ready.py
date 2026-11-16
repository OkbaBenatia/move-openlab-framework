#!/usr/bin/env python3
"""What must be true before a public release, checked from the repository (and, with ``--assets DIR``, the files to
attach to the GitHub release). Exit code 0 only when every check passes; each failure says what to do.

    python scripts/check_release_ready.py [--assets <dir with sample_scenario.zip, sample_experiment.zip, SHA256SUMS>]

It does not publish anything and never contacts a server."""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APACHE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"   # apache.org LICENSE-2.0.txt
ASSETS = ("sample_scenario.zip", "sample_experiment.zip")


def checks(assets: Path | None) -> list[tuple[str, bool, str]]:
    out = []
    lic = ROOT / "LICENSE"
    out.append(("LICENSE is the verbatim Apache License 2.0", lic.is_file() and hashlib.sha256(lic.read_bytes()).hexdigest() == APACHE_SHA256,
                "copy the text of https://www.apache.org/licenses/LICENSE-2.0.txt unchanged"))
    notice = (ROOT / "NOTICE").read_text() if (ROOT / "NOTICE").is_file() else ""
    out.append(("NOTICE is complete (attribution, no placeholder)", bool(notice) and "Okba BEN ATIA" in notice and not re.search(r"\[[A-Z][A-Z \u2014-]+\]|TO BE CONFIRMED", notice),
                "complete NOTICE: the attribution line and no bracketed placeholder"))
    py = (ROOT / "pyproject.toml").read_text()
    out.append(("pyproject.toml declares Apache-2.0", 'license = "Apache-2.0"' in py, 'add license = "Apache-2.0"'))
    cff = (ROOT / "CITATION.cff").read_text()
    version = re.search(r'__version__ = "([^"]+)"', (ROOT / "src/move_openlab/__init__.py").read_text()).group(1)
    out.append(("CITATION.cff: licence and version match the code", "license: Apache-2.0" in cff and f'version: "{version}"' in cff,
                f"set license: Apache-2.0 and version: \"{version}\""))
    out.append(("CITATION.cff: date-released set for the release", re.search(r"^date-released:", cff, re.M) is not None,
                "add date-released: YYYY-MM-DD on the day of the release"))
    sums = {}
    for line in (ROOT / "examples" / "SHA256SUMS").read_text().splitlines():
        if line.strip():
            h, name = line.split(None, 1)
            sums[name.strip().lstrip("*")] = h
    out.append(("examples/SHA256SUMS lists both sample packages", all(a in sums for a in ASSETS), "run scripts/pack_examples.py --update"))
    if assets is not None:
        for a in ASSETS:
            f = assets / a
            ok = f.is_file() and hashlib.sha256(f.read_bytes()).hexdigest() == sums.get(a)
            out.append((f"release asset {a} matches examples/SHA256SUMS", ok, "rebuild with scripts/pack_examples.py"))
        out.append(("release asset SHA256SUMS present", (assets / "SHA256SUMS").is_file(), "copy examples/SHA256SUMS next to the assets"))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--assets", type=Path, help="directory holding the release assets")
    a = ap.parse_args()
    res = checks(a.assets)
    for name, ok, fix in res:
        print(f"{'ok  ' if ok else 'TODO'} {name}" + ("" if ok else f" — {fix}"))
    bad = sum(1 for _n, ok, _f in res if not ok)
    print(f"{len(res) - bad}/{len(res)} ready" + ("" if not bad else f"; {bad} to do before a release"))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
