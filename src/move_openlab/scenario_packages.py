"""Portable scenario packages: one frozen scenario, exported from the scenario library or from an experiment, verified
completely and imported into another researcher's scenario library.

A package is a ZIP archive without executable code, format ``move-openlab-scenario/1``::

  manifest.json      what the package contains and how to check it (below)
  manifest.sha256    SHA-256 of manifest.json
  instance.json      the frozen, content-addressed instance (participants, travel times, compatible pairs ...)
  scenario.json      ride matching: the editable composition the instance is built from
  geometry.json      ride matching, optional: replay polylines of the instance's legs (see :mod:`.geo.geometry`)

Manifest::

  format, created_at, exporter {display, installation, framework_version}
  spec, validator_version, synthetic        the problem specification record and validator of the exporter
  scenario {name, instance_id, instance_hash, problem_id, network_id, drivers, riders, pairs}
  composition {file, origin}               ride matching: where scenario.json comes from ("library": the record the
                                           instance was built from; "instance": recovered from the instance's own
                                           participants, parameters and vehicles)
  provenance {participants, road_network, network, description?}   as recorded in the instance and the network store
  licences [{subject, statement, licence}]                         copied from those records, never invented
  files {member: SHA-256}

Every check runs before anything is written. Refused: oversized archives or members (the limits of experiment bundles),
unknown, unsafe, duplicate, unlisted or missing members, a manifest digest or file checksum that does not match, an
unknown format, a problem / specification / validator that differs from this installation, an instance that fails the
problem's checks or whose content hash differs from the manifest's, replay geometry that does not belong to the instance,
a composition whose participants, windows, parameters or vehicles differ from the instance's, and — where the scenario's
road network is installed here — a composition that does not rebuild to the identical instance. Where the road network is
not installed, the frozen instance and its replay geometry are stored as verified: viewing and running work; editing the
participants needs the area's road network (prepared once from Data setup).

Checksums detect corruption and inconsistent edits; they are not signatures (see :mod:`.bundles`).
"""
from __future__ import annotations

import io
import json
import zipfile
import zlib

from . import __version__
from .bundles import HEX64, MAX_MEMBER_BYTES, MAX_TOTAL_BYTES, _network_ref, zip_member
from .geo import geometry as G
from .hashing import canonical, instance_hash, sha256_bytes
from .store import MAX_BUNDLE_BYTES, BenchError, IntegrityError, NotFound, _lock, now

FORMAT = "move-openlab-scenario/1"
MAX_PACKAGE_BYTES = MAX_BUNDLE_BYTES
INSTANCE, COMPOSITION, GEOMETRY = "instance.json", "scenario.json", "geometry.json"
MEMBERS = ("manifest.json", "manifest.sha256", INSTANCE, COMPOSITION, GEOMETRY)
IMPORTED = "imported scenario package"
RIDE_SCHEMA = "move-openlab/ride-matching-instance/1"
AGENT_KEYS = ("id", "origin", "destination", "earliest", "latest")
# the statement the geographic configuration shows for OpenStreetMap-derived data (api/geo.py)
OSM_STATEMENT = "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)"
EDITING_NEEDS_NETWORK = ("Viewing and running work with the frozen instance and its route geometry; editing the "
                         "participants needs the area's road network (prepared once from Data setup).")
MANIFEST_SCHEMA = dict(
    required=dict(format=str, created_at=str, exporter=dict, spec=dict, validator_version=str, scenario=dict,
                  provenance=dict, licences=list, files=dict),
    optional=dict(composition=dict, synthetic=bool))


def is_ride(inst: dict) -> bool:
    return isinstance(inst, dict) and inst.get("schema") == RIDE_SCHEMA


# ---------------------------------------------------------------- ride matching: composition <-> instance
def composition_from_instance(inst: dict) -> dict:
    """The editable composition of a ride-matching instance, read back from the instance itself: participants (id,
    places, time window), parameters, provenance, vehicles (the default profile first, then the others in the order the
    drivers use them) and emission configuration. Rebuilding it on the same road network gives the same instance."""
    def agent(a: dict) -> dict:
        return {k: a[k] for k in AGENT_KEYS}
    sc = dict(name=inst["name"], network_id=(inst.get("network") or {}).get("network_id", ""), params=inst["params"],
              drivers=[agent(a) for a in inst["drivers"]], riders=[agent(a) for a in inst["riders"]],
              provenance=inst.get("provenance") or dict(source="editor"))
    default = (inst.get("vehicles") or {}).get("default")
    if isinstance(default, dict):
        profiles = {default["id"]: default}
        for d in inst["drivers"]:
            if isinstance(d.get("vehicle"), dict):
                profiles.setdefault(d["vehicle"]["id"], d["vehicle"])
        sc["vehicles"] = dict(profiles=list(profiles.values()), default=default["id"],
                              assignments={d["id"]: d["vehicle"]["id"] for d in inst["drivers"]
                                           if isinstance(d.get("vehicle"), dict) and d["vehicle"]["id"] != default["id"]})
    if inst.get("emissions"):
        sc["emissions"] = inst["emissions"]
    return sc


