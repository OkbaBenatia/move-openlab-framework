# Add your method — worked example: *My Greedy Matching*

This tutorial adds a new method to the ride-matching problem (`public-ride-matching`), checks it, runs it on the
Montbéliard experiment and compares it with the built-in methods. Every command and every output below was run on
this repository; the finished example is [`plugins/my_greedy_matching/`](../plugins/my_greedy_matching/).
Reference for the contract and the security model: [EXTENDING.md](EXTENDING.md), [SECURITY_MODEL.md](SECURITY_MODEL.md).

What the platform guarantees, whatever your method does: it runs in the verified sandbox (no network, no files
outside the instance), its decisions are re-checked by the problem's independent validator, and only the
validator's figures are shown. What your method reports about itself (`declared`) is compared, never trusted.

## 1. Create the method from the template

```bash
.venv/bin/move-openlab method new my_greedy_matching --problem public-ride-matching --dir plugins --author "MOVE OpenLab example"
```

```text
created plugins/my_greedy_matching/plugin.py, plugins/my_greedy_matching/test_plugin.py and plugins/my_greedy_matching/README.md
next: edit solve(), then  move-openlab method check plugins/my_greedy_matching --bundle <experiment bundle>
```

`plugin.py` holds a literal `METADATA` (read without running the file) and a `solve(instance, config)` that returns
no decision — valid, serves nobody. `test_plugin.py` checks the metadata and solves the problem's self-test instance.

## 2. Implement `solve`

The rule of the example — *most constrained rider first*: riders with the fewest compatible drivers are served
first, each by the free driver whose detour is smallest (ties: shorter time to the pickup point, then driver id).

```python
def solve(instance, config) -> dict:
    options: dict[str, list[dict]] = {}
    for p in instance["pairs"]:                       # compatible driver–rider pairs, with their detour
        options.setdefault(p["rider"], []).append(p)
    busy, decisions, detour = set(), [], 0
    for rider in sorted(options, key=lambda r: (len(options[r]), r)):
        free = [p for p in options[rider] if p["driver"] not in busy]
        if not free:
            continue
        best = min(free, key=lambda p: (p["detour_s"], p["to_pickup_s"], p["driver"]))
        busy.add(best["driver"])
        decisions.append([best["driver"], rider])
        detour += best["detour_s"]
    return dict(decisions=decisions, status="HEURISTIC", declared=dict(served=len(decisions), detour_s=detour),
                metadata={}, diagnostics=dict(pairs_considered=len(instance["pairs"]), riders_with_options=len(options)))
```

Set `version` to `1.0.0` and write a one-line `description` in `METADATA` (change the version whenever the rule
changes: results are recorded per method version and code digest).

## 3. Test it locally

```bash
.venv/bin/python -m pytest plugins/my_greedy_matching
```

```text
..                                                                       [100%]
2 passed in 0.01s
```

## 4. Check it the way the platform runs it

Get the shipped sample bundle (a real exported experiment: three frozen Montbéliard scenarios, exact and greedy
methods, 18 validated runs):

```bash
.venv/bin/python -c "from move_openlab import samples; open(samples.FILENAME, 'wb').write(samples.bundle_bytes())"
sha256sum move-openlab-sample-montbeliard.zip
```

```text
3346947061afda42626cf3948bc9149304b23f9c5dcba4f1651d4d0fb2d165d1  move-openlab-sample-montbeliard.zip
```

```bash
.venv/bin/move-openlab method check plugins/my_greedy_matching --bundle move-openlab-sample-montbeliard.zip
```

```text
[ok] metadata: my-greedy-matching@1.0.0 (heuristic) for public-ride-matching
[ok] self-test: valid result on the self-test instance (sandbox)
[ok] benchmark: 3/3 runs valid on the imported experiment
    my-greedy-matching           valid=True totals={'served': 48, 'detour_s': 3113} optimal=0
    exact-matching-highs         valid=True totals={'served': 48, 'detour_s': 2175} optimal=3
    greedy-min-detour            valid=True totals={'served': 48, 'detour_s': 2175} optimal=3
```

