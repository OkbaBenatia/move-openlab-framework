"""Owner-only files for secrets and personal data: the credential store, the audit log, development credentials.

Such files are created with mode 0600 from the start — never briefly readable by other users, whatever the process
umask — and an existing file whose mode is wider is tightened (only the group and other bits are removed; the content
is never touched). SQLite creates its journal and WAL files with the database file's permissions, so a 0600 database
keeps its side files private too.

Windows has no POSIX permission bits: there the data directory lives in the user's own profile
(``%LOCALAPPDATA%``), whose access-control list already limits it to that account (and administrators); the
functions below then create and write files the same way and leave permissions to that inherited ACL.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

PRIVATE = 0o600
PRIVATE_UMASK = 0o077          # files and directories created by the server: owner only (0600 / 0700)
POSIX = os.name == "posix"


def _fd_private(fd: int) -> None:
    if POSIX:
        os.fchmod(fd, PRIVATE)                       # exact mode, independent of the umask


def tighten(path: str | os.PathLike) -> bool:
    """Remove group and other permissions from an existing file. True when the mode changed."""
    if not POSIX:
        return False
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
        _fd_private(fd)
    finally:
        os.close(fd)
    return p


def append(path: str | os.PathLike, text: str) -> None:
    """Append to an owner-only file, creating it with mode 0600 (an existing wider file is tightened first)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, PRIVATE)
    try:
        if POSIX and stat.S_IMODE(os.fstat(fd).st_mode) != PRIVATE:
            _fd_private(fd)
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
        _fd_private(fd)
        os.write(fd, data.encode() if isinstance(data, str) else data)
    finally:
        os.close(fd)
    os.replace(tmp, p)


def secure_tree(root: str | os.PathLike) -> int:
    """Remove group and other permissions from a data directory and everything below it; return how many changed.

    Symbolic links are never followed or changed; owner bits (including executable bits) are kept as they are.
    """
    changed = 0
    if not POSIX:
        return 0
    root = os.fspath(root)
    if not os.path.isdir(root) or os.path.islink(root):
        return 0
    for top, dirs, files in os.walk(root, followlinks=False):
        for name in [None, *dirs, *files]:
            path = top if name is None else os.path.join(top, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                continue
            if stat.S_IMODE(st.st_mode) & 0o077 and _tighten_nofollow(path, st):
                changed += 1
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(top, d))]
    return changed


def _tighten_nofollow(path: str, seen: os.stat_result) -> bool:
    """Tighten through a descriptor opened without following links, only if it is still the entry seen by lstat.

    An entry replaced by a symbolic link in the meantime, or one that cannot be opened (owned by another user, no
    read permission), is skipped: startup never fails and never changes anything outside the data directory.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return False
    try:
        st = os.fstat(fd)
        if (st.st_dev, st.st_ino) != (seen.st_dev, seen.st_ino):
            return False
        mode = stat.S_IMODE(st.st_mode)
        if not mode & 0o077:
            return False
        os.fchmod(fd, mode & ~0o077)
        return True
    except OSError:
        return False
    finally:
        os.close(fd)
