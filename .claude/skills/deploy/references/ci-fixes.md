# CI & Git Fix Playbook

Reference for the `deploy` skill. Covers every CI failure or git situation you're expected to resolve autonomously between preflight and squash-merge. The principle: each fix is a focused commit on `main`, push, re-watch checks. No side branches, no force-pushes.

## Quick diagnosis

```bash
gh pr checks <PR#>                       # which check is red
gh run view <run-id> --log-failed        # logs of the failing job
gh pr view <PR#> --json statusCheckRollup --jq '.statusCheckRollup[] | select(.conclusion=="FAILURE")'
```

Match the failure output to a section below. If the failure doesn't match anything here, read the log carefully, fix the root cause, and add a section to this file for next time.

---

## CI: Dependabot / security alerts blocking merge

GitHub blocks merges to `production` if a critical Dependabot CVE is open against a dependency the PR includes. The fix is to bump the affected dep in the same release PR.

**Backend (Python via uv):**

```bash
# Find which package is flagged
gh api repos/:owner/:repo/dependabot/alerts --jq '.[] | select(.state=="open") | {package: .security_vulnerability.package.name, severity: .security_advisory.severity, summary: .security_advisory.summary}'

# Bump it
uv lock --upgrade-package <package-name>
# Or if a specific minimum version is required by the CVE:
uv add '<package-name>>=<safe-version>'

# Verify nothing broke
uv run pytest -x
uv run ty check app/ tests/ scripts/

git add pyproject.toml uv.lock
git commit -m "fix(deps): bump <package> to <version> for CVE-XXXX-YYYY"
git push origin main
```

**Frontend (npm):**

```bash
# Find the issue
( cd frontend && npm audit --audit-level=high --json | jq '.vulnerabilities | to_entries | map({name: .key, severity: .value.severity, fixAvailable: .value.fixAvailable})' )

# Apply available fixes
( cd frontend && npm audit fix )

# If a transitive dep needs a manual bump:
( cd frontend && npm install <package>@<safe-version> )

# Verify
( cd frontend && npm run lint && npm test -- --run && npm run build )

git add frontend/package.json frontend/package-lock.json
git commit -m "fix(deps): bump <package> to <version> for CVE-XXXX-YYYY"
git push origin main
```

If `npm audit fix` proposes a `--force` resolution that introduces a breaking major bump, **halt** — that's a judgment call, not a mechanical fix.

---

## CI: ruff format drift

Symptom: CI step "ruff format --check" fails with "Would reformat: ...".

```bash
uv run ruff format app/ tests/ scripts/
git add -u
git commit -m "style: apply ruff format"
git push origin main
```

This is the single most common preventable CI failure on this project — see CLAUDE.md "Pre-PR checklist". The pre-push hook should catch it; if it didn't, the hook isn't installed (`bin/install_pre_push_hook.sh`).

## CI: ruff lint errors

```bash
uv run ruff check . --fix
# Inspect remaining errors that --fix couldn't resolve
uv run ruff check .
```

Auto-fixable issues commit cleanly. For manual fixes (unused imports flagged but actually needed, type narrowing, etc.), apply the smallest change that makes the rule pass. If a rule needs to be suppressed, use `# noqa: <rule-code>` with a brief reason on the same line.

```bash
git add -u
git commit -m "style: fix ruff lint findings"
git push origin main
```

## CI: ty type errors

```bash
uv run ty check app/ tests/ scripts/
```

Address each error. Common patterns from CLAUDE.md:
- Function missing return annotation → add it.
- `list[Literal[...]]` passed where invariance bites → switch parameter to `Sequence[...]`.
- SQLAlchemy forward refs / FastAPI-Users generics → `# ty: ignore[rule-name]  # <reason>`.

If a ty error is in code that pre-dates this PR (not in the diff), still fix it — CI gates the whole tree, not just the diff.

```bash
git add -u
git commit -m "fix(types): resolve ty check errors"
git push origin main
```

