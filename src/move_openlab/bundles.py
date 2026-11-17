"""Portable experiment bundles: export, complete verification, import.

A bundle is a ZIP archive without executable code::

  manifest.json             what the bundle contains and how to check it (below)
  manifest.sha256           SHA-256 of manifest.json
  campaigns/<cid>.json      the locked campaign and its whole lineage (each with its checksum)
  instances/<hash>.json     every content-addressed instance used (frozen participants and travel times)
  geometry/<hash>.json      format 2, optional: replay polylines of an instance (see :mod:`.geo.geometry`)
  evidence/report.json      format 2, optional³: the evidence report (validation, reproducibility, comparability,
                            fingerprints, results) — informative, cross-checked against the bundle on import

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
  vehicles³                every vehicle profile frozen in the instances (parameters, units, provenance)
  emissions³               emission configuration per campaign (scope, baseline) and the domain descriptors
  fingerprints²            experiment fingerprint (what was run) and semantic fingerprint (which problem; ³ plus
                           the domain descriptors when the instances carry vehicle data)
  evidence³                present when evidence/report.json is: its path and format
  files                    SHA-256 of every other member

What each checksum protects:

  manifest.sha256          the manifest bytes; the manifest lists the SHA-256 of every other member, so this one
                           digest covers the whole bundle content (an edited, added or removed member is detected)
  files[<member>]          one member (campaign, instance, replay geometry, evidence report)
  campaign checksum        a campaign record and its runs (recomputed from the record; the manifest repeats it)
  fingerprints             recomputed from the campaigns and instances: what was run and which problem it solves
  bundle SHA-256           the ZIP file as a whole, shown at export and import, to compare with the exporter's value

Checksums detect corruption and inconsistent edits; they are not signatures. Whoever rewrites a member and
recomputes every digest produces a different bundle, recognisable only by its bundle SHA-256 — compare it with the
value the exporter communicated, and reproduce the results to check them independently.

Every manifest is checked against :data:`MANIFEST_SCHEMA` (required fields and their types) before it is used.

³ added in a later format-2 revision; absent from older format-2 bundles, which keep verifying identically.

Verification refuses, before anything is written: unknown formats, unlisted or missing members, any digest mismatch,
unsafe names, oversized archives, instances failing the problem's checks, campaigns failing their checksum, broken
lineage, a problem / validator that differs from this installation, and (format 2) fingerprints that do not match the
recomputed ones or geometry that does not belong to its instance.
"""
from __future__ import annotations

import io
import json
import re
import zipfile
import zlib

from . import __version__
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


def zip_member(name: str, date_time=ZIP_TIME) -> zipfile.ZipInfo:
    """A ZIP entry whose bytes do not depend on the operating system: fixed time, and "made by" Unix (Python records
    the creating system — 0 on Windows, 3 elsewhere — so the same files would otherwise give different archives)."""
    z = zipfile.ZipInfo(name, date_time=date_time)
    z.create_system = 3
    return z
EVIDENCE = "evidence/report.json"
# Imported ML evaluation evidence of the exported experiments (optional section of a format 2 bundle).
ML_DIR = "ml_evaluations/"
ML_INDEX = "ml_evaluations/index.json"
ML_SECTION_FORMAT = "move-openlab/ml-evaluation-section@1"
ML_MODES = ("full", "reference", "none")
ML_NOT_RECOMPUTABLE = ("exported as a reference: the predictions and labels were not included, so the importer cannot "
                       "recompute these figures; they are shown as the exporter recorded them")
EVIDENCE_FORMAT = "move-openlab-evidence/1"
DATASET_KEYS = ("source", "provider", "dataset_key", "release", "licence", "attribution", "source_sha256")
HEX64 = re.compile(r"^[0-9a-f]{64}\Z")
# required manifest fields and their types (format 1 and 2); optional fields are type-checked when present
MANIFEST_SCHEMA = dict(
    required=dict(format=str, exported_by=str, exporter_installation=str, root_campaign_id=str, spec=dict,
                  validator_version=str, campaigns=list, instances=list, methods=list, files=dict),
    required_v2=dict(fingerprints=dict),
    optional=dict(created_at=str, synthetic=bool, problem=dict, scenarios=list, networks=list, datasets=list,
                  lineage=list, environment_requirements=dict, environments=list, vehicles=list, emissions=dict,
                  evidence=dict))


