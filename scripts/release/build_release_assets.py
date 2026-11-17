#!/usr/bin/env python3
"""Build the assets of a MOVE OpenLab release from the current Git tree (run from a clean checkout of the tag).

  dist-release/move-openlab-X.Y.Z.tar.gz   application archive for Linux and macOS
  dist-release/move-openlab-X.Y.Z.zip      the same files for Windows
  dist-release/install.sh                  installer for Linux and macOS (version and archive SHA-256 built in)
  dist-release/install.ps1                 installer for Windows (version and archive SHA-256 built in)
  dist-release/sample_scenario.zip, sample_experiment.zip   the public sample packages (scripts/pack_examples.py)
  dist-release/SHA256SUMS                  checksums of every file above

Each archive holds the tracked files of the tree (``git archive``), the built interface (``frontend/dist``, so the
installed application needs no Node.js) and the package wheel (``wheel/``, so it needs no build tool). The installers
download one archive from the same release and refuse it unless its SHA-256 equals the one written into them here.

Prerequisites (release machine only): ``npm --prefix frontend ci && npm --prefix frontend run build`` done, and
``pip wheel`` available.   Usage: python scripts/release/build_release_assets.py [--out dist-release]
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EPOCH = 1700000000                      # fixed member timestamps: rebuilding the same tree gives the same archives


def version() -> str:
    m = re.search(r'__version__\s*=\s*"([^"]+)"', (ROOT / "src" / "move_openlab" / "__init__.py").read_text())
    if not m:
        raise SystemExit("no __version__ in src/move_openlab/__init__.py")
    return m.group(1)


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.decode()
    return sorted(f for f in out.split("\0") if f and (ROOT / f).is_file())


def members(wheel: Path) -> list[tuple[str, Path]]:
    dist = ROOT / "frontend" / "dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("frontend/dist is missing: run  npm --prefix frontend ci && npm --prefix frontend run build")
    files = [(f, ROOT / f) for f in tracked_files()]
    files += [(p.relative_to(ROOT).as_posix(), p) for p in sorted(dist.rglob("*")) if p.is_file()]
    files.append((f"wheel/{wheel.name}", wheel))
    return sorted(set(files))


def build_wheel(tmp: Path) -> Path:
    subprocess.run([sys.executable, "-m", "pip", "wheel", "--no-deps", "--disable-pip-version-check", "-q", "-w", str(tmp), str(ROOT)],
                   check=True)
    whl = sorted(tmp.glob("move_openlab-*.whl"))
    if len(whl) != 1:
        raise SystemExit(f"expected one wheel, found {whl}")
    return whl[0]


def write_tar_gz(path: Path, prefix: str, files: list[tuple[str, Path]]) -> None:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as t:
        for name, src in files:
            info = tarfile.TarInfo(f"{prefix}/{name}")
            data = src.read_bytes()
            info.size, info.mtime, info.uid, info.gid, info.uname, info.gname = len(data), EPOCH, 0, 0, "", ""
            info.mode = 0o755 if name.endswith((".sh",)) or name == "start-local.sh" else 0o644
            t.addfile(info, io.BytesIO(data))
    with open(path, "wb") as fh, gzip.GzipFile(fileobj=fh, mode="wb", mtime=0, filename="") as g:
        g.write(raw.getvalue())


def write_zip(path: Path, prefix: str, files: list[tuple[str, Path]]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, src in files:
            z.writestr(zipfile.ZipInfo(f"{prefix}/{name}", date_time=(2023, 11, 14, 22, 13, 20)), src.read_bytes())


def render(template: Path, out: Path, values: dict[str, str]) -> None:
    text = template.read_text()
    for k, v in values.items():
        text = text.replace(f"@{k}@", v)
    if re.search(r"@[A-Z_]+@", text):
        raise SystemExit(f"unfilled placeholder in {template.name}")
    out.write_bytes(text.encode().replace(b"\r\n", b"\n") if out.suffix == ".sh" else text.replace("\r\n", "\n").replace("\n", "\r\n").encode())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="dist-release")
    args = ap.parse_args()
    v, out = version(), (ROOT / args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        whl = build_wheel(Path(tmp))
        files = members(whl)
        prefix = f"move-openlab-{v}"
        tgz, zp = out / f"{prefix}.tar.gz", out / f"{prefix}.zip"
        write_tar_gz(tgz, prefix, files)
        write_zip(zp, prefix, files)
    values = dict(VERSION=v, ARCHIVE_SHA256=sha256(tgz))
    render(ROOT / "scripts" / "install" / "install.sh", out / "install.sh", values)
    render(ROOT / "scripts" / "install" / "install.ps1", out / "install.ps1", dict(VERSION=v, ARCHIVE_SHA256=sha256(zp)))
    import os
    env = dict(os.environ, PYTHONPATH=str(ROOT / "src") + os.pathsep + os.environ.get("PYTHONPATH", ""))
    subprocess.run([sys.executable, str(ROOT / "scripts" / "pack_examples.py")], check=True, cwd=ROOT, env=env)
    for f in ("sample_scenario.zip", "sample_experiment.zip"):
        shutil.copy2(ROOT / "examples" / f, out / f)
    names = [tgz.name, zp.name, "install.sh", "install.ps1", "sample_scenario.zip", "sample_experiment.zip"]
    (out / "SHA256SUMS").write_text("".join(f"{sha256(out / n)}  {n}\n" for n in names))
    for n in names:
        print(f"{sha256(out / n)}  {(out / n).stat().st_size:>10}  {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
