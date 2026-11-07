"""Trip-record interface for open mobility data, e.g. open carpooling registry releases (for separately installed
sources; the bundled RPC connector is :mod:`move_openlab.integrations.rpc`).

Records are anonymised open-data rows; implementations must not attempt re-identification, must keep the publisher's
licence and attribution, and must record the release identifier and checksum in the instance provenance.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Iterator


@dataclass(frozen=True)
class TripRecord:
    trip_id: str
    origin_lat: float
    origin_lon: float
    destination_lat: float
    destination_lon: float
    start_time: str                  # ISO 8601, as published (may be rounded by the publisher)
    end_time: str | None = None
    role: str | None = None          # e.g. "driver" | "passenger" when the release distinguishes them


@dataclass(frozen=True)
class ReleaseProvenance:
    publisher: str
    release_id: str
    release_sha256: str
    licence: str
    attribution: str
    processing: tuple[str, ...]      # ordered list of processing steps applied


class TripRecordSource(ABC):
    @abstractmethod
    def provenance(self) -> ReleaseProvenance:
        ...

    @abstractmethod
    def records(self, start: str, end: str, bbox: tuple[float, float, float, float] | None = None) -> Iterator[TripRecord]:
        """Records whose start time is in [start, end), optionally inside (min_lon, min_lat, max_lon, max_lat)."""
