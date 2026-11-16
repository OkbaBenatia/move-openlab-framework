"""Normalisation and validation of trip records, shared by every dataset provider.

A normalised trip is ``{date, start_s, start_lat, start_lon, end_lat, end_lon, role}``:

* ``date`` ISO ``YYYY-MM-DD`` or ``None`` when the source gives a time of day only;
* ``start_s`` departure time as seconds since midnight, as written in the source (local wall-clock time; epoch
  timestamps are read as UTC);
* coordinates in WGS-84 decimal degrees;
* ``role`` ``"driver"``, ``"rider"`` or ``None`` (not observed).

Every rejected row is counted under a reason, and the first examples (row number, reason, offending value) are kept,
so the researcher sees exactly why data was refused. Nothing is guessed silently: ambiguous or mixed timestamp
formats are errors.
"""
from __future__ import annotations

import re
from datetime import date as Date
from datetime import datetime, timezone

TIME_FORMATS = ("auto", "iso", "time", "epoch")
TIME_LABELS = {"iso": "ISO 8601 date-time", "time": "time of day (HH:MM)", "epoch": "Unix timestamp (seconds)"}
DATE_FORMATS = ("YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY")
DRIVER = {"driver", "d", "conducteur", "conductor", "conductora", "fahrer"}
RIDER = {"rider", "r", "passenger", "p", "passager", "passagère", "pasajero", "pasajera", "mitfahrer"}
MAX_EXAMPLES = 12
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$")
EPOCH_RE = re.compile(r"^\d{9,10}(\.\d+)?$")


class DatasetError(ValueError):
    """The dataset cannot be interpreted; the message says what to change."""


