import os
import shutil
from pathlib import Path

import pytest

from move_openlab import registry, sandbox
from move_openlab.plugins import code_sha256
from move_openlab.store import Installation

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PROBLEM_ID = "synthetic-capacitated-bipartite-assignment"
A_B = [("exact-milp-highs", "1.0.0"), ("greedy-min-cost", "1.0.0")]
SMALL = dict(sizes=["small", "medium"], seeds=[1, 2])


@pytest.fixture
def problem():
    return registry.get(PROBLEM_ID)


@pytest.fixture
def plugin_dir(tmp_path):
    """Approved plugin directory for a test: the example plugin plus the negative-test fixtures."""
    d = tmp_path / "plugins"
    shutil.copytree(ROOT / "plugins" / "regret_greedy", d / "regret_greedy")
    for f in (HERE / "fixtures" / "plugins").iterdir():
        shutil.copytree(f, d / f.name)
    return d


def sandbox_or_skip(tmp_path):
    """Plugin tests run in the verified sandbox. Where bubblewrap cannot provide it they are skipped — unless
    MOVE_OPENLAB_REQUIRE_SANDBOX=1 (CI), where an unavailable sandbox is a failure."""
    try:
        sandbox.verify(sandbox.SandboxSpec.of(tmp_path / "probe-protected"))
    except sandbox.SandboxUnavailable as e:
        if os.environ.get("MOVE_OPENLAB_REQUIRE_SANDBOX") == "1":
            pytest.fail(f"sandbox required but unavailable: {e}")
        pytest.skip(f"sandbox unavailable: {e}")


@pytest.fixture
def installations(tmp_path, plugin_dir):
    sandbox_or_skip(tmp_path)
    return (Installation(tmp_path / "instA", plugin_dir, "inst-A", plugin_mode="sandbox"),
            Installation(tmp_path / "instB", plugin_dir, "inst-B", plugin_mode="sandbox"))


def plugin_ref(inst, plugin: str, method_id: str, isolation: str = "sandbox", sha: str | None = None) -> dict:
    f = inst.plugin_dir / plugin / "plugin.py"
    return dict(source="plugin", method_id=method_id, version="1.0.0", plugin_file=str(f),
                code_sha256=sha or code_sha256(f), isolation=isolation)


def baseline(w, reps=2):
    c = w.create_campaign(PROBLEM_ID, "test baseline", SMALL, A_B, repetitions=reps)
    w.execute(c["campaign_id"])
    return w.lock(c["campaign_id"])
