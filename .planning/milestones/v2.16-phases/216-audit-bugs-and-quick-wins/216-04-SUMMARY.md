---
phase: 216-audit-bugs-and-quick-wins
plan: 04
subsystem: infra
tags: [github-actions, ci, uv, npm, caching]

# Dependency graph
requires:
  - phase: 216-02
    provides: "the `.github/workflows/ci.yml` test job with its Caddyfile validate step and the extended deploy-job Health check header assertions, unmodified by this plan"
provides:
  - "CI test job installs uv via astral-sh/setup-uv@v10 with enable-cache: true instead of `pip install uv`"
  - "CI test job caches the npm store via actions/setup-node@v6 keyed on frontend/package-lock.json"
  - "Before-median CI wall-clock time recorded (n=7, median 567s) with a named, reproducible after-measurement point"
affects: [ci]

# Actuals (#2632)
actuals:
  tokens: 200
  tasks: 3
  commits: 2
  # Task 3 produced no code diff — it only records a measurement into this
  # SUMMARY, per the plan's own artifact table ("goes in the plan SUMMARY").

# Tech tracking
tech-stack:
  added: ["astral-sh/setup-uv@v10 (GitHub Action)"]
  patterns:
    - "GitHub Actions pinned by major tag (not SHA), matching actions/checkout@v7, actions/setup-python@v6, actions/setup-node@v6 already in this file"

key-files:
  modified:
    - .github/workflows/ci.yml

key-decisions:
  - "Re-verified astral-sh/setup-uv's current major tag via `gh api repos/astral-sh/setup-uv/releases/latest --jq .tag_name` at implementation time: v10.0.1, confirming the RESEARCH.md v10.x prediction. Pinned as `@v10`."
  - "Task 3's optional 'push the branch and trigger a workflow_dispatch run' step was skipped: the branch has no upstream configured and CLAUDE.md/project_notes forbid pushing/deploying from this session. The before-median instead comes entirely from the last 10 completed ci.yml runs already on GitHub (7 successful, going back to 2026-09-01), which the plan's own verify command treats as sufficient (n>=3)."
  - "The plan objective cites an earlier '8m49s' median from the original SEED-161 audit; this task's own fresh measurement (median 567s = 9m27s, n=7) supersedes that number as the recorded before-basis, since the audit figure's sample and date are not reproducible from this session."

requirements-completed: []

coverage:
  - id: D1
    description: "CI test job installs uv via the cached astral-sh/setup-uv@v10 action instead of `pip install uv`, with uv sync --locked --group maia-inference unchanged"
    verification:
      - kind: other
        ref: "uv run python -c \"import yaml; ...\" setup-uv/enable-cache assertion"
        status: pass
      - kind: other
        ref: "grep -c 'pip install uv' .github/workflows/ci.yml (0)"
        status: pass
      - kind: other
        ref: "grep -c 'uv sync --locked --group maia-inference' .github/workflows/ci.yml (1)"
        status: pass
      - kind: other
        ref: "uv run python -c \"...\" actions/setup-python@ retained assertion"
        status: pass
    human_judgment: false
  - id: D2
    description: "CI caches the npm store keyed on frontend/package-lock.json via actions/setup-node@v6, with npm ci unchanged"
    verification:
      - kind: other
        ref: "uv run python -c \"...\" setup-node cache/cache-dependency-path/node-version assertion"
        status: pass
      - kind: other
        ref: "git ls-files -- frontend/package-lock.json (tracked)"
        status: pass
      - kind: other
        ref: "uv run python -c \"...\" 'Install frontend dependencies' step == npm ci, working-directory: frontend"
        status: pass
    human_judgment: false
  - id: D3
    description: "Before-median CI run time recorded with sample size and raw durations; after-median deferred to the next release PR with a named, reproducible command"
    verification:
      - kind: other
        ref: "gh run list --workflow=ci.yml --limit 10 --json ... | median script -> n=7 median_s=567"
        status: pass
      - kind: other
        ref: "uv run python -c \"import yaml; ...\" trigger-set assertion == ['pull_request', 'workflow_dispatch']"
        status: pass
    human_judgment: true
    rationale: "The actual after-measurement (comparing median CI time post-cache vs. the 567s before-median) can only happen once this change runs in a real pull_request or workflow_dispatch CI run — this workflow never fires on a feature-branch push. That comparison is a follow-up item for the next release PR, not something this session can produce."

duration: ~10 min
completed: 2026-09-04
status: complete
---

# Phase 216 Plan 04: CI Dependency Caching Summary

