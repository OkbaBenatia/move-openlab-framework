"""Persistent jobs: status, per-stage traces, history, cancellation and recovery after a restart."""
import json
import time


from conftest import PROBLEM_ID, SMALL, A_B
from move_openlab.jobs import Jobs


def wait(jobs, owner, jid, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = jobs.get(owner, jid)
        if j["state"] != "running":
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_execution_job_is_traced_and_persisted(installations, tmp_path):
    w = installations[0].workspace("r1", "R1")
    c = w.create_campaign(PROBLEM_ID, "traced", SMALL, A_B, repetitions=1)
    jobs = Jobs(tmp_path / "jobs")
    j = jobs.start("r1", "execute", f"r1/{c['campaign_id']}", lambda mon: w.execute(c["campaign_id"], mon), title="traced")
    j = wait(jobs, "r1", j["job_id"])
    assert j["state"] == "done" and j["done"] == j["total"] == 8
    stages = [e["stage"] for e in j["events"]]
    assert stages[0] == "started" and "prepare" in stages and stages.count("run") == 8 and stages[-1] == "done"
    run_ev = next(e for e in j["events"] if e["stage"] == "run")
    assert set(run_ev["stages"]) == {"prepare", "execute", "validate"} and run_ev["accepted"] is True
    runs = w.get(c["campaign_id"])["runs"]
    assert all([s["stage"] for s in r["trace"]] == ["prepare", "execute", "validate"] for r in runs)
    fresh = Jobs(tmp_path / "jobs")                                   # a new process sees the persisted record
    assert fresh.get("r1", j["job_id"])["state"] == "done" and fresh.get("r2", j["job_id"]) is None
    hist = fresh.history("r1")
    assert hist[0]["job_id"] == j["job_id"] and "events" not in hist[0] and hist[0]["event_count"] >= 10


def _slow_plugin(inst, problem):
    d = inst.plugin_dir / "slow"
    d.mkdir()
    (d / "plugin.py").write_text(
        'METADATA = {"method_id": "slow-method", "name": "Slow", "version": "1.0.0", "kind": "heuristic", '
        '"problem_id": "synthetic-capacitated-bipartite-assignment", "objective_spec_id": '
        '"lex-max-served-then-min-cost/1.0.0", "deterministic": True, "author": "t", "description": "sleeps"}\n'
        'import time\ndef solve(instance, config):\n    if instance["instance_id"] != "syn-small-s00":\n        time.sleep(60)\n'
        '    return {"decisions": [], "status": "HEURISTIC"}\n')


def test_cancellation_kills_the_worker_and_keeps_no_partial_result(installations, problem, tmp_path):
    inst = installations[0]
    _slow_plugin(inst, problem)
    w = inst.workspace("r1", "R1")
    w.register_plugin(problem, "slow")
    c = w.create_campaign(PROBLEM_ID, "slow", dict(sizes=["small"], seeds=[1, 2]), [("slow-method", "1.0.0")], repetitions=1)
    jobs = Jobs(tmp_path / "jobs")
    j = jobs.start("r1", "execute", f"r1/{c['campaign_id']}", lambda mon: w.execute(c["campaign_id"], mon))
    time.sleep(1.5)
    assert jobs.cancel("r2", j["job_id"]) is None                     # another user cannot cancel it
    t0 = time.time()
    jobs.cancel("r1", j["job_id"])
    j = wait(jobs, "r1", j["job_id"], timeout=20)
    assert j["state"] == "cancelled" and time.time() - t0 < 10        # the 60 s worker was killed
    camp = w.get(c["campaign_id"])
    assert camp["status"] == "draft" and camp["runs"] == []
    assert [e["stage"] for e in j["events"]][-2:] == ["cancel", "cancelled"] or "cancel" in [e["stage"] for e in j["events"]]


def test_restart_marks_running_jobs_interrupted_and_campaigns_draft(installations, tmp_path):
    inst = installations[0]
    w = inst.workspace("r1", "R1")
    c = w.create_campaign(PROBLEM_ID, "stuck", SMALL, A_B, repetitions=1)
    f = w.root / "campaigns" / c["campaign_id"] / "campaign.json"
    rec = json.loads(f.read_text()); rec["status"] = "running"; f.write_text(json.dumps(rec))
    jdir = tmp_path / "jobs" / "r1"; jdir.mkdir(parents=True)
    (jdir / "abcd1234abcd1234.json").write_text(json.dumps(dict(
        job_id="abcd1234abcd1234", owner="r1", kind="execute", subject=f"r1/{c['campaign_id']}", state="running",
        started_at=time.time() - 5, events=[], done=1, total=8)))
    got = Jobs(tmp_path / "jobs").recover()
    assert [j["job_id"] for j in got] == ["abcd1234abcd1234"]
    assert Jobs(tmp_path / "jobs").get("r1", "abcd1234abcd1234")["state"] == "interrupted"
    assert inst.recover_interrupted() == {"r1": [c["campaign_id"]]}
    assert w.get(c["campaign_id"])["status"] == "draft"