def check_manifest(man: object) -> list[str]:
    """Schema errors of a manifest (empty when its structure is sound). Contents are verified afterwards."""
    if not isinstance(man, dict):
        return ["the manifest is not a JSON object"]
    errs = []
    req = dict(MANIFEST_SCHEMA["required"], **(MANIFEST_SCHEMA["required_v2"] if man.get("format") == FORMAT_V2 else {}))
    for k, t in req.items():
        if k not in man:
            errs.append(f"missing field {k!r}")
        elif not isinstance(man[k], t) or (t is str and not man[k]):
            errs.append(f"field {k!r} must be a non-empty {t.__name__}" if t is str else f"field {k!r} must be a {t.__name__}")
    for k, t in MANIFEST_SCHEMA["optional"].items():
        if man.get(k) is not None and not isinstance(man[k], t):
            errs.append(f"field {k!r} must be a {t.__name__}")
    if errs:
        return errs
    if not isinstance(man["spec"].get("problem_id"), str):
        errs.append("spec.problem_id must be a string")
    if not all(isinstance(h, str) and HEX64.match(h) for h in man["instances"]):
        errs.append("instances must be SHA-256 hex digests")
    if not all(isinstance(k, str) and isinstance(v, str) and HEX64.match(v) for k, v in man["files"].items()):
        errs.append("files must map member names to SHA-256 hex digests")
    for c in man["campaigns"]:
        if not (isinstance(c, dict) and all(isinstance(c.get(k), str) and c.get(k) for k in ("campaign_id", "kind", "checksum"))):
            errs.append("each campaign entry needs campaign_id, kind and checksum")
            break
    for m in man["methods"]:
        if not (isinstance(m, dict) and isinstance(m.get("method_id"), str) and isinstance(m.get("version"), str)):
            errs.append("each method entry needs method_id and version")
            break
    if man["format"] == FORMAT_V2 and not all(isinstance(man["fingerprints"].get(k), str) for k in ("experiment", "semantic")):
        errs.append("fingerprints must give the experiment and semantic fingerprints")
    return errs
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


def domain_descriptors(problem: Problem, instances: dict[str, dict], chain: list[dict]) -> list[dict]:
    """Domain descriptors (e.g. emission configuration) of every campaign x instance that carries one."""
    out = []
    for c in chain:
        for h in c["scenario_set"]["instance_hashes"]:
            d = problem.domain_descriptor(instances[h], c["config"])
            if d:
                out.append(dict(campaign_id=c["campaign_id"], instance_hash=h,
                                **{k: d.get(k) for k in ("scope", "baseline", "unit", "basis", "fingerprint")}))
    return out


def semantic_fingerprint(problem: Problem, instances: dict[str, dict], chain: list[dict]) -> str:
    """Which optimization problem: the problem fingerprints of the instances and the evaluation contract — plus, when
    the instances carry domain data (vehicles, emission parameters), the domain descriptors of every campaign.
    Bundles without domain data keep the fingerprint they had before the domain component existed."""
    fps = sorted(problem_fingerprint(problem, i, problem.objective_spec_id)["problem"] for i in instances.values())
    d = dict(problems=fps, evaluation=evaluation_fingerprint(problem.evaluation_contract()))
    dom = sorted({x["fingerprint"] for x in domain_descriptors(problem, instances, chain)})
    if dom:
        d["domain"] = dom
    return sha256(d)


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
    vehicles = sorted({d["vehicle"]["id"] for d in inst.get("drivers", []) if isinstance(d.get("vehicle"), dict)})
    if vehicles:
        out["vehicles"] = vehicles
    return {k: v for k, v in out.items() if v is not None}


def _vehicle_profiles(instances: dict[str, dict]) -> list[dict]:
    """Every distinct vehicle profile frozen in the instances (values, units and provenance as recorded)."""
    seen: dict[str, dict] = {}
    for inst in instances.values():
        default = (inst.get("vehicles") or {}).get("default")
        for p in [d.get("vehicle") for d in inst.get("drivers", [])] + [default]:
            if isinstance(p, dict):
                seen.setdefault(sha256(p), p)
    return [seen[k] for k in sorted(seen)]


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


