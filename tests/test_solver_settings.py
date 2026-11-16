"""Researcher-settable solver settings: declared per method (``config_schema``), validated before anything is stored,
recorded in the experiment configuration and in each run's effective configuration; a change on a locked experiment is
a new experiment version, never an edit of the original. Also: what a hybrid method's OPTIMAL proves, and the
candidate-reduction capability."""
import pytest

from move_openlab import registry
from move_openlab.analysis.common import SCOPE_FEASIBLE, SCOPE_FULL, SCOPE_REDUCED, optimality_scope
from move_openlab.methods import ContractError, MethodMetadata, builtin_registry, check_metadata, validate_config

from test_api import login, make_client, wait

RIDE = "public-ride-matching"
SYN = "synthetic-capacitated-bipartite-assignment"


def _exact():
    return builtin_registry(registry.get(RIDE)).get("exact-matching-highs", "1.0.0")[0]


def test_settings_are_checked_against_the_schema():
    m = _exact()
    assert set(m.config_schema) == {"time_limit_s", "mip_rel_gap", "mip_abs_gap", "threads", "random_seed"}
    assert m.default_config == dict(time_limit_s=60.0, threads=1, random_seed=0, mip_rel_gap=0.0, mip_abs_gap=0.0)
    assert validate_config(m, dict(time_limit_s=30, threads=2)) == dict(time_limit_s=30, threads=2)
    assert validate_config(m, {}) == {}
    for bad in (dict(unknown=1), dict(threads=1.5), dict(threads=True), dict(time_limit_s=0), dict(time_limit_s=4000),
                dict(mip_rel_gap=2), dict(time_limit_s=None), dict(time_limit_s=float("nan")), dict(threads="2")):
        with pytest.raises(ContractError):
            validate_config(m, bad)
    greedy = builtin_registry(registry.get(RIDE)).get("greedy-min-detour", "1.0.0")[0]
    with pytest.raises(ContractError, match="declares no configurable settings"):
        validate_config(greedy, dict(time_limit_s=10))
    nullable = MethodMetadata(**{**m.to_dict(), "config_schema": dict(gap=dict(type="number", label="Gap", nullable=True))})
    assert validate_config(nullable, dict(gap=None)) == dict(gap=None)        # null keeps the solver's default


def test_a_malformed_schema_or_default_is_refused():
    p = registry.get(RIDE)
    base = {**_exact().to_dict()}
    for schema in (dict(t=dict(type="float", label="T")), dict(T=dict(type="number", label="T")),
                   dict(t=dict(type="number")), dict(t=dict(type="number", label="T", colour="red"))):
        with pytest.raises(ContractError):
            check_metadata({**base, "default_config": {}, "config_schema": schema}, p)
    with pytest.raises(ContractError):                                       # a default that breaks its own schema
        check_metadata({**base, "default_config": dict(time_limit_s=-1)}, p)


def test_hybrid_optimal_is_reduced_model_optimality():
    run = dict(accepted=True, status_declared="OPTIMAL")
    assert optimality_scope(run, {}, "exact") == SCOPE_FULL
    assert optimality_scope(run, {}, "hybrid") == SCOPE_REDUCED                 # never a full-problem proof
    assert optimality_scope(run, {}, "heuristic") == SCOPE_FEASIBLE


def test_candidate_view_declares_the_capability():
    class WithCandidates(type(registry.get(SYN))):
        def candidate_view(self, instance, run):
            return {}
    assert WithCandidates().presentation()["capabilities"] == ["candidates", "map"]
    assert "candidates" not in registry.get(RIDE).presentation()["capabilities"]


