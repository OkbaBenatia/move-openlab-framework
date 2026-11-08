"""Portable experiment bundles: export, complete verification, import.

A bundle is a ZIP archive without executable code::

  manifest.json             what the bundle contains and how to check it (below)
  manifest.sha256           SHA-256 of manifest.json
  campaigns/<cid>.json      the locked campaign and its whole lineage (each with its checksum)
  instances/<hash>.json     every content-addressed instance used (frozen participants and travel times)
  geometry/<hash>.json      format 2, optional: replay polylines of an instance (see :mod:`.geo.geometry`)

Format 2 manifest (format 1 bundles are still imported; they lack the fields marked ²)::

  format, created_at, exported_by, exporter_installation, root_campaign_id
  spec, validator_version, synthetic
  problem²                 objective levels, metric definitions, evaluation contract, decision description
  scenarios²               per instance: id, name, size, seed/generator, dataset and network references
  networks²                road-network references: id, profile, OSM data timestamp, raw-response SHA-256, builder,
                           licence (the network itself is not shipped; travel times are in the instances)
  datasets²                dataset provenance: provider, release or source hash, licence, attribution
  campaigns                id, kind, checksum, owner; ² relation to parent, configuration, result summary
  lineage²                 [root, parent, ...] with relations
  methods                  id, version, source, plugin code hash; ² configuration per campaign
  environment_requirements, environments²   requirements and the recorded execution environments
  fingerprints²            experiment fingerprint (what was run) and semantic fingerprint (which problem)
  files                    SHA-256 of every other member

Verification refuses, before anything is written: unknown formats, unlisted or missing members, any digest mismatch,
unsafe names, oversized archives, instances failing the problem's checks, campaigns failing their checksum, broken
lineage, a problem / validator that differs from this installation, and (format 2) fingerprints that do not match the
recomputed ones or geometry that does not belong to its instance.
"""
from __future__ import annotations

import io
import json
import zipfile
import zlib

from . import __version__, registry
from .comparability.model import evaluation_fingerprint, problem_fingerprint
from .geo import geometry as G
from .hashing import canonical, sha256, sha256_bytes
from .methods import ContractError
from .problem import Problem
from .store import MAX_BUNDLE_BYTES, SAFE_ID, BenchError, IntegrityError, _lock, _write, campaign_checksum, now, problem_for

FORMAT_V1 = "move-openlab-bundle/1"
FORMAT_V2 = "move-openlab-bundle/2"
FORMATS = (FORMAT_V1, FORMAT_V2)
MAX_MEMBERS = 5000
MAX_MEMBER_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024                 # sum of uncompressed members (decompression bombs)
ZIP_TIME = (2026, 1, 1, 0, 0, 0)                    # fixed member timestamps: identical content -> identical bundle
DATASET_KEYS = ("source", "provider", "dataset_key", "release", "licence", "attribution", "source_sha256")
NETWORK_KEYS = ("network_id", "profile", "builder", "nodes", "edges", "network_sha256", "licence")


def experiment_fingerprint(chain: list[dict]) -> str:
    """What was run: problem, validator, instances, methods and configuration of every campaign of the lineage
    (results, owners and timestamps excluded)."""
    return sha256([dict(spec={k: c["spec"].get(k) for k in ("problem_id", "problem_spec_version", "objective_spec_id",
                                                             "constraint_spec_id", "instance_schema",
                                                             "validator_version")},
                        kind=c["kind"], instances=sorted(c["scenario_set"]["instance_hashes"]),
                        methods=sorted([m["method_id"], m["version"], m.get("code_sha256") or ""] for m in c["methods"]),
                        config=c["config"]) for c in chain])


def semantic_fingerprint(problem: Problem, instances: list[dict]) -> str:
    """Which optimization problem: the problem fingerprints of the instances and the evaluation contract."""
    fps = sorted(problem_fingerprint(problem, i, problem.objective_spec_id)["problem"] for i in instances)
    return sha256(dict(problems=fps, evaluation=evaluation_fingerprint(problem.evaluation_contract())))


def _scenario_entry(inst: dict) -> dict:
    prov = inst.get("provenance") or {}
    nw = inst.get("network") or {}
    out = dict(instance_hash=inst["instance_hash"], instance_id=inst["instance_id"], name=inst.get("name"),
               source=prov.get("source"), generator=prov.get("generator"), seed=prov.get("seed"),
               dataset_key=prov.get("dataset_key"), network_id=nw.get("network_id"),
               derivation=(inst.get("derivation") or {}).get("variant"))
    for k in ("drivers", "riders", "pairs"):
        if isinstance(inst.get(k), list):
            out[k] = len(inst[k])
    return {k: v for k, v in out.items() if v is not None}


