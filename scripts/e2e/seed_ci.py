#!/usr/bin/env python3
"""Deterministic, synthetic data directory for the browser journeys (CI and local runs).

Creates two researcher accounts with random passwords (written to ``<data>/dev-credentials.json``, mode 0600, never
printed) and gives each workspace an area named *Synthetic grid* with a generated road network: a square grid of
two-way streets far from any real place (no download, no real map or mobility data). The shipped Montbéliard
demonstration is installed by the application itself at the first sign-in, as for any researcher.

    MOVE_OPENLAB_DATA_DIR=<empty dir> python scripts/e2e/seed_ci.py
"""
from __future__ import annotations

import json
import secrets
import sys
from pathlib import Path

from move_openlab import privatefiles
from move_openlab.auth import Auth, hash_password
from move_openlab.geo.areas import AreaStore
from move_openlab.geo.osm import NetworkStore
from move_openlab.settings import Settings

USERS = ("researcher1", "researcher2")
LAT0, LON0, STEP, N = 10.0, 20.0, 0.004, 21            # 21 × 21 streets, about 8.8 km wide, in the open sea off Africa
AREA = "Synthetic grid"


def grid() -> bytes:
    nid = lambda i, j: 1000 + i * N + j                  # noqa: E731
    nodes = [dict(type="node", id=nid(i, j), lat=round(LAT0 + i * STEP, 6), lon=round(LON0 + j * STEP, 6))
             for i in range(N) for j in range(N)]
    ways, w = [], 1
    for i in range(N):
        ways.append(dict(type="way", id=w, nodes=[nid(i, j) for j in range(N)],
                         tags=dict(highway="primary" if i % 5 == 0 else "residential"))); w += 1
    for j in range(N):
        ways.append(dict(type="way", id=w, nodes=[nid(i, j) for i in range(N)],
                         tags=dict(highway="primary" if j % 5 == 0 else "residential"))); w += 1
    return json.dumps(dict(osm3s=dict(timestamp_osm_base="2026-01-01T00:00:00Z"), elements=nodes + ways)).encode()


def main() -> int:
    s = Settings.from_env()
    if s.production:
        print("refusing to seed test data in production", file=sys.stderr)
        return 2
    auth = Auth(s)
    f = s.data_dir / "dev-credentials.json"
    creds = json.loads(f.read_text()) if f.exists() else {}
    for u in USERS:
        if not auth.store.get(u):
            pw = secrets.token_urlsafe(18)
            auth.create_user(u, u.replace("researcher", "Researcher "), role="researcher", password=pw, created_by="seed_ci")
            auth.store.set_password(u, hash_password(pw), must_change=False)
            creds[u] = pw
    privatefiles.write(f, json.dumps(creds, indent=1))
    bbox = [LAT0 - 0.001, LON0 - 0.001, LAT0 + (N - 1) * STEP + 0.001, LON0 + (N - 1) * STEP + 0.001]
    prov = NetworkStore(s.data_dir).save(grid(), dict(name=AREA, bbox=bbox), "synthetic://seed_ci")
    for u in USERS:
        areas = AreaStore(Path(s.data_dir) / "workspaces" / u)
        if not any(a["name"] == AREA for a in areas.list()):
            areas.create(AREA, bbox, network_id=prov["network_id"])
    print(f"seeded {len(USERS)} accounts and the area {AREA!r} (network {prov['network_id']}, {prov['nodes']} nodes) in {s.data_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
