"""Researcher-defined method plugins and their trust boundary.

A plugin is a directory ``<name>/plugin.py`` defining a literal ``METADATA`` dict and a ``solve(instance, config)``
function. It lives in one of two places:

* the operator-approved directory ``<approved plugin dir>/<name>/plugin.py`` (``MOVE_OPENLAB_PLUGIN_DIR``), shared by
  every account of the installation; the examples shipped with the framework are listed in ``catalog.json`` of that
  directory (``{"examples": [<directory names>]}``; a plug-in may also say ``"catalog": "example"`` in METADATA) — a
  presentation file, outside every plug-in's code, so marking an example never changes its code hash;
* the uploader's own workspace ``<data>/workspaces/<user>/plugins/<name>@<version>/plugin.py`` — created only by an
  upload of a completed plug-in (:func:`inspect_archive`), owner-only, never in the approved directory and never
  visible to another account.

Trust model (see docs/SECURITY_MODEL.md):

1. **Off by default.** Plugins exist only when the operator configures both an approved directory
   (``MOVE_OPENLAB_PLUGIN_DIR``) and a mode (``MOVE_OPENLAB_PLUGIN_MODE``, see :mod:`move_openlab.sandbox`). Only that
   directory and the signed-in account's own upload directory are searched.
2. **Uploads only into the uploader's workspace, only in sandbox mode.** An upload is a ZIP checked before anything
   is stored (size, member count, uncompressed size, no absolute path, ``..``, backslash, symbolic link, special file
   or nested archive; exactly one plug-in directory; only ``plugin.py`` and small text files). It never writes into
   the approved directory, is refused in ``trusted-process`` mode, and an uploaded plug-in is never executed outside
   the verified sandbox. Bundles never create plugins.
3. **No execution to list, check or upload.** Metadata is read statically (``ast.literal_eval``); listing,
   compatibility checks, uploads and bundle verification never import a plugin.
4. **Pinned code.** Registration records the SHA-256 of the plugin file (and, for an upload, of the uploaded ZIP).
   Before every run the file is hashed again; the worker executes exactly the bytes whose hash it verified (no
   re-read between check and execution); a modified file is refused.
5. **Sandboxed execution.** In ``sandbox`` mode every run happens in a bubblewrap sandbox whose isolation is verified
   before use (no network, private PID namespace, cleared environment, read-only installation, no data directory —
   only the single plugin file is bound, read-only, at a fixed path); if it is unavailable or unverifiable, plugins
   are refused. ``trusted-process`` mode is not a sandbox and is reserved to administrators.
6. **Bundles never carry code.** Imported experiment bundles reference methods by id, version and code hash only.
"""
from __future__ import annotations

import ast
import hashlib
import json
import io
import re
import stat
import zipfile
import zlib
from pathlib import Path

from .methods import ContractError, check_metadata
from .problem import Problem

PLUGIN_FILE = "plugin.py"
MAX_PLUGIN_BYTES = 1_000_000

# ------------------------------------------------------------------ uploads of a completed plug-in (ZIP)
UPLOAD_RECORD = "upload.json"                 # written by the server next to an uploaded plug-in, never uploaded
MAX_UPLOAD_BYTES = 2_000_000                  # the ZIP itself
MAX_UPLOAD_MEMBERS = 16                       # entries in the ZIP, directories included
MAX_UPLOAD_UNCOMPRESSED = 3_000_000           # sum of the uncompressed sizes (zip-bomb guard)
MAX_TEXT_BYTES = 256_000                      # each accompanying text file
TEXT_FILES = ("test_plugin.py", "README.md", "README.txt", "README", "LICENSE", "LICENSE.txt", "LICENSE.md",
              "NOTICE", "AUTHORS", "CHANGELOG.md")
ARCHIVE_SUFFIXES = (".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".whl", ".egg", ".jar")
ARCHIVE_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"\x1f\x8b", b"BZh", b"\xfd7zXZ", b"7z\xbc\xaf", b"Rar!", b"(\xb5/\xfd")
NAME = re.compile(r"^[a-z][a-z0-9_]{2,40}$")  # the plug-in directory (same rule as ``move-openlab method new``)