def preview(ws, cid: str) -> dict:
    """What an export of ``cid`` would contain, without building it (and without requiring the lock): the records of
    the lineage, scenarios, references, methods, vehicle and emission parameters, and how many scenarios can carry
    replay geometry. Used by the export dialog."""
    from .geo.osm import NetworkStore
    chain = ws.lineage(cid)
    problem = problem_for(chain[0])
    hashes = sorted({h for c in chain for h in c["scenario_set"]["instance_hashes"]})
    instances = {h: ws.inst.get_instance(h) for h in hashes}
    nets, gstore = NetworkStore(ws.inst.data), G.GeometryStore(ws.root)
    net_ids = sorted({(i.get("network") or {}).get("network_id") for i in instances.values()} - {None, ""})
    stored = {n for n in net_ids if _network_present(nets, n)}
    geo_ok = sum(1 for h, inst in instances.items() if "pairs" in inst and (inst.get("network") or {}).get("network_id")
                 and ((inst.get("network") or {}).get("network_id") in stored or gstore.get(h)))
    datasets = {}
    for inst in instances.values():
        prov = inst.get("provenance") or {}
        if prov.get("dataset_key"):
            datasets[prov["dataset_key"]] = {k: prov.get(k) for k in DATASET_KEYS if prov.get(k) is not None}
    methods = sorted({(m["method_id"], m["version"], m["source"]) for c in chain for m in c["methods"]})
    return dict(
        campaign_id=cid, locked=all(c.get("checksum") for c in chain), format=FORMAT_V2,
        problem=dict(problem_id=problem.problem_id, title=problem.title, validator_version=problem.validator_version),
        campaigns=[dict(campaign_id=c["campaign_id"], title=c["title"], kind=c["kind"], locked=bool(c.get("checksum")),
                        relation=(c.get("parent") or {}).get("relation"), runs=len(c["runs"]),
                        accepted=sum(1 for r in c["runs"] if r.get("accepted"))) for c in chain],
        scenarios=[_scenario_entry(instances[h]) for h in hashes],
        networks=[_network_ref(nets, n) for n in net_ids], datasets=[datasets[k] for k in sorted(datasets)],
        methods=[dict(method_id=a, version=b, source=s) for a, b, s in methods],
        vehicles=len(_vehicle_profiles(instances)),
        emissions=[dict(campaign_id=c["campaign_id"], **c["config"]["emissions"]) for c in chain if c["config"].get("emissions")],
        geometry=dict(available=geo_ok, scenarios=len(hashes)),
        ml_evaluations=_ml_preview(ws, chain))


def _ml_preview(ws, chain: list[dict]) -> dict:
    """How much imported ML evaluation evidence the records have (for the export dialog)."""
    from .ml_evidence import EvidenceStore
    store = EvidenceStore(ws.root)
    items = [e for c in chain for e in store.entries(c["campaign_id"])
             if e["method_id"] in {m["method_id"] for m in c["methods"]}]
    return dict(documents=sum(1 for e in items if not e.get("reference_only")),
                references=sum(1 for e in items if e.get("reference_only")),
                records=sum(int(e.get("records") or 0) for e in items))


def _network_present(nets, nid: str) -> bool:
    try:
        nets.provenance(nid)
        return True
    except (KeyError, ValueError, OSError):
        return False


def _ml_summary(ev: dict) -> dict:
    """The recorded figures of an evaluation (its recorded decision), as compared at import."""
    r = ev["recorded_decision"]
    return dict(rule=r["rule"], threshold=r["threshold"], policy=r.get("policy"), decision=r["decision"],
                confusion=dict(r["confusion"]), metrics=dict(r["metrics"]), metric_reasons=dict(r["metric_reasons"]))


