"""Reproduce the public synthetic capacitated-assignment benchmark from scratch, through the platform's own pipeline.

This is the methodological benchmark shipped with the framework (``move_openlab.benchmarks.synthetic_assignment``):
a fully synthetic problem whose instances are generated from frozen seeds, solved by the built-in exact MILP (HiGHS)
and greedy methods and by the example plug-in ``plugins/regret_greedy`` (in the verified sandbox), every solution
re-checked by the problem's independent validator, and every exact result checked against an independent
lexicographic min-cost-flow oracle. It is NOT the separate synthetic scientific benchmark, which stays *Planned*.

Everything runs in a temporary installation (nothing of yours is read or written). Output: a JSON record (environment,
versions, configuration, per-instance results, checks) and a Markdown summary, both labelled with this run's own
measurements.

    python scripts/benchmark_synthetic_assignment.py --out bench/         # 3 sizes × 10 seeds, 5 repetitions
    python scripts/benchmark_synthetic_assignment.py --out bench/ --sizes small --seeds 1 2 3 --repetitions 2
"""
from __future__ import annotations

import argparse
import collections
import importlib.metadata as md
import json
import platform
import sys
import tempfile
import time
from pathlib import Path

import move_openlab
from move_openlab import registry
from move_openlab.benchmarks.synthetic_assignment import generator, oracle
from move_openlab.store import Installation, Workspace

PROBLEM = "synthetic-capacitated-bipartite-assignment"
METHODS = [("exact-milp-highs", "1.0.0"), ("greedy-min-cost", "1.0.0")]
PLUGIN = ("regret_greedy", "regret-greedy", "1.0.0")
LABEL = ("Public synthetic capacitated-assignment benchmark (methodological example shipped with MOVE OpenLab); "
         "figures measured by this run. Not the planned synthetic scientific benchmark.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--sizes", nargs="+", default=list(generator.SIZES))
    ap.add_argument("--seeds", nargs="+", type=int, default=list(generator.SEEDS))
    ap.add_argument("--repetitions", type=int, default=5)
    ap.add_argument("--no-plugin", action="store_true", help="built-in methods only (no sandbox needed)")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    ROOT_REPO = Path(move_openlab.__file__).resolve().parents[2]
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="move-openlab-bench-") as tmp:
        inst = Installation(Path(tmp) / "data", None if a.no_plugin else ROOT_REPO / "plugins", "bench",
                            plugin_mode="disabled" if a.no_plugin else "sandbox")
        w = Workspace(inst, "benchmark", "Benchmark")
        problem = registry.get(PROBLEM)
        methods = list(METHODS)
        if not a.no_plugin:
            w.register_plugin(problem, PLUGIN[0])                       # sandboxed self-test; refused without a sandbox
            methods.append(PLUGIN[1:])
        c = w.create_campaign(PROBLEM, "public synthetic assignment benchmark", dict(sizes=a.sizes, seeds=a.seeds),
                              methods, repetitions=a.repetitions)
        w.execute(c["campaign_id"])
        c = w.lock(c["campaign_id"])
        insts = {h: w.inst.get_instance(h) for h in c["scenario_set"]["instance_hashes"]}
        runs = c["runs"]
    per: dict = collections.defaultdict(dict)
    checks = dict(runs=len(runs), accepted=sum(r["accepted"] for r in runs), exact_equals_oracle=0, exact_runs=0,
                  repetitions_identical=0, cells=0)
    for h, i in insts.items():
        opt = oracle.lex_optimum(i)
        for mid, _ in methods:
            rs = [r for r in runs if r["instance_hash"] == h and r["method_id"] == mid]
            vals = {(r["validation"]["metrics"]["served"], r["validation"]["metrics"]["cost"]) for r in rs}
            checks["cells"] += 1
            checks["repetitions_identical"] += len(vals) == 1
            served, cost = sorted(vals)[0]
            per[i["instance_id"]][mid] = dict(served=served, cost=cost, feasible=all(r["accepted"] for r in rs),
                                              status=sorted({r.get("status_declared") for r in rs}),
                                              median_total_time_s=sorted(r["total_time_s"] for r in rs)[len(rs) // 2])
            if mid == METHODS[0][0]:
                checks["exact_runs"] += len(rs)
                checks["exact_equals_oracle"] += sum((r["validation"]["metrics"]["served"], r["validation"]["metrics"]["cost"]) == opt for r in rs)
        per[i["instance_id"]]["oracle"] = dict(served=opt[0], cost=opt[1])
    key = lambda x: (-x["served"], x["cost"])                               # noqa: E731  lexicographic: service, then cost
    summary = {mid: dict(served=sum(v[mid]["served"] for v in per.values()), cost=sum(v[mid]["cost"] for v in per.values()),
                         lex_optimal=sum(key(v[mid]) == key(v["oracle"]) for v in per.values())) for mid, _ in methods}
    pairwise = {}
    if not a.no_plugin:
        pairwise["regret-greedy vs greedy-min-cost"] = dict(collections.Counter(
            "better" if key(v["regret-greedy"]) < key(v["greedy-min-cost"]) else "equal"
            if key(v["regret-greedy"]) == key(v["greedy-min-cost"]) else "worse" for v in per.values()))
    vers = {}
    for pkg in ("highspy", "fastapi"):
        try:
            vers[pkg] = md.version(pkg)
        except md.PackageNotFoundError:
            vers[pkg] = None
    rec = dict(label=LABEL, command=" ".join(sys.argv), started=time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t0)),
               elapsed_s=round(time.time() - t0, 1), framework=move_openlab.__version__, python=platform.python_version(),
               os=f"{platform.system()} {platform.release()}", versions=vers, problem=PROBLEM, sizes=a.sizes, seeds=a.seeds,
               repetitions=a.repetitions, methods=[f"{m}@{v}" for m, v in methods], campaign_checksum=c.get("checksum"),
               checks=checks, summary=summary, pairwise=pairwise, per_instance=dict(sorted(per.items())))
    (a.out / "synthetic_assignment_benchmark.json").write_text(json.dumps(rec, indent=1))
    lines = [f"# {LABEL}", "", f"`{rec['command']}` — {rec['started']}, {rec['elapsed_s']} s, MOVE OpenLab {rec['framework']}, "
             f"Python {rec['python']}, HiGHS (highspy) {vers['highspy']}, {rec['os']}", "",
             f"{len(per)} instances ({', '.join(a.sizes)}; seeds {a.seeds[0]}–{a.seeds[-1]}), {a.repetitions} repetitions, "
             f"{checks['runs']} runs: {checks['accepted']} accepted by the independent validator; exact = oracle optimum in "
             f"{checks['exact_equals_oracle']}/{checks['exact_runs']} runs; identical results across repetitions in "
             f"{checks['repetitions_identical']}/{checks['cells']} cells.", "",
             "| Method | Served (sum) | Cost (sum) | Lexicographically optimal instances |", "|---|---:|---:|---:|"]
    lines += [f"| {m} | {s['served']} | {s['cost']} | {s['lex_optimal']}/{len(per)} |" for m, s in summary.items()]
    for k, v in pairwise.items():
        lines += ["", f"{k}: {v.get('better', 0)} better, {v.get('equal', 0)} equal, {v.get('worse', 0)} worse (per instance)."]
    (a.out / "synthetic_assignment_benchmark.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    ok = checks["accepted"] == checks["runs"] and checks["exact_equals_oracle"] == checks["exact_runs"]
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
