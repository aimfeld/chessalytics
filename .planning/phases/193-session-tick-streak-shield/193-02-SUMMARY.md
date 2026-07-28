---
phase: 193-session-tick-streak-shield
plan: 02
subsystem: api
tags: [fastapi, sqlalchemy, react, typescript, tanstack-query]

# Dependency graph
requires:
  - phase: 193-session-tick-streak-shield (Plan 01)
    provides: "SHIELD_CAP / is_scheduled_day / TickSnapshot / TickView / DayOutcome / _judge_one_day / tick_days in app/services/train_scheduler.py, and settle_streak_snapshot/get_progress rewired onto the per-day tick machine — the shared primitives this plan's eager path and badge signal build on"
provides:
  - "_apply_completion_tick in app/repositories/train_repository.py — D-03's eager completion tick, settling elapsed days first then applying exactly one DayOutcome through the shared _judge_one_day primitive"
  - "record_solve's claimed-AND-session_complete gate — the guard that keeps a lost-claim re-submit from applying a second tick"
  - "_open_unfinished_exists + ProgressSnapshot.badge_visible / TrainProgressResponse.badge_visible (Pydantic + TypeScript) — the D-09/D-10 nav-badge visibility signal"
  - "compose_and_materialize_session's D-06 watermark stamp — pool_eligible_since is now stamped from both the progress read and composition"
affects: [193-03-nav-badge-frontend-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Eager-tick gate is `claimed AND session_complete`, not `session_complete` alone — `claimed=True` proves THIS call's solved_at IS NULL claim is what just flipped the session to complete (before this call the session could not have been complete), so the eager-tick call site structurally cannot double-apply on a lost-claim/resubmit call even though _mark_session_complete_if_done's own return value stays True on every subsequent call"
    - "Settle-then-layer ordering: any eager mutation atop the per-day tick snapshot must call settle_streak_snapshot FIRST against the post-settle view, never against a stale pre-settle snapshot — otherwise a completion on a later day can let intervening missed scheduled days escape judgement"

key-files:
  modified:
    - app/repositories/train_repository.py
    - app/schemas/train.py
    - app/routers/train.py
    - frontend/src/types/train.ts
    - frontend/src/components/train/__tests__/TrainProgressRow.test.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py

key-decisions:
  - "Eager-tick call site gated on `claimed AND session_complete`, not `session_complete` alone (a refinement of the plan's literal action prose, required by the plan's OWN acceptance criterion and threat register T-193-06's 'runs at most once per session' claim — the property is only true when the caller doesn't unconditionally call the tick on every call that observes session_complete=True, since a lost-claim re-submit also observes it)."
  - "Late-completion tie-break — resolved per plan: credit one shield pip, never the count, never re-open the day. Verified via the double-count-guard test."

patterns-established:
  - "Any future settlement caller (a later off-day/late-completion path) must route through _judge_one_day rather than re-deriving shield/count arithmetic — enforced by the divergence gate (single occurrence of `min(...SHIELD_CAP)` in app/, now confirmed to hold with this plan's addition)."

requirements-completed: [PROG-01, SCHD-02]

coverage:
  - id: D1
    description: "A completed session on a scheduled day increments both shield_level (capped at SHIELD_CAP=7) and streak_count IMMEDIATELY on completion, in the same transaction as the final solve (D-03)"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_fulfilled_completion_ticks_count_and_shield_and_advances_settled_through"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_fulfilled_completion_at_cap_leaves_shield_unchanged"
        status: pass
    human_judgment: false
  - id: D2
    description: "An ad-hoc session completed on an unscheduled day credits exactly one shield pip and does NOT advance streak_count or streak_settled_through (D-07)"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_off_day_completion_credits_shield_only"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_cap_parity_between_fulfilled_and_off_day_branches"
        status: pass
    human_judgment: false
  - id: D3
    description: "A session started but not completed before its window closed is a MISS drained by the lazy walk — only status='completed' sessions ever tick eagerly (D-08)"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_abandoned_session_drains_one_pip_with_no_count_change"
        status: pass
    human_judgment: false
  - id: D4
    description: "The eager path settles elapsed scheduled days FIRST, so a completion on a later day can never let an earlier missed scheduled day escape judgement (double-count/skip guards)"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_double_count_guard_late_completion_after_lazy_miss"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_skip_guard_drains_intervening_misses_before_applying_completion"
        status: pass
      - kind: other
        ref: "Manual mutation check: temporarily removed the settle_streak_snapshot call in _apply_completion_tick, re-ran the skip-guard test alone, confirmed it FAILED (shield_level 6 instead of the expected 4), then restored the call and confirmed the full suite passes again."
        status: pass
    human_judgment: false
  - id: D5
    description: "A lost-claim re-submit of an already-solved final puzzle does not apply a second tick"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_resubmit_of_already_solved_final_puzzle_does_not_apply_second_tick"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestCompletionTick::test_non_final_puzzle_writes_no_snapshot_change"
        status: pass
    human_judgment: false
  - id: D6
    description: "The shield-credit clamp expression is typed exactly once in app/ (app/services/train_scheduler.py) — the off-day/late-completion branch routes through _judge_one_day rather than re-deriving the clamp"
    requirement: "PROG-01"
    verification:
      - kind: other
        ref: "uv run python -c \"import pathlib, re; hits=[str(p) for p in pathlib.Path('app').rglob('*.py') for line in p.read_text().splitlines() if re.search(r'min\\(.*SHIELD_CAP', line) and not line.lstrip().startswith('#')]; assert hits == ['app/services/train_scheduler.py'], hits\""
        status: pass
    human_judgment: false
  - id: D7
    description: "GET /train/progress returns a server-computed badge_visible: True only when waiting_count > 0 AND (today is scheduled OR an open unexpired session still has unsolved puzzles) — D-09/D-10, no client-side day-of-week math"
    requirement: "SCHD-02"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::TestBadgeVisible (6 scenarios: default mask, mask==0, narrowed-mask off-day hidden, narrowed-mask off-day with open session visible, zero waiting_count hidden, fully-solved open session hidden)"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_progress_returns_200_with_all_eleven_fields"
        status: pass
    human_judgment: false
  - id: D8
    description: "pool_eligible_since is stamped from compose_and_materialize_session as well as get_progress, stamp-if-null only"
    requirement: "PROG-01"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::test_compose_stamps_pool_eligible_since_once"
        status: pass
    human_judgment: false

duration: ~30min
completed: 2026-07-28
status: complete
---

# Phase 193 Plan 02: Eager Completion Tick and Nav-Badge Signal Summary

**D-03's eager completion tick (settle-then-layer through the shared `_judge_one_day` primitive), D-09/D-10's server-computed `badge_visible`, and the compose-side D-06 watermark stamp — all layered on Plan 01's per-day tick machine with zero shield/count arithmetic duplicated outside `train_scheduler.py`.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-28T06:26:00Z (approx, right after Plan 01's completion)
- **Completed:** 2026-07-28T06:56:01Z (Task 2 commit)
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Added `_apply_completion_tick` to `app/repositories/train_repository.py`: settles every elapsed scheduled day FIRST via `settle_streak_snapshot`, then applies exactly one `DayOutcome` (`"fulfilled"` or `"credit_only"`) to the post-settle snapshot through the shared `_judge_one_day` primitive — the fulfilled branch keeps `settle_streak_snapshot`'s compare-and-set boundary guard; neither branch hand-derives the `SHIELD_CAP` clamp.
- Wired the call into `record_solve`, gated on `claimed AND session_complete` — a refinement beyond the plan's literal prose, required so a lost-claim re-submit of an already-solved final puzzle (which also observes `session_complete=True`) cannot apply a second tick. Proved by a dedicated resubmit test.
- Added `_open_unfinished_exists` (window-based via `expires_on`, never `weekday_mask`-based) and `ProgressSnapshot.badge_visible`/`TrainProgressResponse.badge_visible` (Pydantic + TypeScript): `waiting_count > 0 AND (is_scheduled_day(today, mask) OR open-unfinished-session-exists)`.
- `compose_and_materialize_session` now stamps the D-06 `pool_eligible_since` watermark via the same `_material_flags`/`_stamp_pool_eligibility` pair `get_progress` already calls, so a user whose first `drill_items` row is created by composition gets the eligibility floor immediately.
- Ran the plan's mandatory mutation check by hand: temporarily removed the `settle_streak_snapshot` call inside `_apply_completion_tick`, confirmed the skip-guard test failed (`shield_level` landed at 6, not the expected 4), then restored the call and confirmed the full suite is green again — the settle-first guard is load-bearing, not decorative.

