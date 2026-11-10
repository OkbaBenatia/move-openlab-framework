# Manual acceptance — workflow checks

Steps a reviewer can follow in the running application (`./start-local.sh`, http://127.0.0.1:8765) to accept the
workflow corrections. Each line: where to click → what must be true. The same checks run automatically in
`scripts/e2e/workflow_acceptance.mjs` (against a copy of a data directory).

| # | Where to click | Accept when |
|---|---|---|
| 1 | Open *Montbéliard Demo — Baseline* | Left panel: title, status badges, Area, Mobility data, Scenario and one line "N/N runs validated · methods · scenarios"; *Experiment details* collapsed; the participant list starts in the first screen |
| 2 | *Experiment details* | Road network, sampling, lineage and identifiers; the open/closed state is remembered after a reload and a new sign-in |
| 3 | Map | Drivers: squares with a vehicle icon and colour (electric green bolt, combustion blue fuel drop, hybrid indigo leaf, plug-in teal plug); riders: person icons; pick-ups ▲ filled, drop-offs ▼ hollow; unmatched riders dashed grey; hover gives details; points at the same place fan out |
| 4 | Results → **Compare methods** | A page for this experiment only: tick or untick methods; A is the reference (selector); Results (status, served, detour, runtime, CO₂, fleet, custom metrics, Δ) and Charts; Export table |
| 5 | Charts (any comparison) | Equal compact cards: 3 per row at full width, 2 at 160 % browser zoom, 1 on a phone; no horizontal scroll; hover tooltips; CSV · PNG · SVG; Enlarge (Esc closes) |
| 6 | **Compare** → tick exactly one other → **Compare selected (2)** | Exactly A and B; the reference can be changed; incompatible candidates folded with *Why?*; hidden records only with the filter |
| 7 | Compare on an experiment with nothing comparable (e.g. a public benchmark run) | "No comparable experiment found." with *Compare methods in this experiment*, *Run another method on the same scenario*, *Reproduce this experiment* (once locked) |
| 8 | **+ Add method → Register my method → Register → Run with this method** | An extension (*… — Extension 1 (Method)*) runs on the same frozen scenarios; every run validated; the original unchanged |
| 9 | **Generate** → … → **Save & Run** | The Workspace opens on the new experiment within about a second, with *Queued › Preparing › Running methods › Validating › Results* and Cancel; a double click creates one experiment |
| 10 | Participants → **+ Driver** (then **+ Rider**) | The wizard opens on the participants step of a new scenario version with D(n+1) waiting for its start point; two map clicks place start and end; Route previews it; a point off the road network is refused; closing without Save stores nothing |
| 11 | Participants → **Randomize**, seed field → **Randomize locations** | New places; seed 4242 twice gives the same places, another seed others; ids and time windows unchanged |
| 12 | **Run again** on a reproduction of a reproduction | Short title *… — Reproduction 2*, never nested; lineage under *Experiment details* |
| 13 | Library › **Benchmarks** → **Run the public benchmark** | Opens with progress; afterwards the run lists, per method, validated runs and runs equal to the min-cost-flow oracle optimum (Exact all); the scientific study stays *Planned* |
| 14 | Export one ZIP → second researcher → Import → Reproduce → Compare | Integrity verified before anything is stored; Reproduced; source, imported copy and reproduction distinguishable by category and title |
