"""Road-network interface for OpenStreetMap-derived travel times (for separately installed sources; the bundled
implementation is :mod:`move_openlab.geo.osm`).

OpenStreetMap data is © OpenStreetMap contributors and available under the Open Database License (ODbL). A concrete
implementation must keep the attribution with every derived artifact and record the extract (area, date, checksum)
and the routing profile in the instance provenance.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"


@dataclass(frozen=True)
class Point:
    lat: float
    lon: float


@dataclass(frozen=True)
class NetworkProvenance:
    extract_name: str                # e.g. a regional extract identifier
    extract_date: str                # ISO date of the OSM data
    extract_sha256: str
    profile: str                     # routing profile (e.g. "car")
    builder: str                     # name and version of the graph-building code
    attribution: str = OSM_ATTRIBUTION


class RoadNetwork(ABC):
    """Shortest travel times on a road network built from an OpenStreetMap extract."""

    @abstractmethod
    def provenance(self) -> NetworkProvenance:
        ...

    @abstractmethod
    def snap(self, point: Point) -> tuple[str, float]:
        """(network node id, snapping distance in metres)."""

    @abstractmethod
    def travel_time_matrix(self, origins: list[Point], destinations: list[Point]) -> list[list[float | None]]:
        """Travel times in seconds; None when unreachable."""
