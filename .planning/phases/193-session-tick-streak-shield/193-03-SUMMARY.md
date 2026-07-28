---
phase: 193-session-tick-streak-shield
plan: 03
subsystem: ui
tags: [react, typescript, tanstack-query, docs]

# Dependency graph
requires:
  - phase: 193-session-tick-streak-shield (Plan 02)
    provides: "badge_visible on ProgressSnapshot / TrainProgressResponse (Pydantic + TypeScript) — the D-09/D-10 server-computed nav-badge visibility signal this plan wires into the frontend"
provides:
  - "frontend/src/App.tsx — both Train nav badge sites (desktop NavHeader, mobile MobileBottomBar) gated on badge_visible, failing closed while pending/errored/field-missing, with zero client-side weekday-mask or timezone math"
  - "REQUIREMENTS.md PROG-01/SCHD-02 amended in place to describe the shipped session-tick + depletable-shield model and the scheduled-day-only badge rule with the D-10 carve-out"
  - "A confirmed (not just assumed) ruling on the SCHD-02 window-expiry edge case: an open, unfinished, window-expired session does NOT keep its badge"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Badge visibility derived as a single local (trainBadgeVisible = trainProgressQuery.data?.badge_visible ?? false) alongside the pre-existing trainWaitingCount local in each component, then AND-ed into the render condition — keeps the two badge sites' shapes symmetrical and avoids inlining the optional chain twice"

key-files:
  modified:
    - frontend/src/App.tsx
    - frontend/src/App.test.tsx
    - .planning/REQUIREMENTS.md
    - CHANGELOG.md
    - app/core/dev_clock.py

key-decisions:
  - "SCHD-02 flagged assumption RULED by the user (not decided by the executor): an open, unfinished, window-EXPIRED session does NOT keep its nav badge — _open_unfinished_exists' existing is_session_expired check is confirmed as correct, shipped, no code change. Accepted trade-off, stated explicitly: record_solve has no expiry check, so an expired session can still be completed and a late completion credits +1 shield pip against the day's -1 miss (netting zero instead of -1) — a real recovery path the user will never learn exists because the badge stays hidden. The user accepted this cost in exchange for the simpler rule, not because the cost doesn't exist."
  - "Docstring-literal acceptance-gate collision (mirrors Plan 01/02's precedent): the first-draft App.tsx comment explaining the badge's no-client-math property literally contained the string 'weekday_mask', tripping this plan's OWN acceptance-criterion grep (`grep -n \"useTrainSettings|weekday_mask\" frontend/src/App.tsx` must return no match). Reworded to 'schedule-mask/timezone math' — same invariant, no literal token collision."

patterns-established: []

requirements-completed: [PROG-01, SCHD-02]

