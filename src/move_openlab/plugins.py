"""Researcher-defined method plugins and their trust boundary.

A plugin is a directory ``<approved plugin dir>/<name>/plugin.py`` defining a literal ``METADATA`` dict and a
``solve(instance, config)`` function. Trust model (see docs/SECURITY_MODEL.md):

1. **Off by default.** Plugins exist only when the operator configures both an approved directory
   (``MOVE_OPENLAB_PLUGIN_DIR``) and a mode (``MOVE_OPENLAB_PLUGIN_MODE``, see :mod:`move_openlab.sandbox`). Only that
   directory is searched. Uploads and bundles never create plugins.
2. **No execution to list or check.** Metadata is read statically (``ast.literal_eval``); listing, compatibility
   checks and bundle verification never import a plugin.
3. **Pinned code.** Registration records the SHA-256 of the plugin file. The worker executes exactly the bytes whose
   hash it verified (no re-read between check and execution); a modified file is refused.
4. **Sandboxed execution.** In ``sandbox`` mode every run happens in a bubblewrap sandbox whose isolation is verified
   before use (no network, private PID namespace, cleared environment, read-only installation, no data directory);
   if it is unavailable or unverifiable, plugins are refused. ``trusted-process`` mode is not a sandbox and is
   reserved to administrators.
5. **Bundles never carry code.** Imported experiment bundles reference methods by id, version and code hash only.
"""
from __future__ import annotations

import ast
import hashlib
from pathlib import Path

from .methods import ContractError, check_metadata
from .problem import Problem

PLUGIN_FILE = "plugin.py"
MAX_PLUGIN_BYTES = 1_000_000


def read_plugin_metadata(path: Path) -> dict:
    """``METADATA`` of a plugin file, read statically: the plugin is NOT executed."""
    src = path.read_bytes()
    if len(src) > MAX_PLUGIN_BYTES:
        raise ContractError("plugin file too large")
    tree = ast.parse(src, filename=str(path))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "METADATA" for t in node.targets):
            meta = ast.literal_eval(node.value)
            if not isinstance(meta, dict):
                raise ContractError("METADATA must be a dict literal")
            return meta
    raise ContractError("plugin defines no literal METADATA")


def plugin_path(plugin_dir: Path | None, plugin: str) -> Path:
    """Resolved path of an approved plugin; refuses anything outside the approved directory (``..``, symlinks)."""
    if plugin_dir is None:
        raise ContractError("no approved plugin directory is configured on this installation")
    root = Path(plugin_dir).resolve()
    if not plugin or "/" in plugin or "\\" in plugin or plugin.startswith("."):
        raise FileNotFoundError("plugin not found in the approved plugin directory")
    f = (root / plugin / PLUGIN_FILE).resolve()
    if root not in f.parents or not f.is_file():
        raise FileNotFoundError("plugin not found in the approved plugin directory")
    return f


def code_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def discover(plugin_dir: Path | None, problem: Problem | None = None) -> list[dict]:
    """Plugins in the approved directory with their static metadata and compatibility (nothing is executed)."""
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
