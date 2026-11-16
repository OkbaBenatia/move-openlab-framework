# Diagrams

Eight diagrams of the framework. Each is embedded below as a Mermaid block, which GitHub renders, and kept as a source file
under [`docs/diagrams/`](diagrams/) for reuse in slides or papers. Every name in them is generic or belongs to the public
demonstrations.

| # | Diagram | Source |
|---|---|---|
| 1 | [Generic architecture](#1-generic-architecture) | [`diagrams/01-architecture.mmd`](diagrams/01-architecture.mmd) |
| 2 | [Adapters](#2-adapters) | [`diagrams/02-adapters.mmd`](diagrams/02-adapters.mmd) |
| 3 | [From scenario to results](#3-from-scenario-to-results) | [`diagrams/03-pipeline.mmd`](diagrams/03-pipeline.mmd) |
| 4 | [Export, import and reproduction between two researchers](#4-export-import-and-reproduction-between-two-researchers) | [`diagrams/04-exchange.mmd`](diagrams/04-exchange.mmd) |
| 5 | [Roles and authorization](#5-roles-and-authorization) | [`diagrams/05-roles.mmd`](diagrams/05-roles.mmd) |
| 6 | [Optional restricted problem package in one application](#6-optional-restricted-problem-package-in-one-application) | [`diagrams/06-restricted-package.mmd`](diagrams/06-restricted-package.mmd) |
| 7 | [Scientific comparison and map visualization](#7-scientific-comparison-and-map-visualization) | [`diagrams/07-comparison.mmd`](diagrams/07-comparison.mmd) |
| 8 | [GUI and CLI](#8-gui-and-cli) | [`diagrams/08-gui-cli.mmd`](diagrams/08-gui-cli.mmd) |

## 1. Generic architecture

The interface talks to one HTTP API; the store keeps workspaces, experiments and their lineage as files; methods run in isolated
processes and every result passes through the problem's independent validator before it is stored. Problem packages,
dataset providers and the geography layer plug into the core, which never interprets what a driver or a route is.
Details: [ARCHITECTURE.md](ARCHITECTURE.md).

```mermaid
flowchart LR
  UI["Web interface<br/>React, maps, charts"] --> API["HTTP API<br/>FastAPI, accounts, sessions"]
  API --> STORE["Store<br/>workspaces, experiments, lineage, lock"]
  PKG["Problem packages<br/>entry point move_openlab.problems"] --> REG["Problem registry"]
  REG --> STORE
  STORE --> RUN["Isolated execution<br/>worker process, sandbox for plug-ins"]
  RUN -->|"decisions"| VAL{{"Independent validator"}}
  VAL --> STORE
  STORE --> BUN["Bundles<br/>export, verify, import"]
  BUN --> STORE
  STORE --> ANA["Analysis<br/>compare, reproducibility, comparability"]
  GEO["Geography<br/>areas, road networks, routing"] --> STORE
  DATA["Dataset providers<br/>open data, CSV, GeoJSON"] --> GEO
  JOBS["Background jobs<br/>progress, cancel, trace"] --> RUN
  STORE --> FILES[("Data directory<br/>JSON files, SQLite accounts")]
```

## 2. Adapters

A problem package brings the problem, its reference solvers and, when it has them, learned methods; method plug-ins and
custom metrics are third-party files that run only in the sandbox; a dataset provider turns a file format or a service into
normalised trips. Whatever produced the decisions, the problem's validator recomputes feasibility and every metric.
Details: [ADAPTERS.md](ADAPTERS.md).

```mermaid
flowchart TB
  subgraph PACKAGE["Problem package, installed"]
    P["Problem<br/>scenarios, validator, objective, metrics"]
    S["Solver or heuristic<br/>built-in method"]
    L["Learned or hybrid method<br/>scorer, candidate view, ML evaluation"]
  end
  subgraph PLUGINS["Plug-ins, sandboxed: approved folder or the account's own uploads"]
    M["Method plug-in<br/>plugin.py, code hash pinned"]
    C["Custom metric<br/>metric.py"]
  end
  D["Dataset provider<br/>entry point move_openlab.dataset_providers"]
  CORE["Framework core<br/>registry, store, runner, analysis"]
  V{{"Independent validator of the problem"}}
  S --> P
  L --> P
  P -->|"entry point move_openlab.problems"| CORE
  D -->|"normalised trips"| CORE
  M -->|"decisions"| CORE
  C -->|"figure from validated inputs"| CORE
  CORE -->|"every decision set"| V
  V -->|"feasibility and metrics"| CORE
```

## 3. From scenario to results

A scenario is built into a frozen, content-addressed instance that already contains its candidates (for ride matching: the
compatible pairs with their travel times). A method — optionally after a reduction of the candidates — returns decisions;
the validator accepts or rejects them, and only accepted runs get results and domain figures. Rejected runs are kept.
Details: [SOLVER_INTEGRATION.md](SOLVER_INTEGRATION.md), [ML_INTEGRATION.md](ML_INTEGRATION.md).

```mermaid
flowchart LR
  A["Area and road network"] --> SC["Scenario<br/>participants, vehicles, constraints"]
  B["Mobility data<br/>or synthetic demand"] --> SC
  SC --> CG["Candidate generation<br/>snap to the network, travel times, compatible pairs"]
  CG --> I["Frozen instance<br/>content-addressed"]
  I --> RED["Optional reduction<br/>scorer and threshold"]
  I --> SOL["Method<br/>solver, heuristic or learned"]
  RED --> SOL
  SOL -->|"decisions and declared status"| VAL{{"Independent validator"}}
  VAL -->|"accepted"| RES["Results<br/>validated metrics, times, optimality scope"]
  VAL -->|"rejected"| REJ["Rejected run<br/>kept with its errors"]
  RES --> DOM["Domain figures<br/>CO2 from validated decisions"]
  RES --> LOCK["Locked experiment<br/>checksum"]
```

## 4. Export, import and reproduction between two researchers

Researcher A locks and exports one bundle; researcher B inspects it before anything is stored, imports it, re-executes it,
adds a method and sends the extension back. The two workspaces may be on one installation or on two: the path is the same.
Details: [MULTI_USER.md](MULTI_USER.md#export--import--reproduce-between-two-researchers), [REPRODUCIBILITY.md](REPRODUCIBILITY.md).

```mermaid
sequenceDiagram
  participant A as Researcher A
  participant IA as Workspace of A
  participant IB as Workspace of B
  participant B as Researcher B
  A->>IA: Run methods on frozen scenarios
  IA-->>A: Validated results
  A->>IA: Lock and export
  IA-->>A: One bundle file and its SHA-256
  A->>B: Send the bundle and the SHA-256
  B->>IB: Import a bundle file
  IB-->>B: Inspection report, nothing stored yet
  B->>IB: Import experiment
  IB-->>B: Imported, integrity verified
  B->>IB: Run again
  IB-->>B: Reproduced or not, cell by cell
  B->>IB: Add a method and run
  IB-->>B: Extension on the same frozen scenarios
  B->>IB: Compare, then export the extension
  B->>A: Send the extended bundle
```

## 5. Roles and authorization

Every account has its own isolated workspace; roles decide who manages accounts. An administrator manages accounts,
extensions and reads the audit log; a researcher allowed to supervise manages their own students only. Access to a
restricted problem is a per-account grant that no role implies.
Details: [MULTI_USER.md](MULTI_USER.md), [SECURITY_MODEL.md](SECURITY_MODEL.md).

```mermaid
flowchart TB
  ADM["Administrator"]
  RES["Researcher"]
  SUP["Researcher allowed<br/>to supervise students"]
  STU["Student"]
  ACC["Accounts<br/>create, reset, deactivate"]
  OWN["Own students only<br/>create, reset, deactivate"]
  EXT["Extensions<br/>grant restricted problems"]
  AUD["Audit log"]
  W1["Own isolated workspace"]
  W2["Own isolated workspace"]
  W3["Own isolated workspace"]
  W4["Own isolated workspace"]
  RP["Restricted problem"]
  ADM --> W1
  ADM --> ACC
  ADM --> EXT
  ADM --> AUD
  RES --> W2
  SUP --> W3
  SUP --> OWN
  STU --> W4
  EXT -.->|"per-account grant, no role implies it"| RP
  ACC -.->|"recorded"| AUD
  OWN -.->|"recorded"| AUD
  EXT -.->|"recorded"| AUD
```

## 6. Optional restricted problem package in one application

There is one application. A restricted problem package is installed next to the framework and granted to named accounts;
a granted account reaches it through the ordinary pages and gets a *Private Research* entry. For every other account the
server answers as if the package were not installed, and an installation without such a package has nothing to show.
Details: [PRIVATE_EXTENSIONS.md](PRIVATE_EXTENSIONS.md).

```mermaid
flowchart TB
  ADMIN["Administrator<br/>Administration, Extensions"]
  U1["Granted account"]
  U2["Any other account<br/>whatever its role"]
  subgraph APP["One application, one installation"]
    CORE["Framework and public problems<br/>open to every account"]
    GR["Grants<br/>problem id and account names"]
    CHK{"Is the account granted?"}
    PKG["Optional restricted problem package<br/>installed next to the framework"]
    PR["Private Research entry<br/>same Workspace and Compare pages"]
    NF["Not found, as if not installed<br/>refusal recorded in the audit log"]
  end
  ADMIN -->|"sets the list of accounts"| GR
  U1 --> CORE
  U2 --> CORE
  U1 --> CHK
  U2 --> CHK
  GR --> CHK
  CHK -->|"yes"| PKG
  CHK -->|"no"| NF
  PKG --> PR
```

## 7. Scientific comparison and map visualization

Two experiments, or two methods of one experiment, are matched scenario by scenario on their frozen instances. Validation,
reproducibility and semantic comparability stay three separate statements; the same matched data feeds the results table,
the charts, two synchronised maps (routes, candidate edges, replay) and the scenario-by-scenario diff.
Details: [METRICS.md](METRICS.md), [MAPS.md](MAPS.md).

```mermaid
flowchart LR
  E1["Experiment A<br/>or method A"] --> M["Scenario matching<br/>by frozen instance"]
  E2["Experiment B<br/>or method B"] --> M
  M --> EV["Evidence, kept separate"]
  EV --> V["Independent validation"]
  EV --> R["Reproducibility"]
  EV --> S["Semantic comparability<br/>results, runtime, CO2"]
  M --> T["Results table<br/>chosen metrics and their basis"]
  M --> CH["Charts<br/>CSV, PNG, SVG"]
  M --> MP["Two synchronised maps"]
  MP --> RT["Routes<br/>validated solution on roads"]
  MP --> CE["Candidate edges<br/>before, after, solution"]
  MP --> RP["Replay<br/>one clock"]
  M --> DF["Diff<br/>scenario by scenario"]
```

## 8. GUI and CLI

The browser interface and the `move-openlab` command reach the same core. The GUI goes through the HTTP API with the
account's session; `move-openlab serve` starts that API and the interface, `users` manages accounts in the credential store,
and `method new` / `method check` generate a method template and check it — metadata, sandboxed self-test and, with an
experiment bundle, a validated run on its instances. Every result of either route passes the problem's independent validator.

```mermaid
flowchart LR
  GUI["GUI<br/>web interface"] --> API["HTTP API<br/>accounts, roles"]
  CLI["CLI<br/>move-openlab"] -->|"serve"| API
  CLI -->|"users, method"| CORE
  API --> CORE["Core<br/>store, runner,<br/>bundles"]
  AD["Adapters<br/>problems, solvers,<br/>ML, data, metrics"] --> CORE
  CORE --> RUN["Execution<br/>sandbox"]
  RUN --> V{{"Independent<br/>validation"}}
  V --> OUT["Metrics, maps,<br/>comparison"]
  OUT --> EX["Export, import,<br/>reproduction"]
  EX -.->|"another installation"| CORE
```

## Editing a diagram

Edit the `.mmd` source and copy it into the block above; the two must stay identical. Keep the syntax plain — `flowchart`
or `sequenceDiagram`, quoted labels, `<br/>` for line breaks — so that GitHub renders it. Use public or synthetic names only.
