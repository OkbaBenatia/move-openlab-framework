# Team presentation guide — a 15–20 minute live demonstration

*MOVE OpenLab was conceived, designed, developed and implemented by Dr. Okba BEN ATIA.*

A live demonstration of MOVE OpenLab for a research team, on **public-safe data only**: the shipped Montbéliard
demonstration (participants sampled from the RPC open-data release 2026-10, OpenStreetMap road network), a seeded
synthetic scenario on the same network, the built-in exact MILP (HiGHS) and greedy methods, the public example
plug-in *My Greedy Matching*, the built-in custom metric and the public example metric file. It extends
[DEMO_GUIDE.md](DEMO_GUIDE.md).

Every figure below was read from the application in a fresh run (new account, copy of a local installation, 10 November
2026). The demonstration's figures come from its frozen scenarios and are the same everywhere. The generated
scenario's figures depend on the road-network extract (here the extract of 9 November 2026): the same seed on the same
extract gives the same figures; another extract gives other, equally reproducible ones.

## Before the meeting (10 minutes)

| Check | How |
|---|---|
| The application starts | `./start-local.sh` → http://127.0.0.1:8765; leave the terminal open (Ctrl+C stops it) |
| Two accounts | yours and a second researcher account (Administration → Accounts, or `python scripts/dev_provision.py researcher2` on a local installation) |
| The road network of the demonstration area is installed | *Generate* lists the Montbéliard area with its road network (it was downloaded once; no network access is needed during the talk) |
| Plug-ins are in sandbox mode | `./start-local.sh` sets `MOVE_OPENLAB_PLUGIN_MODE=sandbox` and `MOVE_OPENLAB_PLUGIN_DIR=plugins`; *+ Add method* lists *My Greedy Matching* |
| A fallback bundle | export the generated experiment once beforehand and keep the `.zip` on the desktop (see *Fallback plan*) |
| Browser | one window, 1440 px wide or more, zoom 100 %; a second private window for the second account |

## Running order

