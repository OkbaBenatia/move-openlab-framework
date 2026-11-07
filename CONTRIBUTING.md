# Contributing to MOVE OpenLab

Contributions are welcome: bug reports, documentation, new benchmarks (problem packages), method plugins,
analysis features and scenario sources. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Before you start

- Open an issue (bug report or feature request) and describe the change before writing significant code.
- Security issues: do not open a public issue; follow [SECURITY.md](SECURITY.md).
- Synthetic or openly licensed data only. Never include credentials, personal data or unpublished research material.

## Development setup

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
```

```bash
cd frontend && npm ci && npm run build
```

Linux with bubblewrap is needed to run the plugin sandbox tests; elsewhere they are skipped unless
`MOVE_OPENLAB_REQUIRE_SANDBOX=1` is set.

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
cd frontend && npm run build
```

Add regression tests with every fix, and tests for every new capability. Existing tests must keep passing.

## Design rules

- The framework core is problem-agnostic. Problem-specific logic belongs in a problem package
  ([docs/EXTENDING.md](docs/EXTENDING.md)).
- Methods never validate themselves: every metric is recomputed by the problem's validator.
- Changing an instance schema, validator, objective or bundle format requires a new version identifier.
- Plugins never run outside the verified sandbox unless an administrator chose trusted-process mode
  ([docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)).
- Keep interface text short and precise; report only numbers produced by executed runs.

## Licence of contributions

The project licence is being finalised before the first public release. Contributions are accepted once it is
published; by submitting a pull request you agree that your contribution is distributed under that licence.