**CI's test job now installs uv via the cached `astral-sh/setup-uv@v10` action and caches the npm store keyed on `frontend/package-lock.json`, with a recorded before-median of 567s (n=7) and the after-measurement deferred to the next release PR.**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-09-04T17:12:12Z
- **Tasks:** 3 of 3 completed
- **Files modified:** 1 (`.github/workflows/ci.yml`)

## Accomplishments

- Replaced the `Install uv` step (`run: pip install uv`) with `- uses: astral-sh/setup-uv@v10` / `with: enable-cache: true`, in the same position between `actions/setup-python@v6` and `Install Python dependencies`. Re-verified the current major tag (`v10.0.1`) via `gh api repos/astral-sh/setup-uv/releases/latest --jq .tag_name` before writing the pin. `uv sync --locked --group maia-inference` and its rationale comment are byte-identical.
- Added `cache: 'npm'` and `cache-dependency-path: frontend/package-lock.json` to the existing `actions/setup-node@v6` step, alongside the unchanged `node-version: "24"`. The path input is mandatory here since the lockfile lives in `frontend/`, not the repo root. `Install frontend dependencies` (`npm ci`, `working-directory: frontend`) is unchanged.
- Measured the before-median from the last 10 completed `ci.yml` runs on GitHub: **n=7 successful runs, median 567s (9m27s)**. Raw per-run durations (createdAt to updatedAt, in seconds): 588, 490, 540, 583, 567, 590, 529. Confirmed the workflow's trigger set is still exactly `['pull_request', 'workflow_dispatch']`, which is why the after-median cannot be measured from this feature branch and is deferred (see Next Phase Readiness).

## Task Commits

Each task was committed atomically:

1. **Task 1: Swap the uv bootstrap for the cached Astral action** - `a2fdf75b5` (feat)
2. **Task 2: Turn on the npm store cache** - `318be7fc2` (feat)
3. **Task 3: Record the before-median run time** - no code commit (measurement recorded directly into this SUMMARY, per the plan's own artifact table; no `.github/workflows/ci.yml` change was needed for this task)

**Plan metadata:** pending (this commit, `docs(216-04): complete plan`)

## Files Created/Modified

- `.github/workflows/ci.yml` - Swapped the uv bootstrap for `astral-sh/setup-uv@v10` with caching (Task 1); added npm store caching to `actions/setup-node@v6` (Task 2)

## Decisions Made

See `key-decisions` in frontmatter: (1) re-verified and pinned `astral-sh/setup-uv@v10` by major tag at implementation time; (2) skipped the plan's optional push-and-dispatch measurement step since the branch has no upstream and pushing/deploying is out of scope for this session; (3) the fresh before-median (567s, n=7) supersedes the objective's cited "8m49s" figure from the original audit, since that number's sample/date is not reproducible here.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 216 is now 6 of 7 plans complete (only 216-06, the function-size gate depth fixes, remains). This plan's after-measurement is explicitly deferred:

- **Follow-up (next release PR, main -> production):** re-run the same measurement —
  `gh run list --workflow=ci.yml --limit 10 --json createdAt,updatedAt,conclusion | uv run python -c "import json,sys,statistics,datetime as dt; rows=[r for r in json.load(sys.stdin) if r['conclusion']=='success']; f=lambda s: dt.datetime.fromisoformat(s.replace('Z','+00:00')); d=[(f(r['updatedAt'])-f(r['createdAt'])).total_seconds() for r in rows]; print('n=%d median_s=%.0f' % (len(d), statistics.median(d)))"`
  over the same sample size (10 completed runs, median over successes), once at least a
  few post-merge CI runs exist with the cache warm. Compare against this plan's before-median
  of 567s (n=7).

No blockers for merging this plan's work into `main`.

## Self-Check: PASSED

- `.github/workflows/ci.yml` contains `astral-sh/setup-uv@v10` with `enable-cache: true`: FOUND
- `.github/workflows/ci.yml` contains zero occurrences of `pip install uv`: CONFIRMED (0)
- `.github/workflows/ci.yml` contains `actions/setup-node@v6` with `cache: 'npm'` and `cache-dependency-path: frontend/package-lock.json`: FOUND
- Commit `a2fdf75b5` exists on branch: FOUND
- Commit `318be7fc2` exists on branch: FOUND
- All plan-level `<verification>` commands re-run and passing (YAML parse, setup-uv/enable-cache assertion, zero legacy bootstrap occurrences, `uv sync`/`npm ci` steps unchanged, setup-node cache assertion, trigger-set assertion, before-median n=7/median=567s)

---
*Phase: 216-audit-bugs-and-quick-wins*
*Completed: 2026-09-04*
