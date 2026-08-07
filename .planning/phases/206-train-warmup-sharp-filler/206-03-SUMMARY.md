---
phase: 206-train-warmup-sharp-filler
plan: 03
subsystem: api
tags: [fastapi, sqlalchemy, react, typescript, train]

requires:
  - phase: 206-01
    provides: "drill_sessions.is_warmup column (already migrated), sharp_filler_available(), the slimmed compose_and_materialize_session (_select_candidates/_backfill_sharp_fillers extraction)"
  - phase: 206-02
    provides: "the real 208-position sharp set (app/data/sharp_filler_puzzles.csv), exercised end-to-end by this plan's warm-up-labeled compositions"
provides:
  - "ComposedSession.is_warmup / TrainSessionResponse.is_warmup: frozen at composition (len(surviving_sr_keys) == 0), read (never recomputed) on resume"
  - "widened _stamp_pool_eligibility has_material term (OR sharp_filler_available()) — ROADMAP Success Criterion 5"
  - "frontend 'warmup' LandingState kind (replaces 'short'), isWarmup carried on the 'resume' variant, the D-09 warm-up banner (train-warmup-banner/-title/-body)"
affects: []

actuals:
  tokens: 9068
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Frozen-at-composition boolean joins puzzle_count/requested_count on DrillSession — computed once, read (never recomputed) on every resume path"
    - "Independent server-signal composition on the client: is_warmup (banner visibility) and next_due_date (its conditional clause) are two separate equality/null checks, never combined into one derived condition"

key-files:
  created: []
  modified:
    - app/repositories/train_repository.py
    - app/schemas/train.py
    - app/routers/train.py
    - frontend/src/types/train.ts
    - frontend/src/components/train/TrainStartScreen.tsx
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
    - frontend/src/hooks/__tests__/useTrainSession.test.ts
    - frontend/src/pages/__tests__/Train.guestGate.test.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx

key-decisions:
  - "Split into two backend commits (Task 1: is_warmup compute/freeze/publish; Task 2: pool_eligible_since widening) after an initial combined commit was caught by self-review and re-split via git reset --soft — the plan's atomic-per-task-commit contract took precedence over the shortcut"
  - "isWarmup carries on the 'resume' LandingState variant, not only the standalone 'warmup' kind (UI-SPEC ambiguity resolved per the plan's own planner note): resolveLandingState returns 'resume' — never 'warmup' — the moment solved_count > 0, so without isWarmup on 'resume' too the banner would vanish after the user's first solve, contradicting the label-survives-resume contract"
  - "Every other TrainSessionResponse-typed literal fixture across the frontend test suite (useTrainSession.test.ts, Train.guestGate.test.tsx, Train.solveLoop.test.tsx, TrainSolveScreen.test.tsx) got an is_warmup: false addition (Rule 3, blocking) — tsc -b treats the field as non-optional, so widening the shared type broke `npm run build` everywhere the interface was constructed as a literal, not just inside this plan's own files"

patterns-established: []

requirements-completed: [WARM-01, WARM-02, WARM-05, WARM-08]