coverage:
  - id: D1
    description: "Both the desktop header badge (App.tsx NavHeader) and the mobile bottom-bar badge (MobileBottomBar) gate on badge_visible in addition to the pre-existing waiting_count > 0 check, with no client-side day-of-week/timezone math anywhere in App.tsx"
    requirement: "SCHD-02"
    verification:
      - kind: unit
        ref: "frontend/src/App.test.tsx — '191-05: Train waiting badge' describe block (waiting_count:12/badge_visible:true reads 12 on both surfaces; waiting_count:12/badge_visible:false hides both; waiting_count:0/badge_visible:true still hides both; badge_visible omitted fails closed on both; pending/errored fails closed on both; waiting_count:150/badge_visible:true still caps at 99+ on both)"
        status: pass
      - kind: other
        ref: "grep -c badge_visible frontend/src/App.tsx == 3 (one per render site plus the shared local declaration comment); grep -n \"useTrainSettings|weekday_mask\" frontend/src/App.tsx == no match"
        status: pass
    human_judgment: false
  - id: D2
    description: "REQUIREMENTS.md's PROG-01 and SCHD-02 text and Coverage-table rows rewritten to describe the shipped session-tick + depletable-shield model and the scheduled-day-only badge rule with the D-10 carve-out; no requirement ID added/removed/renumbered; CHANGELOG.md carries one Phase 193 bullet under Unreleased/Changed"
    requirement: "PROG-01"
    verification:
      - kind: other
        ref: "The plan's own verify script (python assertions on PROG-01/SCHD-02 text + CHANGELOG Unreleased block) — exit 0"
        status: pass
      - kind: other
        ref: "grep -c '^- \\[.\\] \\*\\*' .planning/REQUIREMENTS.md == 27 (unchanged from pre-task value); git diff CHANGELOG.md touches only lines inside the Unreleased block"
        status: pass
    human_judgment: false
  - id: D3
    description: "app/core/dev_clock.py's WHY docstring no longer names the deleted settle_weeks/streak-flame mechanism Plan 01 replaced"
    requirement: null
    verification:
      - kind: other
        ref: "grep -n 'settle_weeks|flame' app/core/dev_clock.py — no match"
        status: pass
    human_judgment: false
  - id: D4
    description: "Multi-day drain and reset felt end to end on the real Train page, including that the reset notice survives a hard page reload (PROG-01)"
    requirement: "PROG-01"
    verification: []
    human_judgment: true
    rationale: "Requires a running dev stack, the TrainDevClock time-travel strip, and a real page reload — none of which an executor session can drive. Explicitly deferred per coordinator instruction; NOT run, NOT approved."
  - id: D5
    description: "7-pip shield meter density on a real 360px phone viewport, including the 4-digit session-count backstop case (PROG-01/D-01)"
    requirement: "PROG-01"
    verification: []
    human_judgment: true
    rationale: "Requires visual inspection at a specific viewport width (device toolbar or real phone) — not assertable in jsdom. Explicitly deferred per coordinator instruction; NOT run, NOT approved."
  - id: D6
    description: "Badge quiet on an unscheduled day under a narrowed Mon/Wed/Fri mask at BOTH nav sites, and the D-10 carve-out returning the badge for a still-open session across the Mon->Tue boundary (SCHD-02/D-09/D-10)"
    requirement: "SCHD-02"
    verification: []
    human_judgment: true
    rationale: "Requires live schedule-settings interaction, TrainDevClock time-travel, and visual confirmation at both badge sites in a running dev stack — not assertable in jsdom. Explicitly deferred per coordinator instruction; NOT run, NOT approved."

duration: ~15min (Task 1/2 execution span; the Task 3 checkpoint round-trip wait not counted)
completed: 2026-07-28
status: complete
---

# Phase 193 Plan 03: Nav-Badge Frontend Wiring and Requirement-Text Correction Summary

**Both Train nav badge sites (desktop + mobile) now gate on the server-computed `badge_visible` flag with zero client-side schedule math, and `REQUIREMENTS.md`'s PROG-01/SCHD-02 text was rewritten in place to match the shipped session-tick + depletable-shield model instead of the superseded weekly-streak wording.**

## Performance