def ml_section(ws, chain: list[dict], mode: str) -> tuple[dict[str, bytes], dict | None]:
    """The imported ML evaluation evidence of the exported records (``ml_evaluations/``). ``full``: the evidence
    documents themselves (predictions, labels, provenance) — the importer recomputes every figure; ``reference``: only
    their provenance, decision, metric definitions, recorded figures and SHA-256 — not recomputable by the importer;
    ``none``: nothing. Withdrawn evidence is never exported. Adapter-provided evaluations (a problem package's own) are
    not exported: they come from the problem package installed at the other end."""
    if mode not in ML_MODES:
        raise BenchError(f"ml_evidence must be one of {', '.join(ML_MODES)}")
    if mode == "none":
        return {}, None
    from .analysis import ml_evaluation as ML
    from .ml_evidence import EvidenceStore
    store, files, entries = EvidenceStore(ws.root), {}, []
    for c in chain:
        methods = {m["method_id"] for m in c["methods"]}
        for e in store.entries(c["campaign_id"]):
            if e["method_id"] not in methods:
                continue
            if e.get("reference_only"):                  # came as a reference: it can only travel on as a reference
                r = e["reference"]
                entries.append(dict(r, campaign_id=c["campaign_id"], method_id=e["method_id"], evidence_sha256=e["sha256"],
                                    evidence_format=ML.FORMAT, source=dict(e["source"]), included=False, recomputable=False,
                                    file=None, reason=ML_NOT_RECOMPUTABLE))
                continue
            data = store.read(c["campaign_id"], e["sha256"])                 # verified against its SHA-256
            doc = ML.validate(ML.parse_json(data))
            ev = ML.evaluate(doc)
            full = mode == "full"
            entries.append(dict(
                campaign_id=c["campaign_id"], method_id=e["method_id"], evidence_sha256=e["sha256"], evidence_format=ML.FORMAT,
                records=ev["records"], positives=ev["positives"], dataset=dict(doc["dataset"]), positive_label=doc["positive_label"],
                decision=dict(doc["decision"]), model=dict(doc["model"]), feature_pipeline=dict(doc["feature_pipeline"]),
                notes=list(doc["notes"]), has_scores=ev["has_scores"], imported_by=e["imported_by"], imported_at=e["imported_at"],
                source=dict(name=e["source"].get("name"), sha256=e["source"].get("sha256"), kind=e["source"].get("kind")),
                recorded=_ml_summary(ev), included=full, recomputable=full,
                file=f"{ML_DIR}{e['sha256']}.json" if full else None, reason=None if full else ML_NOT_RECOMPUTABLE))
            if full:
                files[f"{ML_DIR}{e['sha256']}.json"] = data
    if not entries:
        return {}, None
    index = dict(format=ML_SECTION_FORMAT, mode=mode, evidence_format=ML.FORMAT,
                 metric_definitions=[dict(id=m.id, label=m.label, description=m.description, needs_scores=m.needs_scores,
                                          source=m.source) for m in ML.metric_registry().values()],
                 entries=entries)
    files[ML_INDEX] = canonical(index)
    return files, dict(file=ML_INDEX, format=ML_SECTION_FORMAT, mode=mode, entries=len(entries),
                       recomputable=mode == "full",
                       note=("evidence documents included: the importer re-validates them and recomputes every figure"
                             if mode == "full" else ML_NOT_RECOMPUTABLE))


def export(ws, cid: str, geometry: bool = True, evidence: dict | None = None, ml_evidence: str = "full") -> tuple[bytes, dict]:
    """Build the bundle of ``cid`` and its lineage. ``geometry=False`` leaves out the optional replay polylines (the
    importer can still verify, reproduce and compare; routes then replay only where the road network is installed).
    ``evidence`` (the evidence report of ``cid``) is stored as ``evidence/report.json``: one file to share.
    ``ml_evidence`` says what of the imported ML evaluation evidence goes in (:func:`ml_section`); an experiment without
    any gives the same bundle whatever the value."""
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
        if not geometry or not nid or "pairs" not in inst:
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
    if evidence is not None:
        files[EVIDENCE] = canonical(evidence)
    ml_files, ml_entry = ml_section(ws, chain, ml_evidence)
    files.update(ml_files)
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
        vehicles=_vehicle_profiles(instances),
        emissions=dict(configurations=[dict(campaign_id=c["campaign_id"], **c["config"]["emissions"]) for c in chain
                                       if c["config"].get("emissions")],
                       descriptors=domain_descriptors(problem, instances, chain),
                       note="editable parameters and their provenance are frozen inside the instances (drivers' "
                            "vehicle and vehicles.default); figures are recomputed from validated decisions"),
        fingerprints=dict(experiment=experiment_fingerprint(chain), semantic=semantic_fingerprint(problem, instances, chain)),
        **(dict(evidence=dict(file=EVIDENCE, format=evidence.get("format"),
                              note="informative report of the exporting installation; the importer verifies the records "
                                   "and recomputes the fingerprints itself")) if evidence is not None else {}),
        **(dict(ml_evaluations=ml_entry) if ml_entry else {}),
        files={k: sha256_bytes(v) for k, v in sorted(files.items())})
    mbytes = canonical(manifest)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in sorted(files.items()):
            z.writestr(zip_member(k), v)
        z.writestr(zip_member("manifest.json"), mbytes)
        z.writestr(zip_member("manifest.sha256"), sha256_bytes(mbytes))
    data = buf.getvalue()
    return data, dict(bundle_sha256=sha256_bytes(data), manifest_sha256=sha256_bytes(mbytes), bytes=len(data),
                      campaigns=[c["campaign_id"] for c in chain], instances=len(hashes),
                      geometry=sum(k.startswith("geometry/") for k in files), evidence=EVIDENCE in files,
                      ml_evaluations=dict(mode=ml_entry["mode"], entries=ml_entry["entries"]) if ml_entry else None)