## Task Commits

Each task was committed atomically:

1. **Task 1: Eager completion tick with the frozen-day guard (D-03/D-07/D-08)** - `1bf51527` (feat)
2. **Task 2: badge_visible signal (D-09/D-10) and the compose-side watermark stamp (D-06)** - `34ed18d3` (feat)

**Plan metadata:** (this commit, docs: complete plan)

_Note: both tasks touch overlapping files (`app/repositories/train_repository.py`, `tests/repositories/test_train_repository.py`) since Task 2's `is_scheduled_day` badge computation and Task 1's off-day branch share the same predicate. The two commits were split by hunk (verified via `git apply -R --check` before splitting) so each commit's diff is exactly its task's contribution — Task 1's commit alone reformats/lints/type-checks clean and its 82-test subset of `test_train_repository.py` passes standalone before Task 2's hunks were re-applied._

## Files Created/Modified
- `app/repositories/train_repository.py` - `_apply_completion_tick`, `_open_unfinished_exists`, `ProgressSnapshot.badge_visible`, `get_progress`'s `badge_visible` computation, `record_solve`'s `claimed AND session_complete` eager-tick call site, `compose_and_materialize_session`'s D-06 stamp step
- `app/schemas/train.py` - `TrainProgressResponse.badge_visible: bool`
- `app/routers/train.py` - maps `progress.badge_visible` through to the response
- `frontend/src/types/train.ts` - `TrainProgressResponse.badge_visible: boolean`
- `tests/repositories/test_train_repository.py` - `TestCompletionTick` (9 tests), `TestBadgeVisible` (6 tests), `test_compose_stamps_pool_eligible_since_once`
- `tests/routers/test_train.py` - `badge_visible` added to the full-field-set assertion, renamed to `test_progress_returns_200_with_all_eleven_fields`
- `frontend/src/components/train/__tests__/TrainProgressRow.test.tsx`, `TrainStartScreen.test.tsx` - added `badge_visible: false` to the `TrainProgressResponse`-typed mock literals (unavoidable fallout of the new required field, same class of fix Plan 01 needed for its own field renames)