def _network_ref(network_store, nid: str) -> dict:
    try:
        prov = network_store.provenance(nid)
    except KeyError:
        return dict(network_id=nid, available_at_export=False)
    src = prov.get("source") or {}
    out = {k: prov.get(k) for k in NETWORK_KEYS}
    out.update(bbox=(prov.get("area") or {}).get("bbox"), service=src.get("service"),
               osm_timestamp=src.get("osm_timestamp"), raw_sha256=src.get("raw_sha256"),
               retrieved_at=src.get("retrieved_at"), available_at_export=True)
    return out


def export(ws, cid: str) -> tuple[bytes, dict]:
    from .geo.osm import NetworkStore
    chain = ws.lineage(cid)
    if not all(c.get("checksum") for c in chain):
        raise BenchError("lock the campaign before exporting it")
    problem = problem_for(chain[0])
    hashes = sorted({h for c in chain for h in c["scenario_set"]["instance_hashes"]})
    instances = {h: ws.inst.get_instance(h) for h in hashes}
    files: dict[str, bytes] = {f"campaigns/{c['campaign_id']}.json": canonical(c) for c in chain}
    for h, inst in instances.items():
        files[f"instances/{h}.json"] = canonical(inst)
    nets = NetworkStore(ws.inst.data)
    gstore = G.GeometryStore(ws.root)
    net_ids = sorted({(i.get("network") or {}).get("network_id") for i in instances.values()} - {None, ""})
    loaded = {}
    for h, inst in instances.items():
        nid = (inst.get("network") or {}).get("network_id")
        if not nid or "pairs" not in inst:
            continue
        try:                                            # the installed network first, imported geometry otherwise
            if nid not in loaded:
                loaded[nid] = nets.load(nid)
            doc = G.build(inst, loaded[nid])
        except (KeyError, ValueError):
            doc = gstore.get(h)
        if doc and doc["legs"]:
            files[f"geometry/{h}.json"] = canonical(doc)
    datasets = {}
    for inst in instances.values():
        prov = inst.get("provenance") or {}
        if prov.get("dataset_key"):
            datasets[prov["dataset_key"]] = {k: prov.get(k) for k in DATASET_KEYS if prov.get(k) is not None}
    methods = sorted({(m["method_id"], m["version"], m["source"], m.get("code_sha256") or "")
                      for c in chain for m in c["methods"]})
    manifest = dict(
        format=FORMAT_V2, created_at=now(), exported_by=ws.display, exporter_installation=ws.inst.id,
        root_campaign_id=cid, spec=problem.spec_record(), validator_version=problem.validator_version,
        synthetic=problem.synthetic,
        problem=dict(title=problem.title, objective=[o.to_dict() for o in problem.objective],
                     metrics=[m.to_dict() for m in problem.metrics], evaluation=problem.evaluation_contract(),
                     decisions=problem.decision_description),
        scenarios=[_scenario_entry(instances[h]) for h in hashes],
        networks=[_network_ref(nets, n) for n in net_ids],
        datasets=[datasets[k] for k in sorted(datasets)],
        campaigns=[dict(campaign_id=c["campaign_id"], kind=c["kind"], checksum=c["checksum"],
                        owner_display=c["owner_display"], title=c["title"],
                        relation=(c.get("parent") or {}).get("relation"), config=c["config"],
                        results=dict(runs=len(c["runs"]), accepted=sum(1 for r in c["runs"] if r.get("accepted")),
                                     locked_at=c.get("locked_at")),
                        variant=(c.get("semantic_variant") or {}).get("variant")) for c in chain],
        lineage=[dict(campaign_id=c["campaign_id"], kind=c["kind"],
                      parent=(c.get("parent") or {}).get("campaign_id"),
                      relation=(c.get("parent") or {}).get("relation")) for c in chain],
        instances=hashes,
        methods=[dict(method_id=a, version=b, source=s, code_sha256=h or None) for a, b, s, h in methods],
        environment_requirements=dict(python=">=3.11", framework=__version__, **problem.environment(),
                                      note="methods are resolved from trusted local installations by id, version and "
                                           "code hash; the bundle contains no executable code"),
        environments=[dict(campaign_id=c["campaign_id"], environment=c.get("environment")) for c in chain],
        fingerprints=dict(experiment=experiment_fingerprint(chain),
                          semantic=semantic_fingerprint(problem, [instances[h] for h in hashes])),
        files={k: sha256_bytes(v) for k, v in sorted(files.items())})
    mbytes = canonical(manifest)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in sorted(files.items()):
            z.writestr(zipfile.ZipInfo(k, date_time=ZIP_TIME), v)
        z.writestr(zipfile.ZipInfo("manifest.json", date_time=ZIP_TIME), mbytes)
        z.writestr(zipfile.ZipInfo("manifest.sha256", date_time=ZIP_TIME), sha256_bytes(mbytes))
    data = buf.getvalue()
    return data, dict(bundle_sha256=sha256_bytes(data), manifest_sha256=sha256_bytes(mbytes), bytes=len(data),
                      campaigns=[c["campaign_id"] for c in chain], instances=len(hashes),
                      geometry=sum(k.startswith("geometry/") for k in files))