def verify(ws, data: bytes) -> tuple[dict, dict, dict, Problem, dict]:
    """Full verification, no side effect. Any low-level archive or parsing failure is an integrity failure."""
    return _verify_all(ws, data)[:5]


def _verify_all(ws, data: bytes):
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
    fmt = man.get("format") if isinstance(man, dict) else None
    if fmt not in FORMATS:
        newer = isinstance(fmt, str) and fmt.startswith("move-openlab-bundle/")
        raise IntegrityError(f"unsupported bundle format {fmt!r}: this installation reads {', '.join(FORMATS)}"
                             + ("; the bundle comes from a newer version of MOVE OpenLab — update this installation"
                                if newer else ""))
    errs = check_manifest(man)
    if errs:
        raise IntegrityError("malformed manifest: " + "; ".join(errs[:3]))
    try:                                # a restricted problem not granted to this account: as if not installed
        problem = ws.problem(man["spec"]["problem_id"])
    except BenchError:
        raise IntegrityError(f"problem {man['spec']['problem_id']!r} is not installed here") from None
    if man["spec"] != problem.spec_record() or man.get("validator_version") != problem.validator_version:
        raise IntegrityError("problem / objective / constraint specification or validator differs from this installation")
    extra = set(names) - set(man["files"]) - {"manifest.json", "manifest.sha256"}
    if extra:
        raise IntegrityError(f"unlisted files in bundle: {sorted(extra)[:3]}")
    prefixes = ("campaigns/", "instances/") + (("geometry/", ML_DIR) if fmt == FORMAT_V2 else ())
    for name, digest in man["files"].items():
        if name not in names:
            raise IntegrityError(f"listed file missing: {name}")
        if (not name.startswith(prefixes) or not name.endswith(".json")) and not (fmt == FORMAT_V2 and name == EVIDENCE):
            known = ", ".join(prefixes) + (f", {EVIDENCE}" if fmt == FORMAT_V2 else "")
            raise IntegrityError(f"unexpected member {name}: this installation knows only {known} in {fmt} bundles; a newer "
                                 "version of MOVE OpenLab may have added this section — update this installation, or export "
                                 "without it. Nothing was imported.")
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
        fingerprints = dict(experiment=experiment_fingerprint(chain), semantic=semantic_fingerprint(problem, instances, chain))
        if man.get("fingerprints") != fingerprints:
            raise IntegrityError("experiment or semantic fingerprint differs from the recomputed one")
    evidence = None
    if EVIDENCE in man["files"]:                # informative, but it must describe this bundle and nothing else
        ev = json.loads(z.read(EVIDENCE))
        exp = ev.get("experiment") if isinstance(ev, dict) else None
        root = campaigns[man["root_campaign_id"]]
        if (not isinstance(exp, dict) or ev.get("format") != EVIDENCE_FORMAT or exp.get("campaign_id") != root["campaign_id"]
                or exp.get("checksum") != root["checksum"] or ev.get("fingerprints") != fingerprints):
            raise IntegrityError("the evidence report does not describe this bundle (experiment, checksum or fingerprints differ)")
        evidence = dict(file=EVIDENCE, sha256=man["files"][EVIDENCE], format=ev["format"], generated_at=ev.get("generated_at"),
                        generated_by=ev.get("generated_by"))
    ml = _verify_ml(z, man, campaigns)
    avail = []
    for m in man["methods"]:
        try:
            ws.resolve_method(problem, m)
            ok, why = True, None
        except ContractError as e:
            ok, why = False, str(e)
        avail.append(dict(m, available_locally=ok, reason=why))
    by_id = {e["campaign_id"]: e for e in man["campaigns"]}
    report = dict(ok=True, bundle_sha256=sha256_bytes(data), manifest_sha256=sha256_bytes(mbytes),
                  format=fmt, problem_id=problem.problem_id, problem_title=problem.title, exported_by=man["exported_by"],
                  created_at=man.get("created_at"), scenarios=man.get("scenarios") or [],
                  vehicles=len(man.get("vehicles") or []), emissions=(man.get("emissions") or {}).get("configurations") or [],
                  lineage=man.get("lineage") or [],
                  exporter_installation=man["exporter_installation"], root_campaign_id=man["root_campaign_id"],
                  files_checked=len(man["files"]), instances_verified=len(instances),
                  geometry_verified=len(geometry), fingerprints=fingerprints, evidence=evidence,
                  networks=man.get("networks") or [], datasets=man.get("datasets") or [],
                  campaigns_verified=[dict(campaign_id=k, kind=v["kind"], checksum=v["checksum"], title=v["title"],
                                           owner_display=v.get("owner_display"),
                                           relation=(v.get("parent") or {}).get("relation"), runs=len(v["runs"]),
                                           accepted=sum(1 for r in v["runs"] if r.get("accepted")),
                                           repetitions=(by_id.get(k, {}).get("config") or v["config"]).get("repetitions"))
                                      for k, v in campaigns.items()],
                  spec_match=True, methods=avail, executable_code_in_bundle=False,
                  ml_evaluations=ml["report"] if ml else None)
    return report, campaigns, instances, problem, geometry, ml