class UploadRefused(ContractError):
    """An uploaded archive was refused before anything was stored; the message says why."""


def metadata_from_source(src: bytes, filename: str = PLUGIN_FILE) -> dict:
    """``METADATA`` of plugin source code, read statically: the code is NOT executed."""
    if len(src) > MAX_PLUGIN_BYTES:
        raise ContractError("plugin file too large")
    try:
        tree = ast.parse(src, filename=filename)
    except (SyntaxError, ValueError, RecursionError, MemoryError) as e:
        raise ContractError(f"plugin.py is not valid Python: {type(e).__name__}: {str(e)[:200]}") from None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "METADATA" for t in node.targets):
            try:
                meta = ast.literal_eval(node.value)
            except (ValueError, TypeError, SyntaxError, RecursionError, MemoryError):
                raise ContractError("METADATA must be a plain literal (no names, calls or expressions)") from None
            if not isinstance(meta, dict):
                raise ContractError("METADATA must be a dict literal")
            return meta
    raise ContractError("plugin defines no literal METADATA")


def read_plugin_metadata(path: Path) -> dict:
    """``METADATA`` of a plugin file, read statically: the plugin is NOT executed."""
    if Path(path).stat().st_size > MAX_PLUGIN_BYTES:
        raise ContractError("plugin file too large")
    return metadata_from_source(Path(path).read_bytes(), str(path))


def plugin_path(plugin_dir: Path | None, plugin: str) -> Path:
    """Resolved path of a plugin under ``plugin_dir`` (the approved directory, or an account's upload directory);
    refuses anything outside it (``..``, separators, hidden names, symbolic links leading elsewhere)."""
    if plugin_dir is None:
        raise ContractError("no approved plugin directory is configured on this installation")
    root = Path(plugin_dir).resolve()
    if not plugin or "/" in plugin or "\\" in plugin or plugin.startswith(".") or "\0" in plugin:
        raise FileNotFoundError("plugin not found in the approved plugin directory")
    f = (root / plugin / PLUGIN_FILE).resolve()
    if root not in f.parents or not f.is_file():
        raise FileNotFoundError("plugin not found in the approved plugin directory")
    return f


def code_sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


CATALOG_FILE = "catalog.json"


def catalog_of(meta: dict | None, plugin_dir: Path | None = None, name: str | None = None) -> str | None:
    """How a plug-in presents itself in the catalogue (``"example"`` for the shipped examples), or None: its METADATA
    ``catalog`` key, else the approved directory's ``catalog.json`` (read as data; an unreadable file marks nothing)."""
    c = (meta or {}).get("catalog")
    if isinstance(c, str):
        return c
    if plugin_dir is not None and name:
        try:
            doc = json.loads((Path(plugin_dir) / CATALOG_FILE).read_text())
        except (OSError, ValueError):
            return None
        ex = doc.get("examples") if isinstance(doc, dict) else None
        if isinstance(ex, list) and name in ex:
            return "example"
    return None


def discover(plugin_dir: Path | None, problem: Problem | None = None) -> list[dict]:
    """Plugins under ``plugin_dir`` with their static metadata and compatibility (nothing is executed)."""
    if plugin_dir is None or not Path(plugin_dir).is_dir():
        return []
    root = Path(plugin_dir).resolve()
    out = []
    for f in sorted(root.glob(f"*/{PLUGIN_FILE}")):
        try:
            f = plugin_path(root, f.parent.name)
        except FileNotFoundError:
            continue
        item = dict(plugin=f.parent.name, code_sha256=code_sha256(f))
        try:
            meta = read_plugin_metadata(f)
            item["metadata"] = meta
            if problem is not None:
                check_metadata(meta, problem)
            item["compatible"] = True
        except (ContractError, SyntaxError, ValueError) as e:
            item["compatible"], item["incompatibility"] = False, str(e)
        out.append(item)
    return out


def _refuse(reason: str):
    raise UploadRefused(reason)


