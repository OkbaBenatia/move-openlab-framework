#!/usr/bin/env python3
"""Write the two public sample packages into ``examples/`` and check them against ``examples/SHA256SUMS``.

  examples/sample_scenario.zip     the sample scenario package (move-openlab-scenario/1), packed from
                                   src/move_openlab/samples/scenario/
  examples/sample_experiment.zip   the sample experiment bundle (move-openlab-bundle/2), packed from
                                   src/move_openlab/samples/montbeliard/ — the same bytes the application serves as
                                   move-openlab-sample-montbeliard.zip

The repository stores no archives (``*.zip`` is git-ignored and refused by ``scripts/check_public_safety.py``): the
packages are kept unpacked and packed deterministically (sorted members, fixed timestamps), so the files written here
are byte-identical to the published checksums. A release can attach them.

Usage:
  python scripts/pack_examples.py            write both files; exit 1 if a checksum differs from SHA256SUMS
  python scripts/pack_examples.py --check    compare without writing
  python scripts/pack_examples.py --update   write both files and rewrite SHA256SUMS (after rebuilding a sample)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from move_openlab import samples
from move_openlab.hashing import sha256_bytes

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
SUMS = EXAMPLES / "SHA256SUMS"


def packages() -> dict[str, bytes]:
    return {samples.SCENARIO_FILENAME: samples.scenario_bytes(), samples.EXPERIMENT_EXAMPLE: samples.bundle_bytes()}


def published() -> dict[str, str]:
    """``{filename: sha256}`` from examples/SHA256SUMS (``sha256sum`` format)."""
    out = {}
    for line in SUMS.read_text().splitlines() if SUMS.is_file() else []:
        if line.strip():
            digest, name = line.split(maxsplit=1)
            out[name.lstrip("*").strip()] = digest
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true")
    a = ap.parse_args()
    pk, pub = packages(), published()
    ok = True
    for name, data in pk.items():
        digest = sha256_bytes(data)
        same = pub.get(name) == digest
        ok &= same or a.update
        if not a.check:
            (EXAMPLES / name).write_bytes(data)
        print(f"{digest}  {name}  {len(data)} bytes  {'matches SHA256SUMS' if same else 'DIFFERS from SHA256SUMS'}"
              + ("" if a.check else f"  -> {(EXAMPLES / name).relative_to(ROOT)}"))
    if a.update:
        SUMS.write_text("".join(f"{sha256_bytes(d)}  {n}\n" for n, d in sorted(pk.items())))
        print(f"wrote {SUMS.relative_to(ROOT)}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
