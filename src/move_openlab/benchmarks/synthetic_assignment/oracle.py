"""Independent optimality oracle: min-cost maximum flow by successive shortest paths (Bellman-Ford), independent of
any MILP solver. Used by the tests to certify the exact method on every benchmark instance size."""
from __future__ import annotations


def lex_optimum(inst: dict) -> tuple[int, int]:
    """(max served, min cost at max served) of an instance."""
    nodes = ["s", "t"] + [d["id"] for d in inst["drivers"]] + [p["id"] for p in inst["passengers"]]
    idx = {n: i for i, n in enumerate(nodes)}
    g: list[list[list[int]]] = [[] for _ in nodes]

    def add(u, v, c, w):
        g[u].append([v, c, w, len(g[v])])
        g[v].append([u, 0, -w, len(g[u]) - 1])
    for d in inst["drivers"]:
        add(0, idx[d["id"]], d["capacity"], 0)
    for p in inst["passengers"]:
        add(idx[p["id"]], 1, 1, 0)
    for pr in inst["compatible_pairs"]:
        add(idx[pr["driver"]], idx[pr["passenger"]], 1, pr["cost"])
    flow = total = 0
    while True:
        dist, prev = [None] * len(nodes), [None] * len(nodes)
        dist[0] = 0
        for _ in range(len(nodes)):
            changed = False
            for u in range(len(nodes)):
                if dist[u] is None:
                    continue
                for k, (v, c, w, _) in enumerate(g[u]):
                    if c > 0 and (dist[v] is None or dist[u] + w < dist[v]):
                        dist[v], prev[v], changed = dist[u] + w, (u, k), True
            if not changed:
                break
        if dist[1] is None:
            return flow, total
        v = 1
        while v != 0:
            u, k = prev[v]
            g[u][k][1] -= 1
            g[v][g[u][k][3]][1] += 1
            v = u
        flow, total = flow + 1, total + dist[1]
