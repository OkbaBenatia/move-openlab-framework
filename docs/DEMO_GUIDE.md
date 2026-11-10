# Demonstration guide — where to click, what you should see

A short, repeatable demonstration on the shipped Montbéliard experiment (RPC 2026-10 observed trips, OpenStreetMap).
The demonstration's figures are fixed: they come from its frozen scenarios. The generated scenario (step 3) is
seeded: with the same road-network extract the same seed gives the same participants and the same results — the
figures below were obtained on the extract of 9 November 2026; another extract gives other, equally reproducible
figures. Every figure was checked again in a fresh run on 10 November 2026 (new account, copy of a local installation).
A longer, timed version for a team meeting, with a French script and a fallback plan:
[TEAM_PRESENTATION_GUIDE.md](TEAM_PRESENTATION_GUIDE.md).

| # | Where to click | What you should see |
|---|---|---|
| 1 | Terminal: `./start-local.sh`, then open `http://127.0.0.1:8765` and sign in | The Workspace with a map and an experiment; Ctrl+C in the terminal stops everything |
| 2 | Experiment picker (top left) → **Montbéliard Demo — Baseline** | *Validated 18/18*, *Locked*; sample 1: **15 / 30** riders served by Exact and Greedy; CO₂ **−28.3 kg (−31.2 %)** vs everyone drives alone; drivers as squares with a green bolt (electric) or a blue fuel drop (combustion) |
| 3 | **Generate** → area Montbéliard → *Synthetic demand* → Next → drivers **20**, riders **30**, seed **21** (do not randomize) → Next → From **07:30** To **08:00**, max detour **20** min, ratio **1** | Preview: **20 drivers · 30 riders · 63 compatible pairs** |
| 4 | Next → Exact and Greedy ticked, repetitions **3** → Next → **Save & Run** | Progress, then *Validated 6/6*: Exact **13** served (104.2 min detour), Greedy **11** (76.7 min); CO₂ with the petrol car: 98.2 kg vs 107.5 kg, **9.3 kg avoided (8.7 %)** |
| 5 | **Export** → keep *Evidence report* ticked → **Lock and export** | **One** `.zip` downloaded; *Bundle saved … SHA-256 …*; the report is inside as `evidence/report.json` |
| 6 | Sign in as another researcher → **Import ▾ → Import a bundle file…** → choose the ZIP | *Integrity verified* (every checksum, manifest digest, fingerprints, evidence report matches), methods available, nothing stored yet → **Import experiment** |
| 7 | **Run again** on the imported experiment | A re-execution: *Validated 6/6*, **Reproduced** (every validated result equal; runtimes reported, not required to match) |
| 7b | Results → **Compare methods** | Exact (A, reference) and Greedy (B) of this experiment side by side on its frozen scenarios; compact charts |
| 8 | **Compare** → the open experiment is ticked → tick exactly one other → **Compare selected (2)** | Exactly two columns, **A (Reference)** and **B**; verdicts per claim (results, runtime, CO₂) with *Why?*; *Reference* selector changes the deltas |
| 9 | In the comparison: **Charts** | Metric and chart-type selectors, tooltips on hover; *CO₂: baseline, solution and savings* (baseline vs solution, avoided kg and %, per rider and per vehicle) with the calculation, baseline and vehicle parameters; CSV · PNG · SVG |
| 10 | Montbéliard Demo — Baseline → **+ Add method → Register my method → My Greedy Matching → Register → Run with this method** | An extension, *Validated 9/9*: My Greedy Matching **48** served with **51.9 min** detour (Exact and Greedy: 48, 36.3 min). Tutorial: [ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md) |
| 11 | Comparison → Charts → Metric **Detour per served rider (min)** | A built-in custom metric computed from validated figures: 0.755 min for Exact, 1.081 min for My Greedy Matching. A registered one, computed in the sandbox: `plugins/co2_avoided_per_served_rider` (`POST /api/lab/metrics/register`) gives 1.70 kg CO₂ avoided per served rider for Exact and 1.64 kg for My Greedy Matching. Your own: [EXTENDING.md › A custom metric](EXTENDING.md#a-custom-metric) |
| 12 | Choose a sample and a result, zoom the map → **Library** → back to **Workspace** (or sign out and in) | The same experiment, sample, selected result, methods and map view |

Say it in one sentence each: **validation** — every solution re-checked by the problem's validator; **reproducibility**
— a re-execution gives the same validated results; **comparability** — whether two results may be put side by side,
claim by claim. They are reported separately and never merged into one score.
