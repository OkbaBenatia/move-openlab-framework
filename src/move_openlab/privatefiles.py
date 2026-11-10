"""Owner-only files for secrets and personal data: the credential store, the audit log, development credentials.

Such files are created with mode 0600 from the start — never briefly readable by other users, whatever the process
umask — and an existing file whose mode is wider is tightened (only the group and other bits are removed; the content
is never touched). SQLite creates its journal and WAL files with the database file's permissions, so a 0600 database
keeps its side files private too.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

PRIVATE = 0o600


def tighten(path: str | os.PathLike) -> bool:
    """Remove group and other permissions from an existing file. True when the mode changed."""
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except FileNotFoundError:
        return False
    if not mode & 0o077:
        return False
    os.chmod(path, mode & ~0o077)
    return True


def ensure(path: str | os.PathLike) -> Path:
    """Create an empty owner-only file if it does not exist; tighten it if it does."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, PRIVATE)
    except FileExistsError:
        tighten(p)
        return p
    try:
        os.fchmod(fd, PRIVATE)                       # exact mode, independent of the umask
    finally:
        os.close(fd)
    return p


def append(path: str | os.PathLike, text: str) -> None:
    """Append to an owner-only file, creating it with mode 0600 (an existing wider file is tightened first)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, PRIVATE)
    try:
        if stat.S_IMODE(os.fstat(fd).st_mode) != PRIVATE:
            os.fchmod(fd, PRIVATE)
        os.write(fd, text.encode())
    finally:
        os.close(fd)


def write(path: str | os.PathLike, data: str | bytes) -> None:
    """Replace an owner-only file atomically: the new content is written to a 0600 temporary file, then renamed."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.tmp{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, PRIVATE)
    try:
        os.fchmod(fd, PRIVATE)
        os.write(fd, data.encode() if isinstance(data, str) else data)
    finally:
        os.close(fd)
    os.replace(tmp, p)
