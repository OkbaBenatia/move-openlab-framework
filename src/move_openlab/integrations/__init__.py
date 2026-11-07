"""Open-data scenario sources.

Bundled: :mod:`.rpc`, the connector for the French national carpooling proof registry (RPC) open-data releases
(Licence Ouverte / Etalab). It is used by the geographic layer (:mod:`move_openlab.geo`) and the ``/api/geo`` routes;
it contacts data.gouv.fr only when an administrator starts an ingestion. Road networks from OpenStreetMap are handled
by :mod:`move_openlab.geo.osm` (ODbL).

Extension point: separately installed sources implement :class:`ScenarioSource` and register with the
``move_openlab.scenario_sources`` entry-point group; :func:`catalogue` lists them (see :mod:`.osm` and :mod:`.opendata`
for the contracts). Every source must record the data release, its checksum, its licence and every processing step.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from importlib.metadata import entry_points

GROUP = "move_openlab.scenario_sources"


@dataclass(frozen=True)
class SourceInfo:
    id: str
    label: str
    kind: str                       # "road-network" | "trip-records" | other
    licence: str                    # SPDX id or licence name, as published by the data provider
    attribution: str                # text that must accompany derived data
    requires_network: bool
    problem_ids: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict:
        return asdict(self)


class ScenarioSource(ABC):
    """Produces instances of one or more problems from external data, with provenance."""

    @abstractmethod
    def info(self) -> SourceInfo:
        ...

    @abstractmethod
    def available(self) -> tuple[bool, str]:
        """(usable now, reason) — e.g. missing local data file or licence not accepted by the operator."""

    @abstractmethod
    def parameters(self) -> dict:
        """Parameter description for user interfaces (same format as Problem.scenario_parameters)."""

    @abstractmethod
    def load(self, problem_id: str, params: dict) -> tuple[list[dict], dict]:
        """(instances, provenance). Provenance must name the data release, its checksum, the licence and every
        processing step, so that a campaign built from it can be audited and re-derived."""


def discover() -> list[ScenarioSource]:
    out = []
    for ep in entry_points(group=GROUP):
        try:
            obj = ep.load()
            src = obj() if isinstance(obj, type) else obj
            if isinstance(src, ScenarioSource):
                out.append(src)
        except Exception:                                  # an unusable source is simply not listed
            continue
    return out


def catalogue() -> list[dict]:
    rows = []
    for s in discover():
        ok, why = s.available()
        rows.append(dict(s.info().to_dict(), available=ok, reason=why))
    return rows