def inspect_archive(data: bytes) -> tuple[str, dict[str, bytes]]:
    """The plug-in directory name and its files, from the bytes of an uploaded ZIP. Everything is checked in memory
    before anything is written: nothing is extracted to disk and no code is executed. Raises :class:`UploadRefused`
    with the reason."""
    if len(data) > MAX_UPLOAD_BYTES:
        _refuse(f"the ZIP is larger than {MAX_UPLOAD_BYTES // 1_000_000} MB")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        infos = zf.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError, EOFError):
        _refuse("not a readable ZIP archive")
    if not infos:
        _refuse("the ZIP is empty")
    if len(infos) > MAX_UPLOAD_MEMBERS:
        _refuse(f"the ZIP has {len(infos)} entries; at most {MAX_UPLOAD_MEMBERS} are allowed")
    if sum(i.file_size for i in infos) > MAX_UPLOAD_UNCOMPRESSED:
        _refuse(f"the files would take more than {MAX_UPLOAD_UNCOMPRESSED // 1_000_000} MB once uncompressed")
    allowed = ", ".join((PLUGIN_FILE,) + TEXT_FILES)
    seen, dirs, files, total = set(), set(), {}, 0
    for i in infos:
        n = i.filename
        if "\\" in n:
            _refuse(f"backslash in a path is not allowed: {n!r}")
        if n.startswith("/") or re.match(r"^[A-Za-z]:", n) or "\0" in n:
            _refuse(f"absolute paths are not allowed: {n!r}")
        parts = n[:-1].split("/") if n.endswith("/") else n.split("/")
        if any(p in ("", ".", "..") for p in parts):
            _refuse(f"'..', '.' and empty path components are not allowed: {n!r}")
        if n in seen:
            _refuse(f"duplicate entry {n!r}")
        seen.add(n)
        if i.flag_bits & 0x1:
            _refuse(f"encrypted entries are not allowed: {n!r}")
        mode = i.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if stat.S_ISLNK(mode):
            _refuse(f"symbolic links are not allowed: {n!r}")
        if kind and kind not in (stat.S_IFREG, stat.S_IFDIR):
            _refuse(f"special files are not allowed: {n!r}")
        dirs.add(parts[0])
        if i.is_dir() or kind == stat.S_IFDIR:
            if len(parts) > 1:
                _refuse(f"sub-directories are not allowed: {n!r}")
            continue
        if len(parts) == 1:
            _refuse(f"files must be inside one plug-in directory (<name>/{PLUGIN_FILE}); found {n!r} at the top level")
        if len(parts) > 2:
            _refuse(f"sub-directories are not allowed: {n!r} (remove __pycache__ and other folders)")
        fname = parts[1]
        if fname.lower().endswith(ARCHIVE_SUFFIXES):
            _refuse(f"nested archives are not allowed: {n!r}")
        if fname != PLUGIN_FILE and fname not in TEXT_FILES:
            _refuse(f"only {allowed} are allowed in the plug-in directory; found {n!r}")
        limit = MAX_PLUGIN_BYTES if fname == PLUGIN_FILE else MAX_TEXT_BYTES
        if i.file_size > limit:
            _refuse(f"{n!r} is larger than {limit:,} bytes")
        try:
            with zf.open(i) as fh:
                body = fh.read(limit + 1)                     # the real bytes, not the size the header claims
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError, EOFError, zlib.error):
            _refuse(f"{n!r} cannot be read (corrupted, or an unsupported compression)")
        total += len(body)
        if len(body) > limit or total > MAX_UPLOAD_UNCOMPRESSED:
            _refuse(f"{n!r} expands beyond the allowed size (zip bomb guard)")
        if body.startswith(ARCHIVE_MAGIC):
            _refuse(f"nested archives are not allowed: {n!r}")
        if b"\0" in body:
            _refuse(f"{n!r} is not a text file")
        try:
            body.decode("utf-8")
        except UnicodeDecodeError:
            _refuse(f"{n!r} is not UTF-8 text")
        files[fname] = body
    if len(dirs) != 1:
        _refuse(f"exactly one plug-in directory is expected; found {len(dirs)}: {', '.join(sorted(dirs))[:200]}")
    name = next(iter(dirs))
    if not NAME.match(name):
        _refuse(f"plug-in directory {name!r}: 3-41 characters, lowercase letters, digits and '_', starting with a letter")
    if PLUGIN_FILE not in files:
        _refuse(f"no {name}/{PLUGIN_FILE} in the ZIP")
    return name, files
