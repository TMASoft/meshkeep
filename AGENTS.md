# MeshKeep Agent Guide

## Working Rules

- Inspect the relevant implementation, tests, and existing GitHub issues before changing code.
- Keep changes focused. Do not mix unrelated cleanup, formatting, or refactors into a feature or bug-fix change.
- Never commit, tag, push, or open a pull request unless the user explicitly requests it.
- Do not add secrets, real device paths, host-specific IDs, credentials, or private deployment configuration to tracked files.
- Run the narrowest relevant tests first, then run the applicable project checks before proposing a release.

## GitHub Issue Tracking

- Every feature, bug fix, security fix, reliability fix, and operational change must have a GitHub issue before implementation starts.
- Search open and closed issues first. Reuse the existing issue when it covers the work; otherwise create a focused issue with problem statement, scope, and acceptance criteria.
- Keep one issue per independently releasable behavior. Link dependent issues rather than combining unrelated work.
- Reference the issue in commits and pull requests using `Fixes #<number>`, `Closes #<number>`, or `Addresses #<number>` as appropriate.
- Update the issue with material scope changes, test evidence, migration or operator impact, and follow-up work discovered during implementation.
- Close an issue only after its acceptance criteria are implemented and verified. Do not close issues merely because a partial implementation was merged.

## Versioning And Releases

- Treat `package.json` at the repository root as the authoritative application version. Keep any lockfile or release metadata synchronized when it changes.
- Before pushing a feature or fix to GitHub, choose and apply a new Semantic Versioning version:
  - Patch: backward-compatible bug, reliability, security, or operational fix.
  - Minor: backward-compatible feature.
  - Major: incompatible API, database, configuration, or user-visible behavior change.
- Pre-release versions must use valid SemVer prerelease identifiers, such as `0.1.4-beta.1`. Never reuse a published version or tag.
- Update user-facing release notes, documentation, or migration guidance whenever behavior, configuration, API, storage schema, or deployment changes.
- Release tags must be exactly `v<package-version>`. The release workflow publishes on `v*` tags, so verify the tag, root package version, and intended Docker image tags match before pushing a tag.
- Do not push a feature or fix with an unchanged version. Documentation-only changes may retain the current version unless they alter release or deployment behavior.

## Verification

- Run tests for changed packages and add regression coverage for defects.
- Run `npm run typecheck`, `npm run lint`, and `npm run build` before a release unless the user explicitly accepts a documented exception.
- Run `npm test` before a release when the environment supports the affected hardware-independent tests.
- For database changes, provide forward migration coverage and document backup, upgrade, rollback, and compatibility impact.
- For API or WebSocket changes, verify input validation, authorization, compatibility, and slow-client/error behavior.
- For browser-direct radio changes, test server ownership handoff, failure rollback, and offline sync behavior.

## Delivery Notes

- Report the issue number, version change, tests run, and any release or migration requirements in the final handoff.
- Call out unrun tests, hardware validation gaps, and known residual risks explicitly.
