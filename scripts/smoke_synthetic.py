#!/usr/bin/env python3
"""Smoke test of the synthetic assignment benchmark: the complete cross-researcher workflow on the full default
scenario set (3 sizes x 10 seeds), in two isolated temporary installations.

baseline (exact + greedy) -> lock -> export -> import elsewhere -> independent re-execution -> reproducibility check
-> register the example plugin (verified bubblewrap sandbox) -> extension -> compare -> variant + semantic check -> threshold study.
Every exact result is also certified against the independent min-cost-flow oracle. Prints a JSON summary.
Usage: python scripts/smoke_synthetic.py [--repetitions N] [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import time
from pathlib import Path

from move_openlab import registry
from move_openlab.analysis.compare import compare
from move_openlab.analysis.reproducibility import reproducibility
from move_openlab.analysis.semantic import semantic_compare
from move_openlab.analysis.threshold import threshold_report
from move_openlab.benchmarks.synthetic_assignment import oracle
from move_openlab.store import Installation

ROOT = Path(__file__).resolve().parents[1]
PID = "synthetic-capacitated-bipartite-assignment"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repetitions", type=int, default=3)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    problem = registry.get(PID)
    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="move-openlab-smoke-") as tmp:
        tmp = Path(tmp)
        plugins = tmp / "plugins"
        shutil.copytree(ROOT / "plugins" / "regret_greedy", plugins / "regret_greedy")
        r1 = Installation(tmp / "A", plugins, "inst-A", plugin_mode="sandbox").workspace("researcher1", "Researcher 1")
        r2 = Installation(tmp / "B", plugins, "inst-B", plugin_mode="sandbox").workspace("researcher2", "Researcher 2")
        base = r1.create_campaign(PID, "Synthetic baseline", {}, [("exact-milp-highs", "1.0.0"), ("greedy-min-cost", "1.0.0")],
                                  repetitions=a.repetitions)
        r1.execute(base["campaign_id"]); base = r1.lock(base["campaign_id"])
        oracle_ok = all((r["validation"]["metrics"]["served"], r["validation"]["metrics"]["cost"])
                        == oracle.lex_optimum(r1.inst.get_instance(r["instance_hash"]))
                        for r in base["runs"] if r["method_id"] == "exact-milp-highs")
        data, info = r1.export_bundle(base["campaign_id"])
        imp = r2.import_bundle(data)
        repro = r2.create_reproduction(base["campaign_id"]); r2.execute(repro["campaign_id"]); r2.lock(repro["campaign_id"])
        rr = reproducibility(r2, repro["campaign_id"])
        reg = r2.register_plugin(problem, "regret_greedy")
        ext = r2.create_extension(repro["campaign_id"], [("regret-greedy", "1.0.0")])
        r2.execute(ext["campaign_id"]); r2.lock(ext["campaign_id"])
        cmp = compare(r2, ext["campaign_id"])
        var = r2.create_variant(base["campaign_id"], "capacity-nonbinding"); r2.execute(var["campaign_id"])
        sem = semantic_compare(r2, base["campaign_id"], var["campaign_id"])
        thr = r2.create_threshold_study(base["campaign_id"], ("exact-milp-highs", "1.0.0"), "relative-cost", [0.5, 0.75, 1.0])
        r2.execute(thr["campaign_id"])
        tr = threshold_report(r2, thr["campaign_id"])
        summary = dict(
            scenarios=len(base["scenario_set"]["instance_hashes"]), repetitions=a.repetitions, runs_baseline=len(base["runs"]),
            baseline_all_accepted=all(r["accepted"] for r in base["runs"]), exact_certified_by_oracle=oracle_ok,
            bundle=dict(bytes=info["bytes"], files_checked=imp["files_checked"], executable_code=imp["executable_code_in_bundle"]),
            reproduction=dict(cells=rr["cells"], agreement=rr["agreement"], reproduced=rr["numerically_reproduced"]),
            plugin_selftest=reg["selftest"]["accepted"], plugin_isolation=reg["isolation_at_registration"],
            plugin_runs_sandboxed=all(r["isolation"] == "sandbox" for r in r2.get(ext["campaign_id"])["runs"]
                                      if r["source"] == "plugin"),
            comparison=[dict(method=r["method_id"], origin=r["campaign_kind"], valid=r["all_feasible"], served=r["totals"]["served"],
                             cost=r["totals"]["cost"], optimal=f"{r['optimal']}/{r['scenarios']}",
                             gap_mean_pct=r["final_level_gap_pct"]["mean"], mean_rank=r["mean_rank"],
                             reproduction=r["reproduction_status"]) for r in cmp["rows"]],
            comparison_warnings=cmp["warnings"],
            semantic_nonbinding_variant=sem["summary"],
            threshold=[dict(t=s["threshold"], kept=s["mean_kept_share"], equal=f"{s['equal_objective']}/{s['cells']}",
                            feasible=f"{s['feasible_on_original']}/{s['cells']}", recall=s["mean_reference_recall"])
                       for s in tr["summary"]],
            wall_time_s=round(time.perf_counter() - t0, 1))
    out = json.dumps(summary, indent=1)
    print(out)
    if a.out:
        a.out.write_text(out)
    ok = (summary["baseline_all_accepted"] and oracle_ok and summary["reproduction"]["reproduced"] and summary["plugin_selftest"]
          and summary["plugin_runs_sandboxed"]
          and all(r["valid"] for r in summary["comparison"]))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
