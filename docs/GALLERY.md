# Gallery

Screenshots of the public application, taken from a local run with synthetic accounts and the public Montbéliard
demonstration. Map tiles © OpenStreetMap contributors. Details may differ from the current interface. The sources are
in [`assets/screenshots/gallery/`](assets/screenshots/gallery/).


## Installation and first run

**Welcome to MOVE OpenLab.** The first-run page after the one-command installation: the administrator chooses a
username and a password (strength meter, confirmation); recorded by the `install` workflow on a GitHub-hosted
Windows machine.

![The first-run page, where the administrator chooses a username and a password](assets/screenshots/gallery/17-first-run-setup.jpg)

## Workspace and scenario authoring

**The Workspace.** Experiment provenance on the left, participants and validated shared rides on the road network,
methods, results and CO₂ on the right.

![The Workspace with the Montbéliard demonstration](assets/screenshots/gallery/01-workspace.jpg)

**Seeded random participants.** Step 2 of the Generate wizard: 20 drivers and 30 riders drawn with a seed inside the
chosen area; the seed and settings are recorded with the scenario.

![Randomized drivers and riders on the Montbéliard road network](assets/screenshots/gallery/02-randomize.jpg)

**Drag-and-drop placement.** A driver placed on the map, with its route computed on the road network.

![A driver placed by hand, with its route](assets/screenshots/gallery/03-drag-and-drop.jpg)

**Route replay.** The validated solution replayed on one clock: vehicles moving, riders on board, delivered and
unserved.

![Route replay in the Workspace](assets/screenshots/gallery/04-route-replay.jpg)

## Adding methods

**Three routes.** *+ Add method*: built-in methods, *Register my method*, *Create from template*, and how a method is
evaluated.

![The three ways to add a method](assets/screenshots/gallery/05-add-method.jpg)

**Register a ready-made plug-in.** The catalogue with *Nearest Pickup First*: version, kind, author, problem, objective,
code SHA-256 and the compatibility check, done without executing anything.

![Nearest Pickup First in the plug-in catalogue](assets/screenshots/gallery/06-register-plugin.jpg)

**Create from template.** Problem, name and kind; the generated template; the uploaded plug-in and its checks.

![The template workflow with the checks of an uploaded plug-in](assets/screenshots/gallery/16-create-from-template.jpg)

## Results, metrics and evidence

**Charts.** One chart per chosen metric, bar, grouped bar, line, box plot or scatter; CSV, PNG and SVG per chart or as
a ZIP.

![Charts of two compared methods](assets/screenshots/gallery/07-charts.jpg)

**ML evaluation.** Confusion matrix and derived measures from imported evaluation evidence (a synthetic example file);
exact and heuristic methods are marked *Not applicable*, never zero.

![ML evaluation with a confusion matrix](assets/screenshots/gallery/08-ml-evaluation.jpg)

**CO₂ and independent validation.** CO₂ against the stated baseline, computed from validated decisions, and the
validator's verdict for every run.

![CO₂ and independent validation in the Workspace](assets/screenshots/gallery/09-co2-and-validation.jpg)

## Comparison

**Compare methods.** A registered plug-in next to the built-in methods on the same frozen scenarios, with differences
to the chosen reference.

![Compare Methods with Nearest Pickup First](assets/screenshots/gallery/10-compare-methods.jpg)

**Compare experiments.** The baseline and its controlled variant: independent validation, reproducibility and
semantic comparability per claim, then the matched results.

![Compare Experiments](assets/screenshots/gallery/11-compare-experiments.jpg)

**Synchronised maps.** Both experiments on two maps that move together, replayed on one clock.

![Two synchronised maps with a shared replay clock](assets/screenshots/gallery/12-synchronised-maps.jpg)

**Public benchmark.** The synthetic assignment benchmark: 30 frozen scenarios, 300 validated runs, charts and the
validator's verdict.

![The public synthetic benchmark in the Workspace](assets/screenshots/gallery/13-benchmark.jpg)

## Exchange and reproduction

**Try a sample.** The sample scenario and the sample experiment, built into the application, verified before import.

![The two public sample packages](assets/screenshots/gallery/14-try-a-sample.jpg)

**Reproduced.** The imported sample experiment, its integrity verified and its runs re-executed on this installation:
*Reproduced*.

![The imported experiment reproduced on this installation](assets/screenshots/gallery/15-reproduced.jpg)