## CI: backend pytest failure

```bash
gh run view <run-id> --log-failed | grep -A 40 "FAILED tests/"
```

Reproduce locally:

```bash
docker compose -f docker-compose.dev.yml -p flawchess-dev up -d
uv run pytest -x tests/<failing_test_file>.py::<test_name> -v
```

If the failure is a real regression in code from this PR, fix it. If it's a flaky test (network, timing, ordering), retry once:

```bash
gh run rerun <run-id> --failed
```

If it flakes again, **halt** — flaky tests in a release PR need human judgment.

## CI: frontend lint / test / build failures

```bash
npm --prefix frontend run lint     # eslint
npm --prefix frontend test -- --run  # vitest single-pass
npm --prefix frontend run build    # vite + tsc strict
npm --prefix frontend run knip     # dead code / unused deps
```

`knip` failures are usually leftover exports or unused deps from a removed feature. Delete them.

`tsc` failures with `noUncheckedIndexedAccess` are common — narrow the index access (see CLAUDE.md Frontend section).

```bash
git add -u
git commit -m "fix(frontend): <specific issue>"
git push origin main
```

## CI: `endgameZones.ts` drift

```
ERROR: frontend/src/generated/endgameZones.ts is out of date
```

```bash
uv run python scripts/gen_endgame_zones_ts.py
git add frontend/src/generated/endgameZones.ts
git commit -m "chore: regenerate endgameZones.ts"
git push origin main
```

## CI: Alembic migration check

If CI complains about pending migrations not detected:

```bash
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "<description>"
# Inspect the generated file — autogenerate sometimes catches false positives
```

If autogenerate produces an empty migration, the model and schema are actually in sync — likely a CI cache issue, rerun the workflow.

---

## Git: branch behind origin

```
error: failed to push some refs to 'origin/main'
hint: Updates were rejected because the remote contains work you do not have locally.
```

```bash
git fetch origin main
git pull --ff-only origin main
git push origin main
```

If `--ff-only` refuses because the histories diverged, see next section.

## Git: divergence and merge conflicts

`main` has commits both locally and on `origin/main` (e.g. another machine pushed, or a Dependabot auto-merge landed).

```bash
git fetch origin main
git log --oneline HEAD..origin/main      # what's on remote that you don't have
git log --oneline origin/main..HEAD      # what's local that's not on remote
```

**Strategy: rebase local on top of remote** (keeps history linear):

```bash
git rebase origin/main
```

If the rebase is clean, just `git push origin main` and continue.

If conflicts appear:

```bash
git status
```

**Auto-resolve these (mechanical, low-risk):**
- **`uv.lock`** — accept incoming (`git checkout --theirs uv.lock`), then `uv lock` to regenerate based on current `pyproject.toml`. Stage, `git add uv.lock`, `git rebase --continue`.
- **`frontend/package-lock.json`** — same pattern: `git checkout --theirs frontend/package-lock.json && ( cd frontend && npm install ) && git add frontend/package-lock.json && git rebase --continue`.
- **`CHANGELOG.md`** — both sides added bullets under `## [Unreleased]`. Merge by keeping both sets of bullets in the same subsections. No semantic judgment needed.
- **`frontend/src/generated/endgameZones.ts`** — regenerate: `uv run python scripts/gen_endgame_zones_ts.py && git add frontend/src/generated/endgameZones.ts && git rebase --continue`.
- **Whitespace-only conflicts** — accept whichever side has the canonical formatting (usually `--theirs` since `origin/main` already passed CI).

**Halt for these:**
- Conflict in `app/**/*.py` or `frontend/src/**/*.{ts,tsx}` requires reading both sides and reasoning about intent.
- Conflict in an Alembic migration file — migration ordering is semantic, not mechanical.
- More than 5 conflicting files at once — likely a long-running divergence that needs a human.

If you halt mid-rebase, abort cleanly so the user can pick up:

```bash
git rebase --abort
```

