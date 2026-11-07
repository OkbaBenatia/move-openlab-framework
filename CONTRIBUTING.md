# Contributing to MOVE OpenLab

Students, researchers, developers and companies are welcome to contribute: bug reports, documentation, new
benchmarks (problem packages), method plugins, dataset providers, analysis features and interface improvements.
Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Before you start

- Open an issue (bug report or feature request) and describe the change before writing significant code.
- Security issues: do not open a public issue; follow [SECURITY.md](SECURITY.md).
- Synthetic or openly licensed data only. Never include credentials, personal data or unpublished research material.
- Data connectors must name the data licence and attribution and must not store identifiers
  ([docs/DATASETS.md](docs/DATASETS.md)).

## Development setup

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for installation, local accounts, the development server and the
test suite.

## Workflow

We use GitFlow ([docs/GITFLOW.md](docs/GITFLOW.md)):

1. Branch from `develop`: `feature/<topic>`, `fix/<topic>` or `docs/<topic>`.
2. Make focused commits: `<type>: <summary>` (`feat`, `fix`, `docs`, `test`, `refactor`, `ci`, `chore`).
3. Run the checks below.
4. Open a pull request into `develop` and fill in the template.

## Checks before a pull request

```bash
.venv/bin/python -m pytest
```

```bash
.venv/bin/python scripts/check_public_safety.py
```

```bash
ruff check src tests scripts plugins
```

```bash
cd frontend && npm run build
```

Add regression tests with every fix, and tests for every new capability. Existing tests must keep passing. Pull
requests are reviewed by the maintainer and never merged automatically.

## Design rules

- The framework core is problem-agnostic. Problem-specific logic belongs in a problem package
  ([docs/EXTENDING.md](docs/EXTENDING.md)).
- Methods never validate themselves: every metric is recomputed by the problem's validator.
- Changing an instance schema, validator, objective or bundle format requires a new version identifier.
- Plugins never run outside the verified sandbox unless an administrator chose trusted-process mode
  ([docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)).
- Keep interface text short and precise; report only numbers produced by executed runs.

## Licence of contributions

The project is intended to be released under the Apache License 2.0, subject to the final verification of ownership
and third-party rights. Contributions are accepted once the licence file is published; by submitting a pull request
you confirm that you have the right to submit the work and agree that it is distributed under the project licence.
New dependencies must have a licence compatible with Apache-2.0 (no copyleft or field-of-use restrictions).