def _verify_ml(z, man: dict, campaigns: dict) -> dict | None:
    """The ML evaluation section, verified: every included evidence document is listed, named by its SHA-256, valid,
    about a learned or hybrid method of a record of the bundle, and gives exactly the recorded figures when recomputed
    here. A reference-only entry is accepted as a reference and reported as not recomputable."""
    from .analysis import ml_evaluation as ML
    names = [n for n in man["files"] if n.startswith(ML_DIR)]
    if not names:
        return None
    if ML_INDEX not in names:
        raise IntegrityError("ML evaluation files without their index")
    idx = json.loads(z.read(ML_INDEX))
    if not isinstance(idx, dict) or idx.get("format") != ML_SECTION_FORMAT or not isinstance(idx.get("entries"), list):
        raise IntegrityError("malformed ML evaluation index")
    used, docs, out = {ML_INDEX}, {}, []
    for e in idx["entries"]:
        if not isinstance(e, dict):
            raise IntegrityError("malformed ML evaluation index")
        c = campaigns.get(str(e.get("campaign_id")))
        m = next((x for x in (c or {}).get("methods", []) if x["method_id"] == e.get("method_id")), None)
        if m is None:
            raise IntegrityError("ML evaluation evidence about a method or record that is not in the bundle")
        if m.get("kind") in ("exact", "heuristic"):
            raise IntegrityError(f"ML evaluation evidence for {m['method_id']}, a method that makes no predictions")
        sha = str(e.get("evidence_sha256"))
        recorded = e.get("recorded") or {}
        if e.get("included"):
            f = f"{ML_DIR}{sha}.json"
            if e.get("file") != f or f not in man["files"]:
                raise IntegrityError(f"ML evaluation evidence {sha[:12]} is announced but not in the bundle")
            raw = z.read(f)
            if sha256_bytes(raw) != sha:
                raise IntegrityError(f"ML evaluation evidence {sha[:12]} does not match its name")
            try:
                doc = ML.validate(ML.parse_json(raw))
                ev = ML.evaluate(doc)
            except ML.EvidenceError as x:
                raise IntegrityError(f"ML evaluation evidence {sha[:12]} is not valid: {x}") from None
            if doc["method_id"] != m["method_id"]:
                raise IntegrityError(f"ML evaluation evidence {sha[:12]} is about another method")
            got = _ml_summary(ev)
            same = got["confusion"] == recorded.get("confusion") and all(
                (got["metrics"][k] is None and (recorded.get("metrics") or {}).get(k) is None)
                or (got["metrics"][k] is not None and isinstance((recorded.get("metrics") or {}).get(k), (int, float))
                    and abs(got["metrics"][k] - recorded["metrics"][k]) <= 1e-9) for k in got["metrics"])
            if not same:
                raise IntegrityError(f"ML evaluation {sha[:12]}: the figures recomputed here differ from the recorded ones")
            used.add(f)
            docs[(c["campaign_id"], sha)] = raw
            out.append(dict(campaign_id=c["campaign_id"], method_id=m["method_id"], evidence_sha256=sha, recomputed=True,
                            records=ev["records"], confusion=got["confusion"]))
        else:
            out.append(dict(campaign_id=c["campaign_id"], method_id=m["method_id"], evidence_sha256=sha, recomputed=False,
                            records=e.get("records"), confusion=recorded.get("confusion"), reason=ML_NOT_RECOMPUTABLE))
    extra = set(names) - used
    if extra:
        raise IntegrityError(f"ML evaluation files not referenced by the index: {sorted(extra)[:3]}")
    refs = [dict(e, imported_with_bundle=True) for e in idx["entries"] if not e.get("included")]
    return dict(docs=docs, references=refs, index=idx,
                report=dict(mode=idx.get("mode"), entries=len(out), recomputed=sum(1 for x in out if x["recomputed"]),
                            references=sum(1 for x in out if not x["recomputed"]), items=out))