def composition_errors(sc: object, inst: dict) -> tuple[list[str], dict | None]:
    """Differences between a composition and the instance it claims to build (everything but the road-network snapping
    and travel times, which only a rebuild on the network can confirm). Returns (errors, validated composition)."""
    from .geo import scenarios as SC
    try:
        v = SC.validate_scenario(sc)                    # type: ignore[arg-type]
    except (ValueError, TypeError, KeyError, AttributeError) as e:
        return [f"invalid composition: {e}"], None
    errs = []
    for k, got, want in (("name", v["name"], inst.get("name")), ("params", v["params"], inst.get("params")),
                         ("provenance", v["provenance"], inst.get("provenance") or dict(source="editor")),
                         ("emissions", v.get("emissions"), inst.get("emissions")),
                         ("road network", v["network_id"], (inst.get("network") or {}).get("network_id", ""))):
        if got != want:
            errs.append(f"{k} differs from the instance")
    for role in ("drivers", "riders"):
        if v[role] != [{k: a.get(k) for k in AGENT_KEYS} for a in inst.get(role) or []]:
            errs.append(f"{role} (ids, places or time windows) differ from the instance")
    veh = v.get("vehicles")
    by_id = {p["id"]: p for p in veh["profiles"]} if veh else {}
    if (veh is None) != (not inst.get("vehicles")) or (veh and by_id[veh["default"]] != inst["vehicles"].get("default")):
        errs.append("default vehicle differs from the instance")
    elif not errs:
        for d in inst.get("drivers") or []:
            want = by_id[veh["assignments"].get(d["id"], veh["default"])] if veh else None
            if d.get("vehicle") != want:
                errs.append(f"{d['id']}: vehicle differs from the instance")
                break
    return errs, v


def _network_installed(ws, nid: str | None):
    """(network, provenance) when the road network ``nid`` is stored on this installation, else (None, None)."""
    from .geo.osm import NetworkStore
    if not nid:
        return None, None
    nets = NetworkStore(ws.inst.data)
    try:
        return nets.load(nid), nets.provenance(nid)
    except (KeyError, ValueError, OSError):
        return None, None


def _library_composition(ws, h: str, record: dict | None) -> tuple[dict | None, str]:
    """The composition to ship for instance ``h``: the library record's (an imported record keeps the original
    provenance aside), when it describes the instance; otherwise the one recovered from the instance."""
    cands = [record] if record else []
    if not record:
        for s in ws.scenarios():
            if s["instance_hash"] == h:
                try:
                    cands.append(ws.scenario(s["scenario_id"]))
                except BenchError:
                    pass
    inst = ws.inst.get_instance(h)
    for rec in cands:
        sc = dict(rec.get("scenario") or {})
        prov = sc.get("provenance") or {}
        if prov.get("source") == IMPORTED and isinstance(prov.get("original"), dict):
            sc["provenance"] = prov["original"]
        errs, v = composition_errors(sc, inst)
        if not errs:
            return v, "library"
    return composition_from_instance(inst), "instance"


# ---------------------------------------------------------------- export
def _licences(inst: dict, netref: dict | None) -> list[dict]:
    out = []
    prov = inst.get("provenance") or {}
    if prov.get("licence") or prov.get("attribution"):
        out.append(dict(subject="participants", statement=prov.get("attribution") or (prov.get("licence") or {}).get("name"),
                        licence=prov.get("licence")))
    nw = inst.get("network") or {}
    if nw:
        from .geo.osm import LICENCE as OSM_LICENCE
        lic = (netref or {}).get("licence") or dict(id=nw.get("licence"), attribution=nw.get("attribution"))
        osm = "OpenStreetMap" in str(nw.get("attribution") or lic.get("attribution") or "") and lic.get("id") == OSM_LICENCE["id"]
        if osm and not (netref or {}).get("licence"):       # the network is not installed here: the builder's licence record
            lic = dict(OSM_LICENCE)
        out.append(dict(subject="road network, travel times and route geometry",
                        statement=OSM_STATEMENT if osm else ", ".join(str(x) for x in (nw.get("attribution"), nw.get("licence")) if x),
                        licence=lic))
    return out


