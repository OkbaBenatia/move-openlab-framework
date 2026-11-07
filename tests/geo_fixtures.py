"""Synthetic geographic fixtures (generated at test time; no real map or mobility data)."""
import csv
import io
import json

LAT0, LON0, STEP = 10.0, 20.0, 0.004            # an artificial grid far from any real road network


def grid_overpass(n: int = 7) -> bytes:
    """n x n grid of two-way residential streets, plus one one-way street and one street with maxspeed=90."""
    nodes, ways, nid = [], [], lambda i, j: 1000 + i * n + j
    for i in range(n):
        for j in range(n):
            nodes.append(dict(type="node", id=nid(i, j), lat=round(LAT0 + i * STEP, 6), lon=round(LON0 + j * STEP, 6)))
    wid = 1
    for i in range(n):
        tags = dict(highway="residential")
        if i == 1:
            tags = dict(highway="residential", oneway="yes")
        if i == 3:
            tags = dict(highway="primary", maxspeed="90")
        ways.append(dict(type="way", id=wid, nodes=[nid(i, j) for j in range(n)], tags=tags)); wid += 1
    for j in range(n):
        ways.append(dict(type="way", id=wid, nodes=[nid(i, j) for i in range(n)], tags=dict(highway="residential"))); wid += 1
    ways.append(dict(type="way", id=wid, nodes=[nid(0, 0), nid(0, 1)], tags=dict(highway="residential", access="private")))
    return json.dumps(dict(osm3s=dict(timestamp_osm_base="2026-01-01T00:00:00Z"), elements=nodes + ways)).encode()


def pt(i: float, j: float) -> list[float]:
    return [round(LAT0 + i * STEP, 6), round(LON0 + j * STEP, 6)]


RPC_HEADER = ["journey_id", "trip_id", "journey_start_datetime", "journey_start_date", "journey_start_time",
              "journey_start_lon", "journey_start_lat", "journey_start_insee", "journey_start_department", "journey_start_town",
              "journey_start_towngroup", "journey_start_country", "journey_end_datetime", "journey_end_date",
              "journey_end_time", "journey_end_lon", "journey_end_lat", "journey_end_insee", "journey_end_department",
              "journey_end_town", "journey_end_towngroup", "journey_end_country", "passenger_seats", "operator_class",
              "journey_distance", "journey_duration", "has_incentive"]


def rpc_csv(path, n_valid: int = 40) -> dict:
    """Synthetic file in the publisher's format: valid rows inside the grid plus one row per rejection reason."""
    rows = []

    def row(jid, s, e, t0="2026-08-03T07:30:00+0200", t1="2026-08-03T07:50:00+0200", dist=4000, dur=20):
        return [jid, f"trip{jid}", t0, t0[:10], t0[11:19], s[1], s[0], "00000", "00", "Town", "", "France", t1, t1[:10],
                t1[11:19], e[1], e[0], "00000", "00", "Town", "", "France", 1, "C", dist, dur, "NON"]
    for k in range(n_valid):
        h = 7 + (k % 3)
        rows.append(row(str(k + 1), pt(k % 7 * 0.9, (k * 3) % 7 * 0.9), pt((k * 5) % 7 * 0.9, (k + 2) % 7 * 0.9),
                        t0=f"2026-08-03T0{h}:{(k % 6) * 10:02d}:00+0200", t1=f"2026-08-03T0{h}:{(k % 6) * 10 + 5:02d}:00+0200"))
    rows.append(row("900", [48.0, 2.0], pt(1, 1)))                                       # outside_area
    rows.append(row("901", ["x", "y"], pt(1, 1)))                                        # invalid_coordinates
    rows.append(row("902", pt(1, 1), pt(2, 2), t0="yesterday"))                          # invalid_datetime
    rows.append(row("903", pt(1, 1), pt(2, 2), t0="2026-08-03T08:00:00+0200", t1="2026-08-03T07:00:00+0200"))
    rows.append(row("904", pt(1, 1), pt(2, 2), dist=0))                                  # non_positive
    rows.append(row("905", pt(1, 1), pt(2, 2), dist=900000, dur=10))                     # implausible_speed
    rows.append(row("1", pt(0, 0), pt(6, 6)))                                            # duplicate_journey
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_NONNUMERIC)
    w.writerow(RPC_HEADER)
    for r in rows:
        w.writerow(r)
    path.write_text(buf.getvalue())
    return dict(release="2026-08", title="2026-08.csv", resource_id="fixture", url="fixture://", filesize=path.stat().st_size,
                last_modified="2026-09-07T09:50:05")


BBOX = [LAT0 - 0.001, LON0 - 0.001, LAT0 + 6 * STEP + 0.001, LON0 + 6 * STEP + 0.001]