def revalidate(problem, campaigns: dict, instances: dict) -> dict:
    """Re-validate every run of a verified bundle with the installed problem's independent validator: feasibility and
    every metric must equal the recorded validation (a bundle can be internally consistent and still carry results that
    this installation's validator does not confirm)."""
    out = dict(runs=0, confirmed=0, mismatches=[])
    for cid, c in campaigns.items():
        for r in c.get("runs") or []:
            out["runs"] += 1
            inst = instances.get(r["instance_hash"])
            v = problem.validate(inst, r.get("decisions") or []) if inst is not None else None
            rec = r.get("validation") or {}
            same = v is not None and bool(v["feasible"]) == bool(rec.get("feasible")) and all(
                abs(float(v["metrics"].get(k, 0)) - float(x)) <= 1e-6 * max(1.0, abs(float(x))) for k, x in (rec.get("metrics") or {}).items()
                if isinstance(x, (int, float)))
            if same:
                out["confirmed"] += 1
            else:
                out["mismatches"].append(f"{cid}/{r.get('run_id')}")
    return out


def import_(ws, data: bytes) -> dict:
    report, campaigns, instances, problem, geometry, ml = _verify_all(ws, data)
    rv = revalidate(problem, campaigns, instances)
    if rv["mismatches"]:
        raise IntegrityError(f"{len(rv['mismatches'])} run(s) are not confirmed by this installation's validator: {rv['mismatches'][:5]}")
    report["revalidation"] = dict(runs=rv["runs"], confirmed=rv["confirmed"], validator_version=problem.validator_version)
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
                                                  original_installation=c["installation_id"],
                                                  revalidated_runs=rv["confirmed"], validator_version=problem.validator_version))
        if ml:                                                      # beside the records, as for evidence imported by hand
            from .ml_evidence import EvidenceStore
            store = EvidenceStore(ws.root)
            src = dict(kind="bundle", bundle_sha256=report["bundle_sha256"], exported_by=report["exported_by"],
                       exporter_installation=report["exporter_installation"])
            for (cid, sha), raw in ml["docs"].items():
                doc = json.loads(raw)
                store.add(cid, doc, raw, dict(src, name=f"bundle {report['bundle_sha256'][:12]}", sha256=sha), ws.display, ws.user)
            for ref in ml["references"]:
                store.add_reference(ref["campaign_id"], ref, src, ws.display, ws.user)
    report["imported_at"] = now()
    return report