- **Duration:** ~15 min (Task 1/2 execution span; Task 3's checkpoint round-trip wait to the coordinator not counted)
- **Started:** 2026-07-28T07:01:00Z (approx, right after Plan 02's completion)
- **Completed:** 2026-07-28T07:07:59Z (Task 2 commit)
- **Tasks:** 3 (2 executed + 1 checkpoint:human-verify, resolved by coordinator ruling)
- **Files modified:** 5

## Accomplishments
- Both `frontend/src/App.tsx` badge render sites (`NavHeader` desktop, `MobileBottomBar` mobile) extend their show/hide condition from `to === '/train' && trainWaitingCount > 0` to also require `(trainProgressQuery.data?.badge_visible ?? false)`, introduced as a single derived local (`trainBadgeVisible`) alongside the pre-existing `trainWaitingCount` local in each component — symmetrical shapes, no second query, no `useTrainSettings` import, no client-side `weekday_mask`/timezone derivation anywhere in the file.
- Reworked `frontend/src/App.test.tsx`'s `191-05: Train waiting badge` describe block: every existing scenario's mock now carries an explicit `badge_visible`, plus three new scenarios proving the D-09 off-day hide (`badge_visible: false`), the fail-closed omitted-field case, and that the pre-existing `waiting_count === 0` guard is preserved (not replaced) under `badge_visible: true`.
- Rewrote `REQUIREMENTS.md`'s **PROG-01** (dropped the "weekly streak"/"no freeze mechanics" wording, now describes the session-scoped streak + 7-level depletable shield, framed as forgiveness not behavior control) and **SCHD-02** (narrowed to scheduled session days, names the D-10 open-unfinished-session carve-out, keeps "no push, no email" verbatim). Both Coverage-table rows now credit Phase 193 alongside Phase 191; no requirement ID was added, removed, or renumbered (27 requirement bullets before and after).
- Logged one `### Changed` bullet under `CHANGELOG.md`'s `## [Unreleased]` section describing the session-based streak, the seven-level shield, and the quieter off-day badge.
- Fixed a genuine pre-existing doc-debt item flagged in this plan's own scope: `app/core/dev_clock.py`'s `WHY` docstring still named the deleted `settle_weeks`/streak-flame mechanism Plan 01 replaced — reworded to describe the per-scheduled-day tick machine without changing any behavior.
- **Task 3 checkpoint resolved by the coordinator, not decided by this executor**: the flagged SCHD-02 window-expiry assumption is now a confirmed ruling — "correct as shipped, hide it" — with no code change. See Decisions Made below for the accepted trade-off the user was shown before ruling.

## Task Commits

Each task was committed atomically:

1. **Task 1: Gate both nav badge sites on badge_visible (D-09/D-10)** - `698d7bed` (feat)
2. **Task 2: Amend PROG-01 and SCHD-02 in REQUIREMENTS.md and log the change** - `87b8c86e` (docs)
3. **Task 3: Human verification checkpoint** - resolved by coordinator ruling on the flagged assumption; the three hands-on UAT items remain OUTSTANDING (see below), no code commit of its own.

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `frontend/src/App.tsx` - `trainBadgeVisible` local + `badge_visible` AND clause at both badge render sites (`NavHeader`, `MobileBottomBar`)
- `frontend/src/App.test.tsx` - `191-05` badge describe block reworked with `badge_visible` on every mock, plus new off-day-hidden and fail-closed-omitted-field cases
- `.planning/REQUIREMENTS.md` - PROG-01/SCHD-02 text rewrite, Coverage-table rows crediting Phase 193
- `CHANGELOG.md` - one Phase 193 bullet under `## [Unreleased]` → `### Changed`
- `app/core/dev_clock.py` - `WHY` docstring reworded off the deleted `settle_weeks`/flame mechanism (docstring-only, no behavior change)

## Decisions Made

- **SCHD-02 flagged assumption — user ruling, not executor decision: "Correct as shipped — hide it."** The badge does NOT stay visible for an open, unfinished, window-expired session on an unscheduled day; `_open_unfinished_exists`' existing `is_session_expired` check is confirmed correct as-is, no code change. **The trade-off put to the user was live, not strawman, and is recorded here in full**: `record_solve` has no expiry check of its own, so a user CAN still complete an expired-but-open session, and doing so credits +1 shield pip against that day's -1 miss — netting to zero instead of a real loss. Hiding the badge means the user is never cued toward this recovery path and will likely never discover it exists. The user accepted this cost in exchange for the simpler, more defensible default rule (an expired session is already a D-08 miss, and nagging toward something no longer creditable toward the streak count is the exact pressure D-09 exists to remove) — this is an accepted, known consequence, not a non-issue.
- **Docstring literal reworded to avoid tripping this plan's own acceptance-gate grep** (mirrors the exact same class of issue Plan 01/02 hit): the first-draft `App.tsx` comment said "No client-side weekday_mask/timezone math" — the literal substring `weekday_mask` collided with the acceptance criterion's own `grep -n "useTrainSettings|weekday_mask" frontend/src/App.tsx` check. Reworded to "schedule-mask/timezone math" (same meaning, no literal-token collision), confirmed via re-run of the exact grep.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] app/core/dev_clock.py's docstring still described deleted symbols**
- **Found during:** Task 2 — flagged explicitly in this plan's own `<critical_requirements>` scope (not discovered mid-task; called out ahead of time as a known doc-debt item in the same subsystem this plan already touches)
- **Issue:** The `WHY` docstring's fourth clause read "...and `settle_weeks` judges Mon-start weeks to move the streak flame" — both `settle_weeks` and the flame ladder were deleted in Plan 01, so a reader following this docstring would look for symbols that no longer exist.
- **Fix:** Reworded to describe the per-scheduled-day tick machine (shield + session streak) that actually replaced it. Docstring-only; no behavior change.
- **Files modified:** `app/core/dev_clock.py`
- **Verification:** `grep -n "settle_weeks|flame" app/core/dev_clock.py` returns no match.
- **Committed in:** `87b8c86e` (Task 2 commit)

**2. [Rule 1 - Bug] First-draft App.tsx comment tripped the plan's own acceptance-gate grep**
- **Found during:** Task 1 — acceptance-criteria verification step
- **Issue:** The comment explaining the badge's no-client-math property literally contained the string `weekday_mask`, which the acceptance criterion's own `grep -n "useTrainSettings|weekday_mask" frontend/src/App.tsx` (required to return no match) correctly flagged.
- **Fix:** Reworded to "schedule-mask/timezone math" — identical meaning, no literal token collision.
- **Files modified:** `frontend/src/App.tsx`
- **Verification:** Grep re-run, confirmed zero matches; `npx tsc -b` re-confirmed clean (comment-only change).
- **Committed in:** `698d7bed` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 missing-critical docstring fix explicitly in this plan's scope, 1 acceptance-gate wording fix)
**Impact on plan:** No scope creep — both fixes are direct, necessary side effects of this plan's own stated scope and its own acceptance gates. No functionality beyond the plan's stated scope was added.

## Issues Encountered

None beyond the deviations above.

## Outstanding manual verification

**NOT run, NOT approved.** These three items from the plan's Task 3 `<how-to-verify>` require a running dev stack, the `TrainDevClock` time-travel strip, and a 360px viewport — none of which have been driven by anyone yet. They are recorded verbatim here so `/gsd-verify-work` or a later UAT audit picks them up (see the `coverage:` block above, `D4`/`D5`/`D6`, each marked `human_judgment: true` with an empty `verification:` list).

1. **Multi-day drain and reset, felt end to end (PROG-01).** On the Train page, use the dev time-travel strip (`TrainDevClock`) to advance day by day past several scheduled days WITHOUT completing a session. Confirm exactly one pip disappears per scheduled day, that the count zeroes at the moment the last pip goes out, and that the reset notice ("Streak reset — complete a session to start a new one.") appears and SURVIVES a hard page reload. Then reset with `uv run python scripts/reset_train_state.py --user-id <N>` and confirm the meter, count, and notice all return to a clean slate.
2. **7-pip density on a real phone viewport (PROG-01/D-01).** Load the Train page at 360px width (device toolbar or a real phone). Confirm the seven pips and the "N-session streak" label fit without horizontal overflow, that the row wraps rather than clipping, and that no text has dropped below `text-sm`. Also check the 4-digit case if convenient (the `1234-session streak` backstop).
3. **Badge quiet on an off-day under a narrowed mask (SCHD-02/D-09/D-10).** In Train settings, select a Mon/Wed/Fri schedule. Time-travel to a Tuesday with puzzles waiting and confirm BOTH the desktop header badge and the mobile bottom-bar badge are hidden. Then leave a session open across the Mon→Tue boundary and confirm the badge returns on the Tuesday (D-10's carve-out) while its window is still open.

The flagged SCHD-02 window-expiry assumption itself (the fourth item in the original checkpoint) IS resolved — see Decisions Made above — it required a policy ruling, not hands-on UI verification, and the coordinator obtained that ruling from the user directly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The implementation is complete and every automated gate is green: `uv run ruff format app/ tests/` (334 files unchanged), `uv run ruff check app/ tests/ --fix` (all checks passed), `uv run ty check app/ tests/` (all checks passed), `uv run pytest -n auto -x` (3896 passed, 18 skipped, 67.92s), `npx tsc -b` (clean), `npm run lint` (0 errors, 3 pre-existing unrelated `coverage/`-artifact warnings), `npm run knip` (clean), `npm test -- --run` (2789 passed, 200/200 files).
- Manual UAT is explicitly deferred, not skipped — see `## Outstanding manual verification` above. **Do not treat this plan or Phase 193 as user-verified** until those three items are actually run against a live dev stack.
- Phase 193 is now feature-complete across all three plans (per-day tick machine + shield, eager completion tick + badge signal, frontend badge wiring + requirement-text correction). No further plans remain in this phase.

---
*Phase: 193-session-tick-streak-shield*
*Completed: 2026-07-28*

## Self-Check: PASSED

Both modified-file sets verified present on disk (`frontend/src/App.tsx`, `frontend/src/App.test.tsx`, `.planning/REQUIREMENTS.md`, `CHANGELOG.md`, `app/core/dev_clock.py`); both task commits (`698d7bed`, `87b8c86e`) verified present in `git log --oneline --all`.
