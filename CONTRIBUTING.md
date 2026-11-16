# Contributing to MOVE OpenLab

Students, researchers, developers and companies are welcome to contribute: bug reports, documentation, new
benchmarks (problem packages), method plug-ins, dataset providers, analysis features and interface improvements.
Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Before you start

- Open an issue (bug report or feature request) and describe the change before writing significant code.
- Security issues: do not open a public issue; follow [SECURITY.md](SECURITY.md).
- Synthetic or openly licensed data only. Never include credentials, personal data or unpublished research material.
- This repository holds the generic framework and its public demonstrations. A restricted problem package, its data
  and its results stay in their own repository ([docs/PRIVATE_EXTENSIONS.md](docs/PRIVATE_EXTENSIONS.md)); do not
  name private studies, datasets or people in code, documentation, issues or commit messages.
- Data connectors must name the data licence and attribution and must not store identifiers
  ([docs/DATASETS.md](docs/DATASETS.md)).

## Development setup

See [docs/INSTALL.md](docs/INSTALL.md) for installation and configuration, and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for local accounts, the development server and the test suite.

## Where a contribution goes

| Contribution | Where | Guide |
|---|---|---|
| A new optimization problem | its own installable package (entry-point group `move_openlab.problems`), or `src/move_openlab/benchmarks/` when it is public and maintained with the framework | [docs/ADAPTERS.md](docs/ADAPTERS.md) |
| A solver or heuristic for an existing problem | a built-in method of the problem package, or a plug-in under `plugins/` | [docs/SOLVER_INTEGRATION.md](docs/SOLVER_INTEGRATION.md), [docs/ADD_YOUR_METHOD.md](docs/ADD_YOUR_METHOD.md) |
| A learned method | with its problem package, including its model | [docs/ML_INTEGRATION.md](docs/ML_INTEGRATION.md) |
| A custom metric | `plugins/<name>/metric.py` | [docs/METRICS.md](docs/METRICS.md#custom-metrics) |
| A trip data source | a dataset provider (entry-point group `move_openlab.dataset_providers`) | [docs/DATASETS.md](docs/DATASETS.md#writing-a-dataset-provider) |
| Interface text | English in the components; French in `frontend/src/i18n/` | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |

## Workflow

We use GitFlow ([docs/GITFLOW.md](docs/GITFLOW.md)):

1. Branch from `develop`: `feature/<topic>`, `fix/<topic>` or `docs/<topic>`.
2. Make focused commits: `<type>: <summary>` (`feat`, `fix`, `docs`, `test`, `refactor`, `ci`, `chore`).
3. Run the checks below.
4. Open a pull request into `develop` and fill in the template.

Commits and files carry no automated attribution trailer; the confidentiality gate refuses them.

## Checks before a pull request

The same checks run in CI (`.github/workflows/ci.yml`); a pull request must pass all of them.

```bash
MOVE_OPENLAB_REQUIRE_SANDBOX=1 .venv/bin/python -m pytest
```

```bash
.venv/bin/python scripts/check_public_safety.py
```

```bash
.venv/bin/ruff check src tests scripts plugins
```

```bash
npm --prefix frontend run lint
```

```bash
npm --prefix frontend test
```

```bash
npm --prefix frontend run build
```

`npm run build` includes the TypeScript type check. Without `MOVE_OPENLAB_REQUIRE_SANDBOX=1` the sandbox tests are
skipped on a machine without bubblewrap; CI sets it. The browser journeys (`.github/workflows/browser.yml`) run in
CI as well.

Add regression tests with every fix, and tests for every new capability. Existing tests must keep passing. Pull
requests are reviewed by the maintainer and never merged automatically.

## Documentation

A change of behaviour comes with its documentation in the same pull request.

- Describe what the code does now: quote real commands, environment variables, routes and file names, and leave out
  what cannot be verified. No test counts and no performance figures that were not measured by an executed run.
- Update the guide that owns the topic rather than adding a second description; add an entry under *Unreleased* in
  [CHANGELOG.md](CHANGELOG.md).
- Diagrams are Mermaid sources under `docs/diagrams/`, embedded in [docs/DIAGRAMS.md](docs/DIAGRAMS.md).
- A new dependency gets its row in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with the licence read from the
  package metadata.

## Design rules

- The framework core is problem-agnostic. Problem-specific logic belongs in a problem package
  ([docs/EXTENDING.md](docs/EXTENDING.md)). The interface never tests a problem identifier: what it shows comes from
  the problem's declarations.
- Methods never validate themselves: every metric is recomputed by the problem's validator.
- A figure that cannot be computed is shown as not configured or not available, never as zero, and never invented.
- Changing an instance schema, validator, objective or bundle format requires a new version identifier.
- Locked records are never rewritten: a change creates a new experiment or a new scenario version.
- Plug-ins never run outside the verified sandbox unless an administrator chose trusted-process mode
  ([docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)).
- Access is decided on the server, per request. Hiding an entry in the interface is never the protection.
- Keep interface text short and precise; report only numbers produced by executed runs.

## Licence of contributions

MOVE OpenLab is licensed under the Apache License, Version 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). By submitting a
pull request you confirm that you have the right to submit the work and you
agree that it is distributed under the Apache License 2.0, as stated in its section 5 for contributions. Data and
assets keep their own licences ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). A new dependency is listed there
with its licence and must be compatible with redistribution alongside Apache-2.0 code.