def test_settings_at_creation_and_as_a_new_version(tmp_path):
    c = make_client(tmp_path, "settings")
    login(c, "alice")
    r = c.post("/api/lab/demo").json()
    base = r["baseline_id"]
    meths = c.get(f"/api/problems/{RIDE}/methods").json()
    assert set(meths["settings"]) == {"exact-matching-highs@1.0.0"}           # only methods that declare settings
    parent = c.get(f"/api/campaigns/{base}").json()
    parent = parent.get("campaign", parent)
    # invalid or pointless changes are refused before anything is stored
    n0 = len(c.get("/api/campaigns").json()["campaigns"])
    assert c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"exact-matching-highs": dict(threads=0)})).status_code == 422
    assert c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"greedy-min-detour": dict(time_limit_s=5)})).status_code == 422
    assert c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"nope": {}})).status_code == 400
    assert c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"exact-matching-highs": dict(time_limit_s=60.0)})).status_code == 400
    assert len(c.get("/api/campaigns").json()["campaigns"]) == n0
    # a real change: a new version derived from the locked baseline
    v = c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"exact-matching-highs": dict(time_limit_s=30, threads=2)})).json()
    assert v["kind"] == "variant" and v["parent"]["campaign_id"] == base and v["parent"]["checksum"] == parent["checksum"]
    assert v["config"]["method_configs"]["exact-matching-highs"] == dict(time_limit_s=30, threads=2)
    assert v["scenario_set"]["instance_hashes"] == parent["scenario_set"]["instance_hashes"]
    assert "settings exact-matching-highs: threads 1 -> 2" in v["config_differences_from_parent"]
    assert "settings exact-matching-highs: time_limit_s 60.0 -> 30" in v["config_differences_from_parent"]
    assert v["title"].endswith("— Settings 1")
    # only the method whose settings changed runs — never every method of the parent implicitly
    assert [m["method_id"] for m in v["methods"]] == ["exact-matching-highs"]
    assert "runs 1 of 2 methods: exact-matching-highs" in v["config_differences_from_parent"]
    wait(c, c.post(f"/api/campaigns/{v['campaign_id']}/execute").json())
    done = c.get(f"/api/campaigns/{v['campaign_id']}").json()
    done = done.get("campaign", done)
    eff = {(x["method_id"], x["effective_config"].get("time_limit_s"), x["effective_config"].get("threads")) for x in done["runs"]}
    assert eff == {("exact-matching-highs", 30, 2)}
    assert len(done["runs"]) == len(parent["scenario_set"]["instance_hashes"]) * parent["config"]["repetitions"]
    # explicit methods and one scenario only; a changed method cannot be left out
    one = parent["scenario_set"]["instance_hashes"][1]
    w = c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"exact-matching-highs": dict(threads=3)},
                                                            methods=["exact-matching-highs", "greedy-min-detour"], instance_hashes=[one])).json()
    assert [m["method_id"] for m in w["methods"]] == ["exact-matching-highs", "greedy-min-detour"]
    assert w["scenario_set"]["instance_hashes"] == [one] and "on 1 of 3 scenarios" in w["config_differences_from_parent"]
    assert c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"exact-matching-highs": dict(threads=3)},
                                                                methods=["greedy-min-detour"])).status_code == 400
    assert c.post(f"/api/campaigns/{base}/settings", json=dict(method_configs={"exact-matching-highs": dict(threads=3)},
                                                                instance_hashes=["0" * 64])).status_code == 400
    again = c.get(f"/api/campaigns/{base}").json()
    assert again.get("campaign", again)["checksum"] == parent["checksum"]     # the original is untouched
    # settings at creation: recorded in the configuration; a method without settings refuses them
    hs = parent["scenario_set"]["instance_hashes"][:1]
    body = dict(problem_id=RIDE, title="With settings", scenario_params=dict(instance_hashes=hs),
                methods=[["exact-matching-highs", "1.0.0"], ["greedy-min-detour", "1.0.0"]], repetitions=1)
    made = c.post("/api/campaigns", json=dict(body, method_configs={"exact-matching-highs": dict(mip_rel_gap=0.01)})).json()
    assert made["config"]["method_configs"] == {"exact-matching-highs": dict(mip_rel_gap=0.01), "greedy-min-detour": {}}
    assert c.post("/api/campaigns", json=dict(body, method_configs={"greedy-min-detour": dict(x=1)})).status_code == 422
    e = c.get(f"/api/lab/experiments/{v['campaign_id']}").json()
    assert e["campaign"]["method_configs"]["exact-matching-highs"] == dict(time_limit_s=30, threads=2)
    c.post("/api/auth/logout")


def test_candidate_preview_is_a_capability_and_checks_its_input(tmp_path):
    class WithPreview(type(registry.get(SYN))):
        def candidate_preview(self, instance, method, config):
            return {}
    assert WithPreview().presentation()["capabilities"] == ["candidate-preview", "map"]
    c = make_client(tmp_path, "preview")
    login(c, "alice")
    r = c.post("/api/lab/demo").json()
    base = c.get(f"/api/campaigns/{r['baseline_id']}").json()
    base = base.get("campaign", base)
    body = dict(campaign_id=base["campaign_id"], instance_hash=base["scenario_set"]["instance_hashes"][0], method_id="exact-matching-highs")
    no = c.post("/api/geo/candidates/preview", json=body)                       # ride matching removes no candidates
    assert no.status_code == 400 and "no candidate-reduction preview" in no.json()["detail"]
    assert c.post("/api/geo/candidates/preview", json=dict(body, instance_hash="x")).status_code == 422
    c.post("/api/auth/logout")
