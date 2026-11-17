"""Messages that reach users without the server's file-system layout.

Error texts written by the operating system, the Python interpreter, the sandbox tool or a method's worker process
(``[Errno 13] Permission denied: '/home/…/plugin.py'``, ``File "/opt/…/site-packages/…"`` in a timeout dump,
bubblewrap's stderr) name absolute paths of the installation. :func:`paths` keeps such a message useful — the
file name and the reason stay — but replaces the directories: the Python installation, the application package, the
user's home and the temporary directory by placeholders, and any other absolute path by ``<path>/<file name>``. The
full text is written to the server log (for the operator), never to a response or an exported record.
"""
from __future__ import annotations

import logging
import os
import re
import sys
import tempfile
from pathlib import Path

log = logging.getLogger("move_openlab")

_POSIX_ABS = re.compile(r"(?<![\w.:/-])/(?:[^\s'\"<>:/]+/)+([^\s'\"<>:/]*)")
_WIN_ABS = re.compile(r"(?i)(?<![\w])[a-z]:\\(?:[^\s'\"<>\\]+\\)+([^\s'\"<>\\]*)")


def _known() -> list[tuple[str, str]]:
    import move_openlab
    pairs = [(str(Path(move_openlab.__file__).resolve().parent), "<move_openlab>"), (sys.prefix, "<python>"),
             (sys.base_prefix, "<python>"), (tempfile.gettempdir(), "<tmp>"), (str(Path.home()), "<home>")]
    out = []
    for p, label in pairs:
        for v in {p, os.path.realpath(p)}:
            if v and len(v) > 3:
                out.append((v, label))
    return sorted(out, key=lambda x: -len(x[0]))                 # longest first: a venv inside home before home


def paths(text: str) -> str:
    """``text`` with every absolute path reduced to a placeholder or to its file name."""
    if not text:
        return text
    for p, label in _known():
        text = text.replace(p, label)
    text = _POSIX_ABS.sub(lambda m: "<path>/" + m.group(1), text)
    return _WIN_ABS.sub(lambda m: "<path>\\" + m.group(1), text)


def exception(e: BaseException, context: str = "") -> str:
    """A user-facing message for an unexpected exception: the operating-system errors by their type only (their
    text names files), anything else path-free. The full exception goes to the server log."""
    log.warning("%s%s: %s", f"{context}: " if context else "", type(e).__name__, e)
    if isinstance(e, OSError):
        return f"{type(e).__name__} (details in the server log)"
    return paths(str(e))