def verify(ws, data: bytes) -> tuple[dict, dict, dict, Problem, dict]:
    """Full verification, no side effect. Any low-level archive or parsing failure is an integrity failure."""
    try:
        return _verify(ws, data)
    except BenchError:
        raise
    except (zipfile.BadZipFile, zlib.error, KeyError, ValueError, TypeError, AttributeError, UnicodeDecodeError,
            EOFError, OSError, RuntimeError) as e:
        raise IntegrityError(f"bundle unreadable or corrupted ({type(e).__name__})") from None


def _verify(ws, data: bytes):
    if len(data) > MAX_BUNDLE_BYTES:
        raise IntegrityError("bundle too large")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise IntegrityError("not a valid ZIP bundle") from None
    infos = z.infolist()
    names = [i.filename for i in infos]
    if len(names) > MAX_MEMBERS or len(set(names)) != len(names):
        raise IntegrityError("too many or duplicate bundle members")
    if any(n.startswith("/") or ".." in n.split("/") or "\\" in n or ":" in n for n in names):
        raise IntegrityError("unsafe bundle member names")
    if any(i.file_size > MAX_MEMBER_BYTES for i in infos) or sum(i.file_size for i in infos) > MAX_TOTAL_BYTES:
        raise IntegrityError("bundle member too large or bundle too large once uncompressed")
    if "manifest.json" not in names or "manifest.sha256" not in names:
        raise IntegrityError("manifest missing")
    mbytes = z.read("manifest.json")
    if sha256_bytes(mbytes) != z.read("manifest.sha256").decode().strip():
        raise IntegrityError("manifest digest mismatch")
    man = json.loads(mbytes)
    fmt = man.get("format")
    if fmt not in FORMATS:
        raise IntegrityError(f"unsupported bundle format {fmt!r}")
    try:
        problem = registry.get(man["spec"]["problem_id"])
    except registry.UnknownProblem:
        raise IntegrityError(f"problem {man['spec']['problem_id']!r} is not installed here") from None
    if man["spec"] != problem.spec_record() or man.get("validator_version") != problem.validator_version:
        raise IntegrityError("problem / objective / constraint specification or validator differs from this installation")
    extra = set(names) - set(man["files"]) - {"manifest.json", "manifest.sha256"}
    if extra:
        raise IntegrityError(f"unlisted files in bundle: {sorted(extra)[:3]}")
    prefixes = ("campaigns/", "instances/") + (("geometry/",) if fmt == FORMAT_V2 else ())
    for name, digest in man["files"].items():
        if name not in names:
            raise IntegrityError(f"listed file missing: {name}")
        if not name.startswith(prefixes) or not name.endswith(".json"):
            raise IntegrityError(f"unexpected member {name}")
        if sha256_bytes(z.read(name)) != digest:
            raise IntegrityError(f"file checksum mismatch: {name}")
    instances = {}
    for h in man["instances"]:
        inst = json.loads(z.read(f"instances/{h}.json"))
        errs = problem.check_instance(inst)
        if errs or inst.get("instance_hash") != h:
            raise IntegrityError(f"instance {h[:12]} failed integrity checks: {errs or 'hash mismatch'}")
        instances[h] = inst
    geometry = {}
    for name in man["files"]:
        if name.startswith("geometry/"):
            h = name[len("geometry/"):-len(".json")]
            doc = json.loads(z.read(name))
            if h not in instances or G.check(doc, instances[h]):
                raise IntegrityError(f"replay geometry {h[:12]} does not belong to an instance of the bundle")
            geometry[h] = doc
    campaigns = {}
    for ent in man["campaigns"]:
        if not SAFE_ID.match(str(ent["campaign_id"])):
            raise IntegrityError("unsafe campaign identifier")
        c = json.loads(z.read(f"campaigns/{ent['campaign_id']}.json"))
        if not c.get("checksum") or campaign_checksum(c) != c["checksum"] or c["checksum"] != ent["checksum"]:
            raise IntegrityError(f"campaign {ent['campaign_id']} fails its checksum")
        if c.get("campaign_id") != ent["campaign_id"] or c["spec"]["problem_id"] != problem.problem_id:
            raise IntegrityError(f"campaign {ent['campaign_id']} does not match its manifest entry")
        if set(c["scenario_set"]["instance_hashes"]) - set(instances):
            raise IntegrityError(f"campaign {ent['campaign_id']} references instances missing from the bundle")
        campaigns[c["campaign_id"]] = c
    if man["root_campaign_id"] not in campaigns:
        raise IntegrityError("root campaign missing from the bundle")
    chain, cur = [], campaigns[man["root_campaign_id"]]
    while cur is not None and cur not in chain:
        chain.append(cur)
        cur = campaigns.get((cur.get("parent") or {}).get("campaign_id"))
    if len(chain) != len(campaigns):
        raise IntegrityError("the bundle contains campaigns outside the root campaign's lineage")
    for c in campaigns.values():
        p = c.get("parent")
        if p and (p["campaign_id"] not in campaigns or campaigns[p["campaign_id"]]["checksum"] != p["checksum"]):
            raise IntegrityError(f"lineage of {c['campaign_id']} is incomplete or inconsistent in the bundle")
    fingerprints = None
    if fmt == FORMAT_V2:
        fingerprints = dict(experiment=experiment_fingerprint(chain),
                            semantic=semantic_fingerprint(problem, [instances[h] for h in man["instances"]]))
        if man.get("fingerprints") != fingerprints:
            raise IntegrityError("experiment or semantic fingerprint differs from the recomputed one")
    avail = []
    for m in man["methods"]:
        try:
            ws.resolve_method(problem, m)
            ok, why = True, None
        except ContractError as e:
            ok, why = False, str(e)
        avail.append(dict(m, available_locally=ok, reason=why))
    report = dict(ok=True, bundle_sha256=sha256_bytes(data), manifest_sha256=sha256_bytes(mbytes),
                  format=fmt, problem_id=problem.problem_id, exported_by=man["exported_by"],
                  exporter_installation=man["exporter_installation"], root_campaign_id=man["root_campaign_id"],
                  files_checked=len(man["files"]), instances_verified=len(instances),
                  geometry_verified=len(geometry), fingerprints=fingerprints,
                  networks=man.get("networks") or [], datasets=man.get("datasets") or [],
                  campaigns_verified=[dict(campaign_id=k, kind=v["kind"], checksum=v["checksum"], title=v["title"])
                                      for k, v in campaigns.items()],
                  spec_match=True, methods=avail, executable_code_in_bundle=False)
    return report, campaigns, instances, problem, geometry


def import_(ws, data: bytes) -> dict:
    report, campaigns, instances, problem, geometry = verify(ws, data)
    with _lock:
        for cid, c in campaigns.items():                            # refuse before writing anything
            f = ws._cdir(cid) / "campaign.json"
            if f.exists() and json.loads(f.read_text()).get("checksum") != c["checksum"]:
                raise IntegrityError(f"a different campaign {cid} already exists in this workspace")
        for inst in instances.values():
            ws.inst.put_instance(problem, inst)
        gstore = G.GeometryStore(ws.root)
        for doc in geometry.values():
            gstore.put(doc)
        for cid, c in campaigns.items():
            d = ws._cdir(cid)
            if (d / "campaign.json").exists():
                continue
            _write(d / "campaign.json", c)
            _write(d / "import_record.json", dict(imported_at=now(), imported_by=ws.display,
                                                  into_installation=ws.inst.id, bundle_sha256=report["bundle_sha256"],
                                                  bundle_format=report["format"], verified_checksum=c["checksum"],
                                                  original_owner_display=c["owner_display"],
                                                  original_installation=c["installation_id"]))
    report["imported_at"] = now()
    return report
