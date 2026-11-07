"""Routing on a built road network: nearest-node snapping, travel-time Dijkstra, routes and travel-time matrices."""
from __future__ import annotations

import heapq
import math
import threading
from collections import OrderedDict

from .osm import haversine_m

CELL = 0.005                                    # snapping grid cell (degrees)


class RoadNetwork:
    def __init__(self, net: dict):
        self.network_id = net["network_id"]
        self.lat, self.lon = net["lat"], net["lon"]
        self.osm_node_ids = net["osm_node_ids"]
        n = len(self.lat)
        self.adj: list[list[tuple[int, float, float]]] = [[] for _ in range(n)]
        for u, v, length, t in net["edges"]:
            self.adj[u].append((v, t, length))
        self._grid: dict[tuple[int, int], list[int]] = {}
        for i in range(n):
            self._grid.setdefault((int(self.lat[i] // CELL), int(self.lon[i] // CELL)), []).append(i)
        self._sssp: "OrderedDict[int, tuple[list, list, list]]" = OrderedDict()
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self.lat)

    def bounds(self) -> list[float]:
        return [min(self.lat), min(self.lon), max(self.lat), max(self.lon)]

    def snap(self, lat: float, lon: float) -> tuple[int, float]:
        """(node index, snapping distance in metres) of the nearest network node."""
        ci, cj = int(lat // CELL), int(lon // CELL)
        for r in range(0, 60):
            cand = [i for di in range(-r, r + 1) for dj in range(-r, r + 1) if max(abs(di), abs(dj)) == r
                    for i in self._grid.get((ci + di, cj + dj), ())]
            if cand:
                # include one more ring: cells are not isotropic in metres, so the nearest node may lie there
                ring = [i for di in range(-r - 1, r + 2) for dj in range(-r - 1, r + 2)
                        for i in self._grid.get((ci + di, cj + dj), ())]
                best = min(ring, key=lambda i: haversine_m(lat, lon, self.lat[i], self.lon[i]))
                return best, round(haversine_m(lat, lon, self.lat[best], self.lon[best]), 1)
        raise ValueError("point is too far from the road network")

    def _dijkstra(self, s: int) -> tuple[list, list, list]:
        with self._lock:
            if s in self._sssp:
                self._sssp.move_to_end(s)
                return self._sssp[s]
        n = len(self.lat)
        dist, length, pred = [math.inf] * n, [0.0] * n, [-1] * n
        dist[s] = 0.0
        pq = [(0.0, s)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for v, t, ln in self.adj[u]:
                nd = d + t
                if nd < dist[v]:
                    dist[v], length[v], pred[v] = nd, length[u] + ln, u
                    heapq.heappush(pq, (nd, v))
        with self._lock:
            self._sssp[s] = (dist, length, pred)
            while len(self._sssp) > 64:
                self._sssp.popitem(last=False)
        return dist, length, pred

    def travel(self, u: int, v: int) -> tuple[float, float]:
        """(seconds, metres) of the fastest path."""
        dist, length, _ = self._dijkstra(u)
        if math.isinf(dist[v]):
            raise ValueError("no path")
        return dist[v], length[v]

    def route(self, u: int, v: int) -> dict:
        dist, length, pred = self._dijkstra(u)
        if math.isinf(dist[v]):
            raise ValueError("no path")
        path, x = [], v
        while x != -1:
            path.append(x)
            if x == u:
                break
            x = pred[x]
        path.reverse()
        return dict(time_s=round(dist[v], 1), length_m=round(length[v], 1),
                    coords=[[self.lat[i], self.lon[i]] for i in path])

    def matrix(self, sources: list[int], targets: list[int]) -> list[list[float]]:
        """Travel times in seconds, one Dijkstra per distinct source."""
        out = []
        for s in sources:
            dist, _, _ = self._dijkstra(s)
            out.append([round(dist[t], 1) for t in targets])
        return out
