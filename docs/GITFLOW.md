# Branching model and repository settings

MOVE OpenLab follows GitFlow.

| Branch | Purpose | Created from | Merged into |
|---|---|---|---|
| `main` | Stable releases only; every commit on `main` is a tagged release (`vX.Y.Z`) | — | — |
| `develop` | Integration branch; always passes CI | `main` (once) | — |
| `feature/<topic>` | New functionality | `develop` | `develop` (pull request) |
| `fix/<topic>` | Bug fixes for the next release | `develop` | `develop` (pull request) |
| `docs/<topic>` | Documentation only | `develop` | `develop` (pull request) |
| `release/<X.Y.Z>` | Release preparation: version bump, changelog, final fixes | `develop` | `main` (pull request, tag), then back into `develop` |
| `hotfix/<X.Y.Z>` | Urgent fix of a released version | `main` | `main` (pull request, tag), then back into `develop` |

Branch names use lowercase letters, digits, `.`, `_` and `-` after the prefix. CI refuses pull requests that do not
follow the table (job `gitflow` in `.github/workflows/ci.yml`).

Flow: `feature/*` → pull request → `develop` → `release/*` → `main` (tag) → back-merge into `develop`.

## Rules

- Every change reaches `develop` and `main` through a pull request with green CI.
- Plan significant changes in an issue before implementing them.
- Never break existing behaviour to add a feature; breaking changes need an explicit decision and a migration path.
- Any change to an instance schema, validator, objective or bundle format bumps its version identifier, so stored
  campaigns stay verifiable.
- Run the full test suite and the confidentiality gate before opening a pull request.
- Never commit credentials, research data, generated campaigns or results.
- Commit messages: `<type>: <summary>` with type in `feat`, `fix`, `docs`, `test`, `refactor`, `ci`, `chore`, `release`.
  No automated co-author or tool-attribution trailers.
- Merge strategy: squash for `feature/*`, `fix/*`, `docs/*` into `develop`; merge commits (no squash) for
  `release/*` and `hotfix/*` into `main` and their back-merges, so release history is preserved.

## Versioning

Semantic Versioning. Tags `vX.Y.Z` on `main` only. Pre-1.0 versions may change interfaces between minor versions;
this is stated in the changelog. See [RELEASING.md](RELEASING.md).

## Initialization sequence (empty history)

Prepared, not yet executed — each step needs the maintainer's approval.

```bash
# 1. root commit on main: empty, so that main contains releases only
git switch main                                  # the unborn default branch is already named main
git commit --allow-empty -m "chore: initialize repository"
```

```bash
# 2. integration branch with the reviewed foundation
git switch -c develop
git add -A
git status --short                               # must list exactly the reviewed files
python scripts/check_public_safety.py --require-denylist --denylist <path-outside-repo>/public_denylist.txt
git commit -m "feat: MOVE OpenLab public framework foundation (0.2.0)"
```

```bash
# 3. publish both branches (later, separately approved)
git push -u origin main
git push -u origin develop
```

The first release then goes through `release/<version>` → `main` with a tag.

## Recommended GitHub settings (after the first push)

Apply as repository rulesets (or classic branch protection) by the maintainer:

| Setting | `main` | `develop` |
|---|---|---|
| Require a pull request before merging | yes | yes |
| Required approvals | 1 (see note) | 1 (see note) |
| Require review from Code Owners | yes | yes |
| Dismiss stale approvals on new commits | yes | yes |
| Require status checks: `gitflow`, `backend (3.11)`, `backend (3.12)`, `frontend` | yes | yes |
| Require branches to be up to date | yes | no |
| Require conversation resolution | yes | yes |
| Block force pushes | yes | yes |
| Restrict deletions | yes | yes |
| Allowed merge methods | merge commit | squash, merge commit |

Note for a single maintainer: GitHub does not let an author approve their own pull request. Until a second
maintainer joins, either set required approvals to 0 while keeping all other rules, or add the maintainer as a
bypass actor in the ruleset. Remove the exception when a second reviewer is available.

Repository-level settings:
- Default branch: `develop` until the first release, then optionally `main`.
- Enable private vulnerability reporting (see [SECURITY.md](../SECURITY.md)), Dependabot alerts and security updates,
  secret scanning and push protection.
- Add the Actions secret `PUBLIC_DENYLIST` (one confidential screening term per line; never committed).
- Disable merge methods not listed above; automatically delete head branches after merge.
