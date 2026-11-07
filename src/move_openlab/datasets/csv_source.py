"""CSV trip files uploaded by a researcher: encoding and delimiter detection, explicit column mapping, validation.

Detection is only a proposal shown to the researcher: the encoding (UTF-8, UTF-8 with BOM, Windows-1252, Latin-1)
and delimiter (``,`` ``;`` tab ``|``) are reported, and every column used must be mapped explicitly before import.
"""
from __future__ import annotations

import csv
import io
import re

from .tabular import DATE_FORMATS, TIME_FORMATS, Collector, DatasetError, detect_time_format

DELIMITERS = [",", ";", "\t", "|"]
REQUIRED = ("origin_lat", "origin_lon", "destination_lat", "destination_lon", "departure")
OPTIONAL = ("date", "role")
MAX_ROWS = 500_000
MAX_COLUMNS = 200
HINTS = {
    "origin_lat": r"^(origin|orig|start|from|pickup|o|departure|dep|journey_start)[_ .-]?(lat|latitude|y)$",
    "origin_lon": r"^(origin|orig|start|from|pickup|o|departure|dep|journey_start)[_ .-]?(lon|lng|long|longitude|x)$",
    "destination_lat": r"^(destination|dest|end|to|dropoff|d|arrival|arr|journey_end)[_ .-]?(lat|latitude|y)$",
    "destination_lon": r"^(destination|dest|end|to|dropoff|d|arrival|arr|journey_end)[_ .-]?(lon|lng|long|longitude|x)$",
    "departure": r"^(departure|depart|start|pickup|journey_start)?[_ .-]?(time|datetime|timestamp)$|^(departure|heure|time)$",
    "date": r"^(date|day|jour|fecha)$",
    "role": r"^(role|rôle|type|mode)$",
}


def decode(raw: bytes) -> tuple[str, str]:
    for enc in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            text = raw.decode(enc)
            return text, ("utf-8 (BOM)" if enc == "utf-8-sig" and raw.startswith(b"\xef\xbb\xbf") else
                          "utf-8" if enc.startswith("utf-8") else "windows-1252")
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1"), "latin-1 (assumed)"


def sniff_delimiter(text: str) -> str:
    head = "\n".join(text.splitlines()[:50])
    try:
        return csv.Sniffer().sniff(head, delimiters="".join(DELIMITERS)).delimiter
    except csv.Error:
        counts = {d: head.splitlines()[0].count(d) if head else 0 for d in DELIMITERS}
        best = max(counts, key=counts.get)
        if counts[best] == 0:
            raise DatasetError("no delimiter found: the file must have at least 2 columns separated by , ; tab or |") from None
        return best


def _reader(text: str, delimiter: str):
    return csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)


def inspect(raw: bytes, delimiter: str | None = None) -> dict:
    if b"\x00" in raw[:8192]:
        raise DatasetError("this is not a text file (binary content found)")
    text, enc = decode(raw)
    delim = delimiter or sniff_delimiter(text)
    if delim not in DELIMITERS:
        raise DatasetError("unsupported delimiter")
    rows = _reader(text, delim)
    try:
        header = next(rows)
    except StopIteration:
        raise DatasetError("the file is empty") from None
    header = [h.strip() for h in header]
    if len(header) < 2 or len(header) > MAX_COLUMNS:
        raise DatasetError(f"expected 2 to {MAX_COLUMNS} columns, found {len(header)}; check the delimiter")
    if len(set(header)) != len(header) or any(not h for h in header):
        raise DatasetError("column names must be non-empty and distinct")
    preview = [r for _, r in zip(range(8), rows)]
    suggested = {}
    for field, pat in HINTS.items():
        hit = next((h for h in header if re.match(pat, h.strip().casefold())), None)
        if hit and hit not in suggested.values():
            suggested[field] = hit
    return dict(encoding=enc, delimiter=delim, columns=header, preview=preview,
                rows_estimate=max(0, text.count("\n") - 1 + (0 if text.endswith("\n") else 1)),
                suggested_mapping=suggested, required=list(REQUIRED), optional=list(OPTIONAL),
                time_formats=list(TIME_FORMATS), date_formats=list(DATE_FORMATS))


def parse(raw: bytes, mapping: dict, time_format: str = "auto", date_format: str = "YYYY-MM-DD",
          delimiter: str | None = None) -> tuple[Collector, dict]:
    info = inspect(raw, delimiter)
    cols = info["columns"]
    missing = [f for f in REQUIRED if not mapping.get(f)]
    if missing:
        raise DatasetError(f"map these fields to columns: {', '.join(missing)}")
    unknown = [v for k, v in mapping.items() if v and v not in cols]
    if unknown:
        raise DatasetError(f"columns not in the file: {', '.join(map(str, unknown))}")
    used = [mapping[f] for f in REQUIRED + OPTIONAL if mapping.get(f)]
    if len(set(used)) != len(used):
        raise DatasetError("each column can be mapped to one field only")
    if time_format not in TIME_FORMATS or date_format not in DATE_FORMATS:
        raise DatasetError("unknown time or date format")
    idx = {f: cols.index(mapping[f]) for f in REQUIRED + OPTIONAL if mapping.get(f)}
    text, _ = decode(raw)
    rows = list(_reader(text, info["delimiter"]))[1:]
    if len(rows) > MAX_ROWS:
        raise DatasetError(f"too many rows ({len(rows)}; at most {MAX_ROWS})")
    if time_format == "auto":
        time_format = detect_time_format([r[idx["departure"]] for r in rows if len(r) > idx["departure"]])
    col = Collector()
    for i, r in enumerate(rows, start=2):                     # row 1 is the header
        if not any(c.strip() for c in r):
            continue
        if len(r) != len(cols):
            col.read += 1
            col.reject(i, f"expected {len(cols)} fields, found {len(r)}")
            continue
        g = {f: r[j] for f, j in idx.items()}
        col.add(i, g["origin_lat"], g["origin_lon"], g["destination_lat"], g["destination_lon"], g["departure"],
                time_format, g.get("date"), date_format, g.get("role"), has_role="role" in idx)
    return col, dict(format="csv", encoding=info["encoding"], delimiter=info["delimiter"], mapping=mapping,
                     time_format=time_format, date_format=date_format if "date" in idx else None)