| # | Min. | Where to click | What you should see | Scientific point (one sentence) |
|---|---|---|---|---|
| 1 | 1 | Sign in | The Workspace on the *Montbéliard Demo — Baseline*: map, provenance on the left (area, road network, mobility data, sampled scenario), results on the right | An experiment is a frozen record: scenarios, methods, configuration, runs and environment, identified by hashes |
| 2 | 2 | Sample 1 in the scenario list; the results table | *Validated 18/18*, *Locked*; **15 / 30** riders served by Exact and by Greedy; CO₂ **28.3 kg avoided (−31.2 %)** against *everyone drives alone*; drivers as squares with a green bolt (electric) or a blue fuel drop (combustion), riders as person icons, pick-ups and drop-offs as arrows; metadata compact (details under *Experiment details*) | Every solution is re-checked by the problem's own validator; CO₂ is computed by the platform from the validated decisions, never taken from a method |
| 3 | 3 | **Generate** → area Montbéliard → *Synthetic demand* → Next → drivers **20**, riders **30**, seed **21** → Next → From **07:30**, To **08:00**, max detour **20** min, ratio **1** → Next → Exact and Greedy ticked, repetitions **3** → Next → **Save & Run** | Preview **20 drivers · 30 riders · 63 compatible pairs**; the Workspace opens on the new experiment at once with its stages *Queued › Preparing › Running methods › Validating › Results*; *Validated 6/6*: Exact **13** served (**104.2 min** detour), Greedy **11** (**76.7 min**) | A seed and a road network fully determine the scenario: anyone with the same extract regenerates it exactly |
| 4 | 2 | The results table and *Evidence* (on the demonstration baseline) | Exact is *proven optimal* on **3/3** scenarios; Greedy is a heuristic and claims nothing; the three statements are shown apart: independent validation, reproducibility, semantic comparability | A time limit is never an optimality claim: a solver stopped by its limit is labelled *not proven (time limit)*, even when its solution is feasible |
| 5 | 2 | CO₂ in the results; *Results › Advanced* → *Tailpipe only* → *New experiment with this calculation* | Exact: **98.2 kg** vs **107.5 kg** for everyone driving alone, **9.3 kg avoided (8.7 %)** (Greedy 99.0 kg, 8.5 kg, 7.9 %); the new experiment has the same decisions, other CO₂ figures and its own fingerprint; the original is unchanged | Changing an emission parameter creates a new, traceable configuration; the results stay directly comparable while the CO₂ figures are not |
| 5b | 2 | **Compare** (it opens on the *Methods* tab) | The two algorithms of the experiment side by side on its own frozen scenarios: **A** Exact (reference) and **B** Greedy, Δ B − A, status, served riders, detour, runtime, CO₂, fleet, custom metric; **Charts**: compact cards, three per row | Comparing methods needs no other experiment: same scenarios, constraints, objective and validator |
| 6 | 2 | Back on the demonstration baseline → **Compare** → *Experiments* tab → **Edit selection** → tick the controlled variant → **Compare selected (2)** | Footer *2 selected · reference A: Montbéliard Demo — Baseline*; exactly two columns, **A (Reference)** and **B**; a verdict per claim (results, runtime, CO₂) with *Why?*; the *Reference* selector changes the deltas | Comparability is decided per claim: two results may be comparable for quality and not for runtime or CO₂ |
| 7 | 1.5 | In the comparison: **Charts** (All metrics: one compact card per metric; or Metric **Detour per served rider (min)**) | Tooltips on hover, chart types where the data supports them, CSV · PNG · SVG, Enlarge; Exact **0.755 min**, My Greedy Matching (after step 8) **1.081 min** | A custom metric is computed from validated figures only; third-party metric code runs only in the sandbox |
| 8 | 3 | Demonstration baseline → **+ Add method** → **Register my method** → *My Greedy Matching* → **Register** → **Run with this method** → **Compare** (*Methods* tab) | *Registered* (code pinned by its SHA-256, self-test in the sandbox); an **extension** titled *Montbéliard Demo — Extension 1 (My Greedy Matching)*, *Validated 9/9*: My Greedy Matching **48** served with **51.9 min** detour, against **48** and **36.3 min** for Exact and Greedy; no optimality claimed | A new method is compared on exactly the same frozen scenarios, and its solutions are validated like every other method's |
| 9 | 3 | Generated experiment → **Export** (evidence report ticked) → **Lock and export** → second window, second researcher → **Import ▾ → Import a bundle file…** → **Import experiment** → **Run again** | **One** `.zip` (about 1.4 MB) with *Bundle saved … SHA-256 …*; on import *Integrity verified*, *Importable*, *Reproducible here*, nothing stored before confirmation; the re-execution (*… — Reproduction 1*): *Validated 6/6*, **Reproduced**, comparability with the original: results direct, runtime direct, CO₂ direct | Reproduction means an independent re-execution in another workspace gives the same validated results; runtimes are reported, not required to match |
| 10 | 1 | — | — | Validation, reproducibility and comparability are three separate statements, never merged into one score |