coverage:
  - id: D1
    description: "A composed session with zero surviving SR_ITEM puzzles persists is_warmup=true and reports it on TrainSessionResponse; the nothing-qualified (session_id=null) path reports is_warmup=false"
    requirement: WARM-01
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_zero_sr_composition_sets_is_warmup"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_empty_composition_reports_is_warmup_false"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_session_response_exposes_is_warmup"
        status: pass
    human_judgment: false
  - id: D2
    description: "Exactly one qualifying blunder makes is_warmup false even with seven filler puzzles beside it — the discriminant is len(surviving_sr_keys) == 0, never a ratio or threshold (mutation-tested)"
    requirement: WARM-02
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_one_sr_item_is_not_warmup"
        status: pass
    human_judgment: false
  - id: D3
    description: "is_warmup is frozen at composition and read (never recomputed) on resume — a resumed session composed warm-up stays labeled warm-up even after new SR material arrives mid-session (mutation-tested)"
    requirement: WARM-01
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_is_warmup_survives_resume_after_material_arrives"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_no_resume_recomputation_mutation_check"
        status: pass
    human_judgment: false
  - id: D4
    description: "A filler-only composition (zero drill_items, zero pool candidates, non-empty sharp set) stamps pool_eligible_since to today; an existing watermark is never overwritten (mutation-tested against ROADMAP Success Criterion 5)"
    requirement: WARM-05
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#TestStampPoolEligibility::test_filler_only_session_stamps_pool_eligible_since"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#TestStampPoolEligibility::test_existing_watermark_is_not_overwritten_by_filler_session"
        status: pass
    human_judgment: false
  - id: D5
    description: "The 'warmup' landing kind (replacing the dead 'short' kind) renders the D-09 banner for a fresh warm-up session and a resumed warm-up session alike, with a conditional 'Next review' clause independent of the banner's own visibility, and renders in no other state (mutation-tested x2)"
    requirement: WARM-08
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainStartScreen.test.tsx — 'TrainStartScreen — Phase 206 D-06/D-08/D-09 warm-up banner' describe block (6 tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "compose_and_materialize_session stays under CLAUDE.md's hard function-size limit (< 200 logic LOC) after this plan's cumulative additions, with no _compute_is_warmup helper extracted"
    verification:
      - kind: unit
        ref: "ast-based logic-LOC gate (plan's verify script) against app/repositories/train_repository.py — 181 logic LOC"
        status: pass
    human_judgment: false
  - id: D7
    description: "The warm-up banner's visual weight and copy tone read correctly in the real app (dev clock + scripts/reset_train_state.py, /train with no SR material due)"
    verification: []
    human_judgment: true
    rationale: "Visual/tone judgment call flagged manual-only in 206-VALIDATION.md — not automatable; deferred to the phase's UAT pass."

duration: ~40min
completed: 2026-08-07
status: complete
---

# Phase 206 Plan 03: Train Warm-Up Label Summary

**A filler-only Train session now carries a server-frozen `is_warmup` boolean (never a session-ordinal proxy) that survives a mid-session resume, stamps `pool_eligible_since` so it accrues streak like any other session, and renders a "Warm-up session" banner on the start screen in place of the dead `'short'` landing state.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-08-07T15:23Z (first commit)
- **Completed:** 2026-08-07T15:31Z (last commit)
- **Tasks:** 3
- **Files modified:** 12 (8 named in the plan's own scope, 4 incidental frontend test-fixture fixes)

## Accomplishments

- `ComposedSession`/`TrainSessionResponse` now carry `is_warmup: bool`, derived exactly once per composition as `len(surviving_sr_keys) == 0` — a plain equality against zero, never a ratio or threshold — and frozen onto the `drill_sessions` row alongside `puzzle_count`/`requested_count`. `_resume_session` reads the stored column rather than recomputing it, so the label provably cannot be shed mid-session when the ES lottery lands new material (D-06/D-07, mutation-tested).
- `_stamp_pool_eligibility`'s `has_material` argument is widened with `sharp_filler_available()` (ROADMAP Success Criterion 5): a filler-only session now stamps the eligibility watermark on first composition exactly like a session with real SR material, so a warm-up-only user accrues streak instead of silently accruing none. Mutation-tested: reverting the widened term turns the new test red while the four pre-existing `TestStampPoolEligibility` tests stay green.
- `compose_and_materialize_session` ends the phase at 181 logic LOC (under CLAUDE.md's 200-line hard limit), with no `_compute_is_warmup` helper extracted — the derivation is a single inline statement beside the `surviving_sr_keys` set it reads, per the plan's explicit no-helper instruction.
- `TrainStartScreen.tsx`'s `resolveLandingState` replaces the dead `'short'` kind (F-03: the sharp-filler backfill from plan 01 means a session is now always full, so `puzzle_count < requested_count` never legitimately fires) with a `'warmup'` kind, and also carries `isWarmup` on the `'resume'` variant so the banner survives a partially-solved session — a case UI-SPEC's sketch left ambiguous and this plan's planner note resolved in favor of the label-survives-resume contract.
- The new warm-up banner (`Dumbbell` icon, D-09's locked copy, a conditional "Next review: {date}" clause read from the already-fetched `useTrainProgress()`) sits between `TrainHeader` and the Start/Resume CTA, mirroring `TrainReminderResurfaceBanner`'s `Card` shape with no accent spine — informational framing, not a competing call-to-action.
- All five named mutation checks performed and confirmed RED before restore: resume recomputation (WARM-01), the `< 2` discriminant swap (WARM-02), the `has_material` revert (WARM-05), the resume-only banner gate, and the unconditional "Next review" clause.

## Task Commits

1. **Task 1: Compute, freeze, and publish the warm-up flag** — `200a83bb8` (feat)
2. **Task 2: Stamp pool_eligible_since for filler-only sessions** — `48d54b86a` (feat)
3. **Task 3: The 'warmup' landing state, and the removal of 'short'** — `a2e328b6d` (feat), `4102569a5` (style: ruff format fixup)

_An initial combined Task 1+2 commit was caught during self-review (violated the atomic-per-task-commit contract) and re-split via `git reset --soft` before Task 3 began — see Deviations below._

## Files Created/Modified

- `app/repositories/train_repository.py` — `ComposedSession.is_warmup`, the `is_warmup` derivation beside `surviving_sr_keys`, the `DrillSession(...)`/fresh-return/nothing-qualified/`_resume_session` sites, the widened `has_material=` term
- `app/schemas/train.py` — `TrainSessionResponse.is_warmup`
- `app/routers/train.py` — `is_warmup=composed.is_warmup` pass-through
- `frontend/src/types/train.ts` — `TrainSessionResponse.is_warmup`
- `frontend/src/components/train/TrainStartScreen.tsx` — the `'warmup'` `LandingState` kind, `isWarmup` on `'resume'`, the banner markup, removal of the `'short'` kind and its render block
- `tests/repositories/test_train_repository.py` — 7 new tests: `test_zero_sr_composition_sets_is_warmup`, `test_one_sr_item_is_not_warmup`, `test_is_warmup_survives_resume_after_material_arrives`, `test_empty_composition_reports_is_warmup_false`, `test_no_resume_recomputation_mutation_check`, `TestStampPoolEligibility::test_filler_only_session_stamps_pool_eligible_since`, `TestStampPoolEligibility::test_existing_watermark_is_not_overwritten_by_filler_session`
- `tests/routers/test_train.py` — `test_session_response_exposes_is_warmup`
- `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` — removed the three `'short'`-state tests, added a 6-test describe block for the warm-up banner
- `frontend/src/hooks/__tests__/useTrainSession.test.ts`, `frontend/src/pages/__tests__/Train.guestGate.test.tsx`, `frontend/src/pages/__tests__/Train.solveLoop.test.tsx`, `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — added `is_warmup: false` to every literal `TrainSessionResponse` fixture so `tsc -b` stays green after widening the shared type

## Decisions Made

- The `is_warmup` derivation stays a single inline statement (`len(surviving_sr_keys) == 0`) beside the set it's defined from, per the plan's explicit instruction not to extract a `_compute_is_warmup` helper — a helper wrapping a one-line equality with a single reader would be the over-engineering CLAUDE.md warns against, and would separate the discriminant from the exact relationship SC1/SC2/mutation-check-2 pin down.
- `isWarmup` is carried on both the `'warmup'` and `'resume'` `LandingState` variants (not a `'warmup'`-only discriminant), resolving an ambiguity UI-SPEC's sketch left open — `resolveLandingState` returns `'resume'`, never `'warmup'`, for any partially-solved session, so a `'warmup'`-only field would drop the label the instant the user solved one puzzle, contradicting SC1's "the label survives leaving and resuming the session."
- Fixed every `TrainSessionResponse`-typed literal across the wider frontend test suite (not just this plan's own files) with `is_warmup: false`, since the interface's new field is non-optional and `npm run build` (`tsc -b`) type-checks the whole project, not just the files this plan names.

## Deviations from Plan

### Auto-fixed Issues

**1. [Process correction, not a code deviation] Split a combined Task 1+2 commit into two atomic commits**

- **Found during:** Immediately after committing Task 1 and Task 2's changes together as a single commit.
- **Issue:** The executor protocol requires one commit per task. Both tasks' backend changes were implemented and verified together (they share the same function and were easy to test as one unit), and the first commit accidentally bundled them.
- **Fix:** `git reset --soft HEAD^`, manually reverted the Task-2-only hunks (the `sharp_filler_available` import, the `has_material=` widening, and the two `TestStampPoolEligibility` tests) to reconstruct the Task-1-only state, re-verified (`ty check`, full backend suite, function-size gate) and committed Task 1 alone, then restored the Task-2 hunks from a backup and committed Task 2 alone.
- **Files modified:** `app/repositories/train_repository.py`, `tests/repositories/test_train_repository.py` (no net content change — same final diff, just correctly attributed across two commits).
- **Verification:** Both intermediate states independently passed `uv run ty check app/ tests/` and the full `tests/repositories/test_train_repository.py`/`tests/routers/test_train.py` suite before their respective commits.
- **Committed in:** `200a83bb8` (Task 1), `48d54b86a` (Task 2).

**2. [Rule 3 - Blocking] `ruff format` reformatted one line in the Task 1 test commit**

- **Found during:** Running the plan's final `<verification>` block (`uv run ruff format app/ tests/`) after Task 3 was already committed.
- **Issue:** A single wrapped `client.post(...)` call in the new `test_session_response_exposes_is_warmup` test exceeded ruff's line-length preference for that construct and got reformatted to one line.
- **Fix:** Applied the formatter output as a separate `style(206-03)` commit rather than amending the already-pushed Task 1 commit (per the "never amend, always new commit" rule).
- **Files modified:** `tests/routers/test_train.py`.
- **Verification:** `uv run ruff format --check` clean afterward; full backend suite still green.
- **Committed in:** `4102569a5`.

---

**Total deviations:** 1 process correction (commit-atomicity self-repair) + 1 auto-fixed formatting nit. Neither changes behavior or scope — both are execution-hygiene fixes caught by the plan's own verification steps.

## Issues Encountered

None beyond the deviations documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 206 is now feature-complete across all three plans: the sharp-filler tracer + honest 75/25 backfill mix (plan 01), the real 208-position committed data set (plan 02), and the warm-up label with its streak-accrual fix and UI surface (plan 03).
- The one remaining item from the plan's own `<verification>` block is manual-only: visually confirming the banner's weight/tone and the "Next review" clause via the dev clock + `scripts/reset_train_state.py --user-id N` against a real `/train` load with no SR material due — flagged as `human_judgment: true` in this SUMMARY's `coverage` block for the phase's UAT pass.
- No blockers for closing out Phase 206.

## Self-Check: PASSED

All 12 files listed under "Files Created/Modified" verified present on disk (plus this SUMMARY.md itself). All 4 commits (`200a83bb8`, `48d54b86a`, `a2e328b6d`, `4102569a5`) verified present in `git log --oneline`.

---
*Phase: 206-train-warmup-sharp-filler*
*Completed: 2026-08-07*