def export(ws, h: str, record: dict | None = None, created_at: str | None = None, description: str | None = None
           ) -> tuple[bytes, dict]:
    """The package of instance ``h`` (a library scenario's, with its ``record``, or an experiment's frozen scenario).
    The caller has checked that the account may read it."""
    inst = ws.inst.get_instance(h)
    problem = ws.problem(inst.get("problem_id") or "")
    files: dict[str, bytes] = {INSTANCE: canonical(inst)}
    nid = (inst.get("network") or {}).get("network_id")
    netref, origin = None, None
    if is_ride(inst):
        from .geo.osm import NetworkStore
        comp, origin = _library_composition(ws, h, record)
        files[COMPOSITION] = canonical(comp)
        net, _ = _network_installed(ws, nid)
        doc = None
        if net is not None and "pairs" in inst:
            try:
                doc = G.build(inst, net)
            except (KeyError, ValueError):
                doc = None
        if doc is None:
            doc = G.GeometryStore(ws.root).get(h)
        if doc and doc.get("legs"):
            files[GEOMETRY] = canonical(doc)
        if nid:
            netref = _network_ref(NetworkStore(ws.inst.data), nid)
    counts = {k: len(inst[k]) for k in ("drivers", "riders", "pairs") if isinstance(inst.get(k), list)}
    provenance = dict(participants=inst.get("provenance"), road_network=inst.get("network"), network=netref)
    if description:
        provenance["description"] = description
    manifest = dict(
        format=FORMAT, created_at=created_at or now(),
        exporter=dict(display=ws.display, installation=ws.inst.id, framework_version=__version__),
        spec=problem.spec_record(), validator_version=problem.validator_version, synthetic=problem.synthetic,
        scenario=dict(name=inst.get("name") or inst["instance_id"], instance_id=inst["instance_id"], instance_hash=h,
                      problem_id=problem.problem_id, network_id=nid, **counts),
        **(dict(composition=dict(file=COMPOSITION, origin=origin)) if origin else {}),
        provenance={k: v for k, v in provenance.items() if v is not None},
        licences=_licences(inst, netref),
        files={k: sha256_bytes(v) for k, v in sorted(files.items())})
    mbytes = canonical(manifest)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in sorted(dict(files, **{"manifest.json": mbytes, "manifest.sha256": sha256_bytes(mbytes).encode()}).items()):
            z.writestr(zip_member(k), v)
    data = buf.getvalue()
    return data, dict(package_sha256=sha256_bytes(data), manifest_sha256=sha256_bytes(mbytes), bytes=len(data),
                      instance_hash=h, composition=origin, geometry=GEOMETRY in files, filename=filename(inst))


def filename(inst: dict) -> str:
    import re
    slug = re.sub(r"[^a-z0-9]+", "-", str(inst.get("name") or inst.get("instance_id") or "scenario").lower()).strip("-")[:48]
    return f"move-openlab-scenario-{slug or 'scenario'}.zip"