Optional (1 minute, for a technical audience): the registered example metric
`plugins/co2_avoided_per_served_rider/metric.py`, registered for the account
(`POST /api/lab/metrics/register`, see [EXTENDING.md › A custom metric](EXTENDING.md#a-custom-metric)), appears in the
chart's metric selector as *CO₂ avoided per served rider*: on the demonstration's extension, **1.70 kg** per served
rider for Exact and **1.64 kg** for My Greedy Matching, computed in the sandbox from the validated CO₂ figures.

Optional (1–2 minutes each):
- **Participants › + Driver / + Rider / Randomize**: the wizard opens on the participants step of a *new* version of the
  shown scenario; click the start and end points on the map, preview the route (a point off the road network is
  refused); Randomize locations with a typed seed gives the same places for the same seed. Nothing is saved before Save.
- **Library › Benchmarks › Run the public benchmark** (about half a minute): 30 synthetic instances, Exact and Greedy,
  5 repetitions, every result validated and checked against an independent min-cost-flow oracle (Exact: 150/150 runs
  equal to the oracle optimum; Greedy: 35/150). It is a methodological benchmark with its own results, not a
  scientific study.

## Adding a method (if asked how)

1. `.venv/bin/move-openlab method new my_method --problem public-ride-matching --dir plugins --author "Your name"`
   creates `plugins/my_method/plugin.py` from the template.
2. Write `solve(instance, config)` returning `decisions` (and optionally a status and declared values).
3. `.venv/bin/move-openlab method check plugins/my_method --bundle <experiment bundle>` reads the metadata without
   running it, runs the self-test in the sandbox and runs the method on the bundle's frozen scenarios.
4. In the interface: **+ Add method → Register my method → Run with this method**, then **Compare** (*Methods* tab).

The full worked example, with its verified outputs, is [ADD_YOUR_METHOD.md](ADD_YOUR_METHOD.md).

## French speaking script (texte à dire)

1. « MOVE OpenLab est un laboratoire d'expérimentation reproductible pour la recherche en optimisation. Une
   expérience est un enregistrement figé : scénarios, méthodes, configuration, exécutions et environnement. »
2. « Voici la démonstration de Montbéliard : des trajets observés de la base ouverte RPC et le réseau routier
   OpenStreetMap. Chaque solution est revérifiée par le validateur indépendant du problème ; sur l'échantillon 1,
   15 passagers sur 30 sont servis et 28,3 kg de CO₂ sont évités, calculés par la plateforme à partir des décisions
   validées. »
3. « Je génère un scénario : 20 conducteurs, 30 passagers, graine 21. La graine et le réseau suffisent à le
   régénérer à l'identique. La méthode exacte sert 13 passagers, l'heuristique gloutonne 11. »
4. « Seule la méthode exacte peut revendiquer l'optimalité ; une limite de temps n'est jamais présentée comme un
   optimum. »
5. « Changer un paramètre d'émission crée une nouvelle configuration traçable : mêmes décisions, autres chiffres de
   CO₂, et l'original reste verrouillé. »
5b. « Pour comparer les algorithmes, inutile de chercher une autre expérience : « Comparer les méthodes » les met côte à
   côte sur les mêmes scénarios figés. »
6. « La comparaison porte exactement sur les expériences cochées, avec une référence explicite. La comparabilité est
   décidée affirmation par affirmation : résultats, temps de calcul, CO₂. »
7. « Les graphiques et les métriques personnalisées partent des chiffres validés ; le code d'une métrique tierce
   ne s'exécute que dans le bac à sable. »
8. « J'ajoute ma propre méthode : son code est épinglé par son empreinte SHA-256 et testé dans le bac à sable ; elle
   est comparée sur exactement les mêmes scénarios figés. »
9. « J'exporte un seul fichier ZIP ; une collègue l'importe : l'intégrité est vérifiée avant toute écriture, puis la
   ré-exécution indépendante reproduit les mêmes résultats validés. »
10. « Validation, reproductibilité et comparabilité sont trois énoncés distincts, jamais fusionnés en un score. »

## Fallback plan

| If … | Then |
|---|---|
| A solve takes longer than expected | The job panel shows the stages; **Cancel** stops it. Continue on the locked demonstration (its results need no solver). A run is limited by the solver's time limit (60 s) and the run timeout (120 s); a run killed at its timeout is rejected and records why |
| The sandbox is unavailable (plug-ins refused) | Say so — the platform refuses rather than running unsandboxed code. Show step 8 from the screenshots of the review package |
| No network | Everything above is local. Map tiles: start with `MOVE_OPENLAB_TILE_URL=none ./start-local.sh` for maps without a background (routes and markers still drawn). Place search is not used in this demonstration |
| The road network of the area is missing | Skip step 3; use the demonstration (steps 1–2, 4–8) and the fallback bundle for step 9 |
| The import fails | Show the inspection: what is refused and why (nothing is written); import the fallback bundle |
| The browser misbehaves | Reload: the Workspace restores the experiment, scenario, result, methods and map view |

## Claims that may be presented publicly

May be said:
- Every solution shown is re-checked by the problem's independent validator; figures shown are the validator's.
- Experiments are frozen, locked records; changes create new, traceable experiments or scenario versions.
- A bundle is one ZIP whose integrity (SHA-256 of every member and of the manifest, fingerprints, evidence report) is
  verified before anything is imported; checksums detect modification, they are not signatures.
- An independent re-execution in another workspace reproduced the validated results (as in step 9).
- Comparability is decided per claim (results, runtime, CO₂) with the reasons listed.
- Third-party method and metric code runs in a verified sandbox, pinned by its code hash, and is refused rather than
  run unsandboxed.
- The demonstration uses public data: RPC open data (Licence Ouverte / Open Licence, Etalab) and OpenStreetMap
  (© OpenStreetMap contributors, ODbL).

Do not say:
- that a synthetic scientific benchmark beyond the public methodological one is available or confirms earlier figures;
- that a heuristic, a time-limited solve or a runtime comparison across machines proves anything about optimality
  or speed in general;
- that MOVE OpenLab is released or at version 1.0.0 before a public release exists (it is a development build; the
  Apache-2.0 licence applies from the first publication);
- any figure from a non-public study, or the name of a private model or unpublished experiment.
