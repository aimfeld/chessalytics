# Git Workflow Reference

Lookup detail for GitLab Flow in this repo. The branch model, squash-merge rule, and pre-merge gate live in the root `CLAUDE.md` because they fire on every merge; everything here is consulted on demand.

## Branch model recap

`main` is the integration trunk (pushing to it never deploys); `production` tracks the exact commit running in prod. Adopted 2026-05-16.

- The `main` squash-merge route relies on branch protection with `enforce_admins: false`. If that flips to `true`, revert to the PR route.
- CodeQL runs post-merge on `main`.
- `bin/deploy.sh` re-runs full CI before shipping `production`, which is the real gate.

## Release promotion

At a milestone boundary (or any approved release point): open a PR `main → production`, merge it, then run `bin/deploy.sh`. The `/deploy` skill automates the whole flow.

**Gotcha: `gh pr checks` reporting "no checks" on a release PR means it's unmergeable** — usually a missing forward-port of the previous release. Fix with `git merge -s ours origin/production` on `main`, push, and the check starts. Note "no checks reported" can also be a post-push race; check `mergeable` first.

**`gh pr checks --watch` is not a CI gate** — it exits 0 even on FAILED checks. Use `gh run watch <id> --exit-status`.

**Preflight: local `main` must equal `origin/main`.** The release PR is cut from `origin/main`, so unpushed local commits are silently dropped. Verify `git rev-list --left-right --count main...origin/main` returns `0 0`.

## Hotfix flow

Urgent prod fix without shipping unreleased `main`:

1. `git checkout -b hotfix/<slug> production`
2. Apply the minimal fix, PR into `production`, merge when approved.
3. `bin/deploy.sh` (deploys `production`).
4. **Forward-port**: merge `production` back into `main` (or cherry-pick the fix) so it isn't lost at the next release. Expect conflicts when `main` has diverged — resolve in favour of the prod-safe value.

Forward-port after **every** release, not just the last one: back-to-back releases conflict otherwise, and `bin/deploy.sh` skips the step whenever you are not on a clean `main` checkout.

## Changelog

Releases are cut at the **milestone** boundary, not per phase. Changes accumulate in `CHANGELOG.md` under `## [Unreleased]` as phases merge, then get promoted to a versioned section when the milestone ships.

### Per-phase (when a phase merges to `main`)

Append bullets under `## [Unreleased]`, grouped into `### Added` / `### Changed` / `### Fixed` / `### Removed` / `### Security` / `### Tests`. Reference the phase number. Keep the tone terse and user-facing (what changed, not how). Skip for `/gsd-quick` / `/gsd-fast` tasks that don't meaningfully change behavior (pure refactors, tooling tweaks, internal cleanup).

### Per-milestone (at milestone close)

When a milestone ships (e.g. via `/gsd-complete-milestone`), **all of the following are mandatory — none are optional**:

1. In `CHANGELOG.md`, rename `## [Unreleased]` → `## [vX.Y] Milestone Title — YYYY-MM-DD`, reset `[Unreleased]` to empty, and update the compare links at the bottom.
2. **Archive the milestone's phase directories**: `git mv .planning/phases/<phase-dir> .planning/milestones/vX.Y-phases/` for every phase in the milestone (create the target dir if absent), so `.planning/phases/` holds only the next milestone's active work. This is separate from the milestone-doc archival — `/gsd-complete-milestone` archives MILESTONES/ROADMAP/RETROSPECTIVE/REQUIREMENTS but does NOT move the phase working dirs.
3. Tag and push: `git tag vX.Y && git push origin vX.Y`.
4. **`gh release create vX.Y`** using the `CHANGELOG.md` section as the body — the tag alone is not a release. Verify with `gh release list` that vX.Y shows up; a lingering tag with no GitHub release means this step was skipped.

Never cut a release without a matching `CHANGELOG.md` entry. Never edit a released section retroactively — corrections go in a new `[Unreleased]` bullet.