In a throw-away installation the check read the metadata without executing the file, registered the method (its
self-test ran inside the verified sandbox), imported and verified the bundle, extended the imported experiment with
the method and ran it on the three scenarios. Reading the result: the example serves as many riders as the exact
method (48 over the three scenarios) but accepts more detour (3 113 s against the optimum 2 175 s); on these
scenarios the built-in greedy rule happens to reach the optimum. `optimal=0` means no run of the example is a
proven optimum — a heuristic never claims one. The same figures are asserted by
`tests/test_method_tools.py::test_shipped_example_my_greedy_matching_checks_on_the_sample_bundle`.

## 5. Register it in the web interface

Plugins are off unless the operator approves a directory; `./start-local.sh` approves `plugins/` and runs them in
the verified sandbox. In the Workspace: **+ Add method → Register my method → My Greedy Matching → Register** (it is
listed under *Ready-made examples*; *Details → Check compatibility* first shows the static check, nothing executed).
Registration pins the SHA-256 of `plugin.py` and repeats the sandboxed self-test; a modified file is refused until
it is registered again (under a new version).

### Without the command line: Create from template

Everything above can be done from the web interface, with the same template and the same checks:

1. **+ Add method → Create from template**; the problem is the open experiment's (a selector appears when several
   are installed).
2. Fill in *Method name* (`my_greedy_matching`), *Display name*, *Author*, *Kind* and a *Short description*.
3. **Generate the template (.zip)** downloads `my_greedy_matching.zip` with `plugin.py`, `test_plugin.py` and
   `README.md`; the screen shows the instance fields and the decision format of the problem.
4. Implement `solve(instance, config)` in `plugin.py` (the platform does not write it for you), optionally test it
   locally, then zip the directory again without caches (`zip -r my_greedy_matching.zip my_greedy_matching -x
   '*__pycache__*'`).
5. **Upload the completed plug-in (.zip)**: the screen shows *ZIP checked*, *Metadata*, *Not registered yet* and
   *Self-test in the sandbox*, each ok or failed with the reason. Then **Register**, **Run with this method** and
   **Compare**, as below. The upload stays in your workspace only and runs only in the verified sandbox.

Each step shows its command-line equivalent under *Developer details*. The shipped examples (*Ready-made examples* in
*Register my method*) need no upload: `nearest_pickup` and `my_greedy_matching` register and run on the public
Montbéliard demonstration straight away, with no private code, data or commercial solver.

## 6. Run it on the Montbéliard experiment and compare

1. Open the demonstration experiment (Workspace, experiment picker → *Montbéliard Demo — Baseline*). Its original
   results are frozen.
2. **+ Add method → Register my method → Register**, then **Run with this method** (or tick it in the Methods list
   and press **Run added methods**): an *extension* experiment (*Montbéliard Demo — Extension 1 (My Greedy Matching)*)
   runs the new method on the same frozen scenarios and shows it with the original methods; the original record is
   unchanged.
3. When it finishes, every run shows the validator's verdict; **Compare** opens on its *Methods* tab and puts My
   Greedy Matching, Exact and Greedy side by side (results, runtime, CO₂, custom metrics, charts, maps); its
   *Experiments* tab puts the extension beside another experiment, each claim with its comparability verdict.

The figures obtained this way in the browser acceptance run are in the review package (`reports/`), with
screenshots; they are recomputed from validated decisions only.

## What the platform checks for you

| Check | Where | On failure |
|---|---|---|
| Metadata contract (ids, semantic version, problem, objective) | `method check`, registration | refused, with the field and the rule |
| Self-test in the sandbox | `method check`, registration | refused, with the contract error |
| Every decision list | each run | the run is marked invalid with the validator's errors; its figures are not used |
| Code identity | each run | a file that changed since registration is refused |
| Reported metrics (`declared`) | each run | compared with the validator's figures, never shown as results |