# ---------------------------------------------------------------- verification and import
def is_package(data: bytes) -> bool:
    """Whether ``data`` looks like a scenario package (its manifest names this format). Nothing is verified."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        info = z.getinfo("manifest.json")
        if info.file_size > MAX_MEMBER_BYTES:
            return False
        man = json.loads(z.read(info))
        return isinstance(man, dict) and man.get("format") == FORMAT
    except (zipfile.BadZipFile, KeyError, ValueError, OSError, zlib.error, RuntimeError, EOFError):
        return False


def check_manifest(man: object) -> list[str]:
    if not isinstance(man, dict):
        return ["the manifest is not a JSON object"]
    errs = []
    for k, t in MANIFEST_SCHEMA["required"].items():
        if k not in man:
            errs.append(f"missing field {k!r}")
        elif not isinstance(man[k], t) or (t is str and not man[k]):
            errs.append(f"field {k!r} must be a {t.__name__}")
    for k, t in MANIFEST_SCHEMA["optional"].items():
        if man.get(k) is not None and not isinstance(man[k], t):
            errs.append(f"field {k!r} must be a {t.__name__}")
    if errs:
        return errs
    sc = man["scenario"]
    if not (isinstance(sc.get("instance_hash"), str) and HEX64.match(sc["instance_hash"])):
        errs.append("scenario.instance_hash must be a SHA-256 hex digest")
    if not isinstance(sc.get("instance_id"), str) or not isinstance(sc.get("name"), str):
        errs.append("scenario needs instance_id and name")
    if not isinstance(man["spec"].get("problem_id"), str):
        errs.append("spec.problem_id must be a string")
    if not all(isinstance(k, str) and isinstance(v, str) and HEX64.match(v) for k, v in man["files"].items()):
        errs.append("files must map member names to SHA-256 hex digests")
    return errs


def verify(ws, data: bytes) -> tuple[dict, dict, dict | None, dict | None, object]:
    """Complete verification, no side effect: (report, instance, validated composition, geometry, problem)."""
    try:
        return _verify(ws, data)
    except BenchError:
        raise
    except (zipfile.BadZipFile, zlib.error, KeyError, ValueError, TypeError, AttributeError, UnicodeDecodeError,
            EOFError, OSError, RuntimeError) as e:
        raise IntegrityError(f"scenario package unreadable or corrupted ({type(e).__name__})") from None


def _verify(ws, data: bytes):
    if len(data) > MAX_PACKAGE_BYTES:
        raise IntegrityError("scenario package too large")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise IntegrityError("not a valid ZIP package") from None
    infos = z.infolist()
    names = [i.filename for i in infos]
    if len(set(names)) != len(names):
        raise IntegrityError("duplicate package members")
    if any(n.startswith("/") or ".." in n.split("/") or "\\" in n or ":" in n for n in names):
        raise IntegrityError("unsafe package member names")
    unknown = sorted(set(names) - set(MEMBERS))
    if unknown:
        raise IntegrityError(f"unexpected member {unknown[0][:80]}: a scenario package holds only {', '.join(MEMBERS)}. "
                             "Nothing was imported.")
    if any(i.file_size > MAX_MEMBER_BYTES for i in infos) or sum(i.file_size for i in infos) > MAX_TOTAL_BYTES:
        raise IntegrityError("package member too large or package too large once uncompressed")
    if "manifest.json" not in names or "manifest.sha256" not in names:
        raise IntegrityError("manifest missing")
    mbytes = z.read("manifest.json")
    if sha256_bytes(mbytes) != z.read("manifest.sha256").decode().strip():
        raise IntegrityError("manifest digest mismatch")
    man = json.loads(mbytes)
    fmt = man.get("format") if isinstance(man, dict) else None
    if fmt != FORMAT:
        raise IntegrityError(f"unsupported scenario package format {fmt!r}: this installation reads {FORMAT}"
                             + ("; the package comes from a newer version of MOVE OpenLab — update this installation"
                                if isinstance(fmt, str) and fmt.startswith("move-openlab-scenario/") else ""))
    errs = check_manifest(man)
    if errs:
        raise IntegrityError("malformed manifest: " + "; ".join(errs[:3]))
    try:
        problem = ws.problem(man["spec"]["problem_id"])
    except BenchError:
        raise IntegrityError(f"problem {man['spec']['problem_id']!r} is not installed here") from None
    if man["spec"] != problem.spec_record() or man["validator_version"] != problem.validator_version:
        raise IntegrityError("problem / objective / constraint specification or validator differs from this installation")
    extra = set(names) - set(man["files"]) - {"manifest.json", "manifest.sha256"}
    if extra:
        raise IntegrityError(f"unlisted files in package: {sorted(extra)[:3]}")
    for name, digest in man["files"].items():
        if name not in (INSTANCE, COMPOSITION, GEOMETRY):
            raise IntegrityError(f"unexpected member {name[:80]} listed in the manifest")
        if name not in names:
            raise IntegrityError(f"listed file missing: {name}")
        if sha256_bytes(z.read(name)) != digest:
            raise IntegrityError(f"file checksum mismatch: {name}")
    if INSTANCE not in man["files"]:
        raise IntegrityError("the package holds no instance")
    inst = json.loads(z.read(INSTANCE))
    h = man["scenario"]["instance_hash"]
    ierrs = problem.check_instance(inst) if isinstance(inst, dict) else ["not an object"]
    if ierrs:
        raise IntegrityError(f"instance failed the problem's integrity checks: {ierrs[:3]}")
    if inst.get("instance_hash") != h or instance_hash(inst) != h or inst.get("problem_id") != problem.problem_id:
        raise IntegrityError("instance hash mismatch: the instance is not the one the manifest names")
    geometry = None
    if GEOMETRY in man["files"]:
        geometry = json.loads(z.read(GEOMETRY))
        if not is_ride(inst) or G.check(geometry, inst):
            raise IntegrityError("the replay geometry does not belong to the package's instance")
    nid = (inst.get("network") or {}).get("network_id")
    comp, origin, rebuilt, identical = None, None, False, None
    net, nprov = _network_installed(ws, nid) if is_ride(inst) else (None, None)
    if is_ride(inst):
        given = COMPOSITION in man["files"]
        raw = json.loads(z.read(COMPOSITION)) if given else composition_from_instance(inst)
        origin = ((man.get("composition") or {}).get("origin") or "unknown") if given else "instance"
        cerrs, comp = composition_errors(raw, inst)
        if cerrs:
            raise IntegrityError(f"the composition does not match the instance: {'; '.join(cerrs[:3])}")
        if net is not None:
            from .geo import scenarios as SC
            try:
                again = SC.build_instance(comp, net, nprov, inst["instance_id"])
            except ValueError as e:
                raise IntegrityError(f"the composition cannot be rebuilt on the installed road network: {e}") from None
            identical = again["instance_hash"] == h
            rebuilt = True
            if not identical:
                raise IntegrityError("rebuilt here on the installed road network, the composition gives a different "
                                     "instance (travel times or compatible pairs differ): the package is inconsistent")
    elif COMPOSITION in man["files"]:
        raise IntegrityError(f"a composition is not defined for problem {problem.problem_id}")
    counts = {k: len(inst[k]) for k in ("drivers", "riders", "pairs") if isinstance(inst.get(k), list)}
    editable = bool(is_ride(inst) and net is not None)
    report = dict(
        ok=True, kind="scenario", format=FORMAT, package_sha256=sha256_bytes(data), manifest_sha256=sha256_bytes(mbytes),
        bytes=len(data), files_checked=len(man["files"]), problem_id=problem.problem_id, problem_title=problem.title,
        spec_match=True, validator_version=problem.validator_version, created_at=man["created_at"],
        exported_by=man["exporter"].get("display"), exporter_installation=man["exporter"].get("installation"),
        scenario=dict(name=inst.get("name") or man["scenario"]["name"], instance_id=inst["instance_id"], instance_hash=h,
                      network_id=nid, **counts),
        instance=dict(verified=True, hash_recomputed=True),
        geometry=dict(included=geometry is not None, verified=geometry is not None,
                      legs=len((geometry or {}).get("legs") or {})),
        composition=dict(included=COMPOSITION in man["files"], origin=origin, consistent=comp is not None,
                         network_installed=net is not None, rebuilt=rebuilt, identical=identical) if is_ride(inst) else None,
        editable=editable,
        editing_note=(None if editable or not is_ride(inst) else EDITING_NEEDS_NETWORK),
        licences=man["licences"], provenance=man["provenance"], executable_code_in_package=False)
    return report, inst, comp, geometry, problem


def _existing(ws, problem_id: str, h: str, package_sha: str) -> dict | None:
    for s in ws.scenarios(problem_id):
        if s["instance_hash"] == h and s.get("source") == IMPORTED:
            try:
                rec = ws.scenario(s["scenario_id"])
            except NotFound:
                continue
            if (rec["scenario"].get("provenance") or {}).get("package_sha256") == package_sha:
                return rec
    return None


def import_(ws, data: bytes) -> dict:
    """Verify, then add the scenario to this account's library (the instance is content-addressed and immutable; the
    replay geometry goes to this workspace). Importing the same package again adds nothing."""
    report, inst, comp, geometry, problem = verify(ws, data)
    with _lock:
        have = _existing(ws, problem.problem_id, inst["instance_hash"], report["package_sha256"])
        if have is None:
            original = (comp or {}).get("provenance") or inst.get("provenance") or {}
            prov = dict(source=IMPORTED, package_sha256=report["package_sha256"], package_format=FORMAT,
                        imported_at=now(), exported_by=report["exported_by"],
                        exporter_installation=report["exporter_installation"],
                        rebuilt_here=bool((report["composition"] or {}).get("rebuilt")), original=original)
            sc = dict(comp, provenance=prov) if comp else dict(name=report["scenario"]["name"], provenance=prov)
            if geometry is not None:
                G.GeometryStore(ws.root).put(geometry)
            have = ws.save_scenario(problem, sc, inst)
            report["already_present"] = False
        else:
            if geometry is not None and G.GeometryStore(ws.root).get(inst["instance_hash"]) is None:
                G.GeometryStore(ws.root).put(geometry)
            report["already_present"] = True
    report.update(scenario_id=have["scenario_id"], imported_at=(have["scenario"].get("provenance") or {}).get("imported_at"))
    return report
