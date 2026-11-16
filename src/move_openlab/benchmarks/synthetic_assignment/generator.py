"""Deterministic synthetic instance generator (Python ``random.Random(seed)`` only: identical on every platform).

Identifiers D1..Dn / P1..Pm, coordinates in a 100 x 100 square, time windows in minutes, integer capacities. A pair
(d, p) is compatible when the Euclidean distance between the driver's and the passenger's points is at most RADIUS and
their time windows overlap by at least MIN_OVERLAP minutes; its cost is the rounded distance (x10) plus the waiting
mismatch (absolute difference of window starts, minutes).

Calibration rule for RADIUS: the smallest radius giving a mean pair density >= 0.20 and a mean passenger coverage
>= 2/3 for every size.
"""
from __future__ import annotations

import math
import random

from ...hashing import with_hash
from .spec import INSTANCE_SCHEMA, PROBLEM_ID, PROBLEM_SPEC_VERSION

GENERATOR_NAME = "move_openlab.synthetic_assignment.generator"
GENERATOR_VERSION = "1.0.0"
SIZES = {"small": (4, 8), "medium": (8, 16), "large": (16, 32)}
SEEDS = list(range(1, 11))             # predefined benchmark seeds; seed 0 is reserved for method self-tests
RADIUS = 50.0
MIN_OVERLAP = 5
HORIZON = 120
CAPACITY = (1, 3)


def pair_cost(d: dict, p: dict) -> int:
    return int(round(10 * math.hypot(d["x"] - p["x"], d["y"] - p["y"]))) + abs(d["t_start"] - p["t_start"])


def overlap(d: dict, p: dict) -> int:
    return min(d["t_end"], p["t_end"]) - max(d["t_start"], p["t_start"])


def derive_pairs(drivers: list[dict], passengers: list[dict], radius: float, min_overlap: int) -> list[dict]:
    """The compatibility and cost rule (also re-applied by the controlled variants)."""
    return [dict(driver=d["id"], passenger=p["id"], cost=pair_cost(d, p))
            for d in drivers for p in passengers
            if math.hypot(d["x"] - p["x"], d["y"] - p["y"]) <= radius and overlap(d, p) >= min_overlap]


def generate(size: str, seed: int) -> dict:
    if size not in SIZES:
        raise ValueError(f"unknown size {size!r}")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 1_000_000:
        raise ValueError("seed must be an integer in [0, 1000000]")
    n_d, n_p = SIZES[size]
    rnd = random.Random(f"{size}:{seed}:{GENERATOR_VERSION}")

    def pt():
        return round(rnd.uniform(0, 100), 2), round(rnd.uniform(0, 100), 2)
    drivers, passengers = [], []
    for i in range(n_d):
        x, y = pt(); start = rnd.randint(0, HORIZON - 40); length = rnd.randint(30, 60)
        drivers.append(dict(id=f"D{i + 1}", x=x, y=y, capacity=rnd.randint(*CAPACITY), t_start=start, t_end=start + length))
    for k in range(n_p):
        x, y = pt(); start = rnd.randint(0, HORIZON - 20); length = rnd.randint(15, 40)
        passengers.append(dict(id=f"P{k + 1}", x=x, y=y, t_start=start, t_end=start + length))
    inst = dict(schema=INSTANCE_SCHEMA, problem_id=PROBLEM_ID, problem_spec_version=PROBLEM_SPEC_VERSION,
                generator=dict(name=GENERATOR_NAME, version=GENERATOR_VERSION, size=size, seed=seed, radius=RADIUS,
                               min_overlap=MIN_OVERLAP, horizon=HORIZON, capacity_range=list(CAPACITY)),
                instance_id=f"syn-{size}-s{seed:02d}", synthetic=True, drivers=drivers, passengers=passengers,
                compatible_pairs=derive_pairs(drivers, passengers, RADIUS, MIN_OVERLAP))
    return with_hash(inst)


def scenario_set(sizes=("small", "medium", "large"), seeds=SEEDS) -> list[dict]:
    return [generate(s, k) for s in sizes for k in seeds]
