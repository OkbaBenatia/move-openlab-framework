"""Controlled repetition and concurrency stress test of the exact ride-matching method (HiGHS) through the real
isolated runner — the procedure used to investigate an intermittent solver stall.

Inputs are deterministic: the three frozen scenarios of the shipped sample bundle (20 drivers, 30 riders each) and,
optionally, a scenario generated from a road network of a local data directory with a fixed seed. Every run goes
through ``run_once`` (separate worker process, worker limits, independent validation), at several concurrency levels.
The report (JSON) records the environment (Python, OS, CPU, HiGHS/highspy and SciPy versions), the solver
configuration, the worker limits, every run's status, solver / method / end-to-end time, worker CPU time and peak
memory, and every run slower than ``--slow`` seconds or not OPTIMAL with its diagnostics.

    python scripts/solver_stress.py --runs 100 --concurrency 1 4 20 --out solver-stress.json
    python scripts/solver_stress.py --network-data .openlab-data/dev --network <id> --seed 289326 ...
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import glob
import importlib.metadata as md
import json
import os
import platform
import statistics
import sys
import time
from pathlib import Path

import move_openlab
from move_openlab import registry, runner
from move_openlab.runner import run_once

EXACT = dict(source="builtin", method_id="exact-matching-highs", version="1.0.0")


def versions() -> dict:
    out = {}
    for pkg in ("highspy", "scipy", "numpy"):
        try:
            out[pkg] = md.version(pkg)
        except md.PackageNotFoundError:
            out[pkg] = None
    try:
        import highspy
        out["HiGHS"] = highspy.Highs().version()
    except ImportError:
        out["HiGHS"] = None
    return out


def environment() -> dict:
    return dict(python=platform.python_version(), implementation=platform.python_implementation(),
                os=platform.system(), os_release=platform.release(), machine=platform.machine(),
                cpu_count=os.cpu_count(), cpu_model=runner._cpu_model(), framework=move_openlab.__version__,
                load_average=os.getloadavg() if hasattr(os, "getloadavg") else None, **versions(),
                worker_env={k: v for k, v in runner._worker_env().items() if k != "PATH"},   # PATH is local, not recorded
                worker_memory_mb=runner.DEFAULT_MEMORY_MB)


def instances(args) -> list[dict]:
    root = Path(move_openlab.__file__).parent / "samples" / "montbeliard" / "instances"
    out = [json.loads(Path(f).read_text()) for f in sorted(glob.glob(str(root / "*.json")))]
    if args.network_data:
        from move_openlab.geo import scenarios as SC
        from move_openlab.geo.osm import NetworkStore
        st = NetworkStore(Path(args.network_data))
        net, prov = st.load(args.network), st.provenance(args.network)
        sc = SC.generate_synthetic(net, "stress", 20, 30, args.seed, 27000, 28800, dict(max_detour_s=1200, max_detour_ratio=1.0), 1500)
        out.append(SC.build_instance(SC.validate_scenario(sc), net, prov, "stress"))
    return out


def one(problem, inst, cfg, timeout_s) -> dict:
    t0 = time.perf_counter()
    r = run_once(problem, EXACT, inst, cfg, timeout_s=timeout_s)
    return dict(instance_hash=inst["instance_hash"][:12], pairs=len(inst["pairs"]), wall_s=round(time.perf_counter() - t0, 4),
                accepted=r["accepted"], status=r.get("status_declared"), error=r.get("error"),
                served=r["validation"]["metrics"].get("served"), solver_time_s=r.get("solver_time_s"),
                method_time_s=r.get("method_time_s"), total_time_s=r.get("total_time_s"), resources=r.get("resources"),
                diagnostics=r.get("diagnostics"))


def summary(rows: list[dict]) -> dict:
    def stats(key):
        v = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
        return dict(median=round(statistics.median(v), 4), p99=round(sorted(v)[int(0.99 * (len(v) - 1))], 4),
                    max=round(max(v), 4)) if v else None
    by = {}
    for r in rows:
        by[f"{r['accepted']}/{r['status']}"] = by.get(f"{r['accepted']}/{r['status']}", 0) + 1
    return dict(runs=len(rows), outcomes=by, solver_time_s=stats("solver_time_s"), method_time_s=stats("method_time_s"),
                total_time_s=stats("total_time_s"), wall_s=stats("wall_s"),
                served_per_instance={h: sorted({r["served"] for r in rows if r["instance_hash"] == h})
                                     for h in sorted({r["instance_hash"] for r in rows})})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--runs", type=int, default=100, help="runs per instance and concurrency level")
    ap.add_argument("--concurrency", type=int, nargs="+", default=[1, 4])
    ap.add_argument("--time-limit", type=float, default=60.0, help="HiGHS time limit (s), as in the method's default")
    ap.add_argument("--timeout", type=float, default=120.0, help="run timeout (s), as Save & Run uses")
    ap.add_argument("--slow", type=float, default=2.0, help="report runs slower than this (s)")
    ap.add_argument("--network-data"), ap.add_argument("--network"), ap.add_argument("--seed", type=int, default=289326)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    problem = registry.get("public-ride-matching")
    cfg = dict(time_limit_s=args.time_limit, threads=1, random_seed=0, mip_rel_gap=0.0, mip_abs_gap=0.0)
    insts = instances(args)
    report = dict(started=time.strftime("%Y-%m-%dT%H:%M:%S%z"), environment=environment(), solver_config=cfg,
                  run_timeout_s=args.timeout, worker_limits=dict(memory_mb=runner.DEFAULT_MEMORY_MB, cpu_s=int(args.timeout) + 5),
                  instances=[dict(instance_hash=i["instance_hash"], drivers=len(i["drivers"]), riders=len(i["riders"]),
                                  pairs=len(i["pairs"])) for i in insts], levels=[])
    for level in args.concurrency:
        jobs = [i for i in insts for _ in range(args.runs)]
        t0 = time.perf_counter()
        with cf.ThreadPoolExecutor(level) as ex:
            rows = list(ex.map(lambda i: one(problem, i, cfg, args.timeout), jobs))
        lv = dict(concurrency=level, elapsed_s=round(time.perf_counter() - t0, 2), summary=summary(rows),
                  load_average_after=os.getloadavg() if hasattr(os, "getloadavg") else None,
                  anomalies=[r for r in rows if r["wall_s"] > args.slow or r["status"] != "OPTIMAL" or not r["accepted"]])
        report["levels"].append(lv)
        print(json.dumps(dict(concurrency=level, **lv["summary"], anomalies=len(lv["anomalies"]))), flush=True)
    report["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    Path(args.out).write_text(json.dumps(report, indent=1))
    return 0 if all(not lv["anomalies"] for lv in report["levels"]) else 1


if __name__ == "__main__":
    sys.exit(main())