def number(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        x = float(v)
    else:
        t = str(v).strip().replace(" ", "")
        if not t:
            return None
        if t.count(",") == 1 and "." not in t:                # decimal comma (e.g. 48,8566)
            t = t.replace(",", ".")
        try:
            x = float(t)
        except ValueError:
            return None
    return x if x == x and abs(x) != float("inf") else None


def detect_time_format(values: list[str]) -> str:
    sample = [str(v).strip() for v in values if str(v).strip()][:200]
    if not sample:
        raise DatasetError("the departure column is empty")
    kinds = {"iso" if ISO_RE.match(v) else "time" if TIME_RE.match(v) else "epoch" if EPOCH_RE.match(v) else "?"
             for v in sample}
    if kinds == {"?"}:
        raise DatasetError(f"departure values are not recognised timestamps (e.g. {sample[0]!r}); use ISO 8601 "
                           "('2026-08-03T07:40:00'), a time of day ('07:40') or Unix seconds")
    kinds.discard("?")
    if len(kinds) > 1:
        raise DatasetError(f"mixed timestamp formats in the departure column ({', '.join(sorted(kinds))}); "
                           "choose the format explicitly")
    return kinds.pop()


def parse_time(v: str, fmt: str) -> tuple[str | None, int]:
    t = str(v).strip()
    if fmt == "iso":
        if not ISO_RE.match(t):
            raise ValueError
        d = datetime.fromisoformat(t.replace("Z", "+00:00").replace(" ", "T", 1))
        return d.date().isoformat(), d.hour * 3600 + d.minute * 60 + d.second
    if fmt == "time":
        m = TIME_RE.match(t)
        if not m:
            raise ValueError
        h, mi, se = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
        if h > 23 or mi > 59 or se > 59:
            raise ValueError
        return None, h * 3600 + mi * 60 + se
    if fmt == "epoch":
        if not EPOCH_RE.match(t):
            raise ValueError
        d = datetime.fromtimestamp(float(t), tz=timezone.utc)
        return d.date().isoformat(), d.hour * 3600 + d.minute * 60 + d.second
    raise DatasetError(f"unknown time format {fmt!r}")


def parse_date(v: str, fmt: str) -> str:
    t = str(v).strip()
    if fmt == "YYYY-MM-DD":
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
            raise ValueError
        return Date.fromisoformat(t).isoformat()
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", t)
    if not m:
        raise ValueError
    a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    d, mo = (a, b) if fmt == "DD/MM/YYYY" else (b, a)
    return Date(y, mo, d).isoformat()


def role_of(v) -> str | None:
    t = str(v or "").strip().casefold()
    if not t:
        return None
    if t in DRIVER:
        return "driver"
    if t in RIDER:
        return "rider"
    raise ValueError


class Collector:
    """Accumulates normalised trips and rejection statistics."""

    def __init__(self):
        self.trips: list[dict] = []
        self.rejected: dict[str, int] = {}
        self.examples: list[dict] = []
        self.read = 0

    def reject(self, row: int, reason: str, value=None) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + 1
        if len(self.examples) < MAX_EXAMPLES:
            self.examples.append(dict(row=row, reason=reason, value=None if value is None else str(value)[:80]))

    def add(self, row: int, olat, olon, dlat, dlon, when, time_fmt: str, date_value=None, date_fmt=None, role=None,
            has_role: bool = False) -> None:
        self.read += 1
        a, b, c, d = number(olat), number(olon), number(dlat), number(dlon)
        if None in (a, b, c, d):
            return self.reject(row, "missing or non-numeric coordinate", next(x for x in (olat, olon, dlat, dlon)
                                                                                 if number(x) is None))
        if not (-90 <= a <= 90 and -90 <= c <= 90):
            return self.reject(row, "latitude outside [-90, 90] (latitude and longitude swapped?)", a if abs(a) > 90 else c)
        if not (-180 <= b <= 180 and -180 <= d <= 180):
            return self.reject(row, "longitude outside [-180, 180]", b if abs(b) > 180 else d)
        if (a, b) == (0.0, 0.0) or (c, d) == (0.0, 0.0):
            return self.reject(row, "null-island coordinate (0, 0)")
        if (a, b) == (c, d):
            return self.reject(row, "origin equals destination")
        try:
            day, sec = parse_time(when, time_fmt)
        except ValueError:
            return self.reject(row, f"departure is not a valid {TIME_LABELS.get(time_fmt, time_fmt)}", when)
        if date_value is not None and str(date_value).strip():
            try:
                day = parse_date(date_value, date_fmt or "YYYY-MM-DD")
            except ValueError:
                return self.reject(row, f"date is not a valid {date_fmt or 'YYYY-MM-DD'} date", date_value)
        r = None
        if has_role:
            try:
                r = role_of(role)
            except ValueError:
                return self.reject(row, "unknown role (accepted: driver/conducteur/conductor, rider/passenger/passager/pasajero)", role)
        self.trips.append(dict(date=day, start_s=sec, start_lat=round(a, 6), start_lon=round(b, 6),
                               end_lat=round(c, 6), end_lon=round(d, 6), role=r))


def summary(trips: list[dict], bbox=None) -> dict:
    """Geographic and temporal coverage; ``inside_area`` when a box (south, west, north, east) is given."""
    if not trips:
        return dict(trips=0)
    lats = [t[k] for t in trips for k in ("start_lat", "end_lat")]
    lons = [t[k] for t in trips for k in ("start_lon", "end_lon")]
    dates = sorted({t["date"] for t in trips if t.get("date")})
    hours = [0] * 24
    for t in trips:
        hours[min(23, t["start_s"] // 3600)] += 1
    roles = {k: sum(1 for t in trips if t.get("role") == k) for k in ("driver", "rider")}
    out = dict(trips=len(trips), extent=[min(lats), min(lons), max(lats), max(lons)],
               dates=[dates[0], dates[-1]] if dates else None, distinct_dates=len(dates), departures_by_hour=hours,
               roles=roles if any(roles.values()) else None)
    if bbox is not None:
        s, w, n, e = bbox
        out["inside_area"] = sum(1 for t in trips if s <= t["start_lat"] <= n and w <= t["start_lon"] <= e
                                 and s <= t["end_lat"] <= n and w <= t["end_lon"] <= e)
    return out
