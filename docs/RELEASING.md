# Release procedure

Releases follow [GITFLOW.md](GITFLOW.md) and Semantic Versioning. Every step that changes a remote repository is
performed by the maintainer.

## 1. Prepare

```bash
git switch develop && git pull
git switch -c release/X.Y.Z
```

- Set `__version__` in `src/move_openlab/__init__.py` and `version` in `frontend/package.json` to `X.Y.Z`.
- Move the `Unreleased` entries of `CHANGELOG.md` under `## X.Y.Z — YYYY-MM-DD`.
- Only release fixes are allowed on the release branch.

## 2. Verify

```bash
.venv/bin/python -m pytest
```

```bash
.venv/bin/python scripts/check_public_safety.py --require-denylist --denylist <path-outside-repo>/public_denylist.txt
```

```bash
.venv/bin/python scripts/smoke_synthetic.py
```

```bash
cd frontend && npm ci && npm run build
```

```bash
ruff check src tests scripts plugins
```

- Clean-install test: copy the tracked files to an empty directory, create a fresh virtual environment, install,
  run the tests and build the frontend.
- Dependency licences: runtime Python and npm dependencies remain permissive (MIT, BSD, ISC, Apache-2.0, PSF).
- Browser check of the main workflows on desktop and phone widths, with a test account.

Also check: documentation links, no credentials or generated data in the tree, licence and notices present, and that
every number quoted in the documentation comes from an executed run of this version.

## 3. Publish

1. Open a pull request `release/X.Y.Z` → `main`; merge with a merge commit after CI and review.
2. Tag the merge commit: `git tag -a vX.Y.Z -m "MOVE OpenLab X.Y.Z"` and push the tag.
3. Open a pull request `main` → `develop` (or `release/X.Y.Z` → `develop`) to back-merge.
4. Create the GitHub release from the tag with the changelog section.

## Hotfixes

Branch `hotfix/X.Y.Z+1` from `main`, fix with a regression test, then follow steps 2–4.

## First public release checklist

- [ ] Apache-2.0 `LICENSE` and `NOTICE` added after ownership and third-party rights are verified; README licence section updated
- [ ] Authentic logo and demonstration video (supplied by the maintainer)
- [x] Screenshots generated from a real local run (`docs/assets/screenshots/`)
- [ ] Verified LinkedIn, Google Scholar and ORCID links; scientific references and citation file
- [x] Code of Conduct and security contact address
- [ ] Production tile service and place-search policy decided (`MOVE_OPENLAB_TILE_URL`, `MOVE_OPENLAB_GEOCODER_URL`)
- [ ] Private vulnerability reporting enabled; `PUBLIC_DENYLIST` secret configured; rulesets applied
- [ ] Repository visibility changed by the maintainer