## Decisions Made

- **Eager-tick gate is `claimed AND session_complete`, not `session_complete` alone.** The plan's `<action>` prose says "call it from record_solve immediately after `_mark_session_complete_if_done` returns True", which — read literally — would also fire on every subsequent re-submit call to an already-completed session (`_mark_session_complete_if_done` returns `True` on every call once `remaining == 0`, regardless of whether its own `status='open'` UPDATE guard actually fired). The plan's OWN acceptance criterion ("Re-submitting an already-solved final puzzle... does not apply a second tick") and the threat register's T-193-06 claim ("`_mark_session_complete_if_done`'s `status='open'` guard... `_apply_completion_tick` runs at most once per session") both require the additional `claimed` condition: `claimed=True` means this call's `solved_at IS NULL` claim is what the session's completion transition hinges on, so gating on `claimed AND session_complete` is the only way to make "runs at most once" a structural property rather than an accident of test coverage. Proven by the dedicated resubmit test and the divergence-of-behavior it would catch.
- **Late-completion tie-break implemented exactly as the plan recorded it**: credit one shield pip, never the count, never re-open the day. No further discussion needed — it was a recorded decision, not a blocking gate, per the plan's `<objective>`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Docstring literals tripped the plan's own acceptance-gate greps**
- **Found during:** Task 1/2 acceptance-criteria verification
- **Issue:** `_apply_completion_tick`'s docstring contained the literal string `min(...SHIELD_CAP)` (explaining the divergence gate in prose), which the divergence-gate grep (`re.search(r'min\(.*SHIELD_CAP', line)`) correctly flagged as a second occurrence. Similarly `_open_unfinished_exists`'s docstring said "never `weekday_mask`-based", tripping the `'weekday_mask' not in inspect.getsource(...)` gate.
- **Fix:** Reworded both docstrings to describe the same invariants without using the literal grepped tokens.
- **Files modified:** `app/repositories/train_repository.py`
- **Verification:** Both gate commands re-run and confirmed passing; full test suite re-run clean.
- **Committed in:** `1bf51527` / `34ed18d3` (the docstrings were fixed before either commit was made, so both commits already carry the corrected wording)

**2. [Rule 3 - Blocking] Frontend test mock literals needed the new required field**
- **Found during:** Task 2 — `npx tsc -b` verification step
- **Issue:** `TrainProgressRow.test.tsx`'s `BASE` and `TrainStartScreen.test.tsx`'s `DEFAULT_TRAIN_PROGRESS`, both typed as `TrainProgressResponse`, failed to compile once `badge_visible: boolean` became a required field — a direct, unavoidable fallout of the type addition, not a pre-existing issue. Mirrors the exact same class of fix Plan 01's SUMMARY documented for its own field renames.
- **Fix:** Added `badge_visible: false` to both object literals.
- **Files modified:** `frontend/src/components/train/__tests__/TrainProgressRow.test.tsx`, `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx`
- **Verification:** `npx tsc -b` clean; `npx vitest run src/components/train` — 135/135 passed.
- **Committed in:** `34ed18d3` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 acceptance-gate docstring wording fix, 1 blocking build fix)
**Impact on plan:** No scope creep — both fixes are direct, necessary side effects of the plan's own stated gates and the type addition it specifies. No functionality beyond the plan's stated scope was added.

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The D-03 eager tick and D-07/D-08 branches are provably load-bearing: the settle-first ordering was verified by an actual revert-and-rerun mutation test (not just a passing test suite), and the divergence gate confirms the shield-credit clamp is typed exactly once in `app/` even after this plan's additions.
- `badge_visible` is fully computed server-side and available on `GET /train/progress`'s payload (Pydantic + TypeScript), ready for Plan 03 to wire into `frontend/src/App.tsx`'s two badge sites (desktop header + mobile bottom bar) per D-09/D-10 — this plan deliberately does NOT touch `App.tsx`/`App.test.tsx`, per its own `<files>` scope.
- Full backend suite (3896 passed, 18 skipped) and frontend suite (2787 passed) green; `ruff format`/`ruff check`/`ty check app/` clean; `npx tsc -b` clean.
- Not yet done (explicitly out of scope for Plan 02): the frontend badge-visibility consumption itself — that is Plan 03.

---
*Phase: 193-session-tick-streak-shield*
*Completed: 2026-07-28*

## Self-Check: PASSED

All 8 modified/created files verified present on disk; both task commits (`1bf51527`, `34ed18d3`) verified present in `git log --oneline --all`.
