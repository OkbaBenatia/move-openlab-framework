## Summary

<!-- What changes and why. Link the issue: "Closes #<number>". -->

## Type

- [ ] Feature (`feature/*` → `develop`)
- [ ] Fix (`fix/*` → `develop`)
- [ ] Documentation (`docs/*` → `develop`)
- [ ] Release (`release/*` → `main`, back-merged into `develop`)
- [ ] Hotfix (`hotfix/*` → `main`, back-merged into `develop`)

## Checklist

- [ ] Existing behaviour is preserved, or the breaking change is described and approved below
- [ ] Tests added or updated; `python -m pytest` passes locally
- [ ] Frontend builds (`npm run build` in `frontend/`) when UI files changed
- [ ] `python scripts/check_public_safety.py` reports no finding
- [ ] Documentation updated (README, `docs/`, CHANGELOG `Unreleased` section)
- [ ] No credentials, research data, private code or generated results are included
- [ ] Numbers quoted in docs or UI come from executed runs, not estimates

## Security and reproducibility impact

<!-- Plugin execution, authentication, bundle format, hashes, checksums or validators: describe the impact.
     A change to an instance schema, validator or objective must bump its version. Otherwise write "None". -->

## Breaking changes

<!-- "None", or what breaks and the migration path. -->