Then report exactly which files conflicted and what each side wanted.

## Git: stale local main vs. origin after pre-push hook reformatted

The pre-push hook runs `ruff format --check`. If it modified files, your push was rejected but you have a clean local state again. Just commit the reformat and push:

```bash
git status            # should show modified files
git add -u
git commit -m "style: apply ruff format from pre-push hook"
git push origin main
```

## Git: pre-push hook failing on ty check

If the hook blocks the push because of a ty error, fix the error (don't `--no-verify`). The hook exists to catch the most common preventable CI failure.

```bash
uv run ty check app/ tests/ scripts/    # see the exact error
# fix
git add -u
git commit -m "fix(types): <description>"
git push origin main
```

## Git: PR not updating after push

GitHub usually picks up new commits within seconds. If `gh pr view <PR#>` still shows the old SHA after a minute:

```bash
gh pr view <PR#> --json headRefOid,statusCheckRollup
git rev-parse origin/main
```

If they don't match, the push didn't actually land — check `git push` exit code and retry.

---

## Deploy script failures (during step 6)

### `scp .prod.env` fails

Usually a transient network issue or SSH agent timeout.

```bash
ssh -o ConnectTimeout=5 flawchess "echo ok"    # check SSH
bin/deploy.sh                                  # retry the whole script
```

If SSH itself fails twice in a row, halt — could be the server or could be the user's network. Report which.

### "no workflow_dispatch run found on production"

Race condition between `gh workflow run` dispatching and the run appearing. The script retries 15 times at 2s intervals; if it still fails:

```bash
gh run list --workflow=ci.yml --branch=production --limit=5
```

If a run is there but the script missed it, just re-run `bin/deploy.sh`. If no run appears, the dispatch silently failed — check `gh auth status` and re-run.

### "dispatched run is on wrong branch / SHA"

This is the 2026-05-16 safety assertion firing. **Do not bypass.** It means the workflow dispatched on something other than `production@TARGET_SHA`. Investigate:

```bash
git fetch origin production
git rev-parse origin/production
gh run list --workflow=ci.yml --event=workflow_dispatch --limit=3 \
  --json databaseId,headBranch,headSha,createdAt
```

Likely cause: someone (or another deploy) pushed to `production` between the script computing `TARGET_SHA` and dispatch landing. Re-run `bin/deploy.sh` — it'll pick up the new SHA.

### CI failure during deploy run

```bash
gh run view <run-id> --log-failed
```

The deploy CI runs the same checks as PR CI. If something failed here that didn't fail on the PR, it's almost always:
- A test that depends on production env vars not present in PR CI.
- A timing-sensitive test that flaked.

For flakes: `gh run rerun <run-id> --failed`, then `bin/deploy.sh` again once green.

For real failures: the fix has to land on `main` first, then forward-merge to `production` via another PR. **Halt** and report — this is the rare case where `production` and `main` need separate fixes, and the user should make the call.

### Server SHA mismatch at end of deploy

```
ERROR: server is at <X>, expected <Y>. Deploy did not converge.
```

Container probably didn't restart cleanly. Investigate:

```bash
ssh flawchess "cd /opt/flawchess && docker compose ps"
ssh flawchess "cd /opt/flawchess && docker compose logs --tail=100 backend"
ssh flawchess "cd /opt/flawchess && git log -1 --format='%h %s'"
```

**Halt.** This is a real production-divergence situation — the deploy "passed" CI but the server isn't on the expected commit. Do not retry blindly; report container state and recent backend logs to the user.

---

## What to do if a fix attempt makes things worse

Every fix here is a clean commit on `main` — no force-push, no rebase of already-pushed commits, no branch deletion. If a commit you pushed turns out to be wrong, **add another commit that reverts or supersedes it**. Never `git reset --hard` a remote ref.

```bash
git revert <bad-commit-sha> --no-edit
git push origin main
```

This keeps the audit trail intact and is always recoverable.
