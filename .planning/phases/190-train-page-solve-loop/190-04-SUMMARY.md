---
phase: 190-train-page-solve-loop
plan: 04
subsystem: ui
tags: [react, tanstack-query, stockfish-wasm, chess.js, train, date-fns]

requires:
  - phase: 190-train-page-solve-loop (Plan 01)
    provides: "One-puzzle tracer: Train.tsx, TrainSolveScreen.tsx, useTrainSession.ts, useTrainGradingEngine.ts (measured TRAIN_GRADING_MOVETIME_MS, TRAIN_GRADING_TIMEOUT_MS, grading-error/Retry state)"
  - phase: 190-train-page-solve-loop (Plan 02)
    provides: "TrainPuzzle.last_move_uci and PuzzleRevealResponse.pv on the backend payloads and frontend types.ts"
provides:
  - "TrainStartScreen.tsx — the single owner of all six pre-loop landing states (loading/error/empty/fresh/short/resume/completed)"
  - "Session-status auto-fetch on Train.tsx mount (POST /train/sessions is the only endpoint that can answer landing-state questions; there is no separate preview GET)"
  - "useTrainSession: client-accumulated, localStorage-backed sessionScore for the completed-session recap"
  - "TrainSolveScreen progress indicator (i of N, frozen puzzle_count), last-move highlight, and an engine-failure fallback (readiness timeout + Worker error -> retry affordance)"
  - "Block-and-retry solve persistence: advance() gated on solve-mutation success, retrySolve() re-submitting the identical payload, lastSolveResponse/resetSolve wired through TrainSolveScreen"
affects: [190-05, 190-06]

tech-stack:
  added: []
  patterns:
    - "A single-endpoint status/action overload (POST /train/sessions doubles as both a status read on mount and a resume-action on button-press) resolved by decoupling the UI's loop-entry state (hasEnteredLoop) from the data fetch, rather than adding a new backend endpoint"
    - "Client-accumulated, localStorage-backed aggregate (sessionScore) as a stopgap for a missing backend aggregate field — same shape as the existing useUserFlag localStorage convention, scoped by an id instead of a name+email"
    - "Verdict state sourced directly from a TanStack mutation's own `data`/reset() (lastSolveResponse/resetSolve) instead of a parallel local-state copy, so a retried mutation's eventual success renders through the exact same path as a first-try success"

key-files:
  created:
    - frontend/src/components/train/TrainStartScreen.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
  modified:
    - frontend/src/pages/Train.tsx
    - frontend/src/hooks/useTrainSession.ts
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx

key-decisions:
  - "POST /train/sessions fires automatically on Train.tsx mount as a STATUS read (D-01's 'no auto-start on visit' is about never skipping straight into the solve-loop UI, not about avoiding this read) — there is no separate preview GET in the Phase 189 API, so this is the only way the landing screen can know fresh/short/resume/completed/empty before any button press. Pressing Start/Resume only flips local hasEnteredLoop state, never re-fetches — kept the tracer's Train.solveLoop.test.tsx assertion of exactly one composeOrResumeSession call true by construction."
  - "sessionScore (D-03's 'You scored N/2M today.' recap) is client-accumulated and localStorage-persisted keyed by session_id, because TrainSessionResponse carries no server-side score aggregate field and this plan's scope is frontend-only. A cold reload on a device that never solved anything this session falls back to 0 — a known, explicitly flagged limitation, not a silent guess. Points are tallied from each SolveResponse (correct_guess + correct_move, 0-2 per puzzle) as solves succeed."
  - "Progress bar fill color uses the existing bg-brand-brown Tailwind utility (CSS-var-backed theme token, same one Button's default variant already uses for the single high-emphasis CTA) rather than adding a new theme.ts constant — satisfies the UI-SPEC's 'named token, not a literal color utility' requirement without introducing an unused export."
  - "Engine-failure fallback added a restartEngine() surface to useTrainGradingEngine (tears down + recreates the Worker, resets hasError) plus a TRAIN_ENGINE_READY_TIMEOUT_MS (15s) bounded readiness window in TrainSolveScreen — both a dead/never-loaded Worker and a Worker that never completes its UCI handshake in time degrade to the same train-engine-error retry affordance, never an indefinite 'Checking your move...' wait."
  - "Solve-POST failure and grading failure are kept as two DISTINCT failure states (train-grading-error vs train-solve-error) rather than one combined retry, because retrying a solve-POST failure must re-submit the identical already-graded payload (T-190-15 — never re-derive correct_move), while retrying a grading failure has no verdict yet and must re-run gradeMove from scratch."

patterns-established:
  - "advance()-gating via a solvedPositions Set keyed by TrainPuzzle.position, checked inside the advance callback itself (not just a disabled button attribute) — the CTA's disabled state and the hook's internal gate are two independent defenses against the same failure mode"

requirements-completed: [SOLV-02, SOLV-04]

coverage:
  - id: D1
    description: "All six Train landing states (loading, error, empty, fresh, short, resume, completed) render their locked D-01..D-04/D-14 copy from a single ordered-branch state resolution, are mutually exclusive, and Resume lands on the next unsolved puzzle via the hook's existing solved_count seeding"
    requirement: "SOLV-04"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainStartScreen.test.tsx (10 tests: loading, error, empty, fresh, short positive case, both short negative cases, resume, completed, heading floor)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The solve screen shows a session progress indicator ('i of N' + thin bar) using the session's frozen puzzle_count (never the remaining-puzzles array length), and highlights the opponent's last move via the arriving-move UCI with no eval bar or game metadata anywhere on screen"
    requirement: "SOLV-02"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx (progress-denominator-vs-frozen-count test, progress-bar-fill test, orientation tests, last-move-highlight tests incl. null-arriving-move)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The checking indicator appears only when a second engine search is actually needed (non-exact move), never for an exact match, with no board flicker/remount across the transition; a dead or never-ready grading engine degrades to a visible retry affordance instead of an indefinite wait"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx (exact-match/non-exact-match cases, board-position-unchanged case, Worker-error case, readiness-timeout case via fake timers)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A forced solve-POST failure surfaces 'Couldn't save your result.' + Retry, hard-blocks the Next control (both its disabled attribute AND the hook's internal advance() gate) from moving the puzzle index, and a successful retry re-submits the byte-identical payload before enabling Next"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#'a forced solve-POST failure blocks Next and never advances; retry re-submits the identical payload and then enables Next'"
        status: pass
    human_judgment: false
  - id: D5
    description: "The one-puzzle tracer (Plan 01/02's Train.solveLoop.test.tsx) still passes end to end after this plan's rewiring of the session-fetch timing, and the full frontend suite has no regressions"
    verification:
      - kind: e2e
        ref: "frontend/src/pages/__tests__/Train.solveLoop.test.tsx (updated for the mount-time status-fetch timing, still 1 test, passing)"
        status: pass
      - kind: other
        ref: "cd frontend && npm test -- --run (full suite: 190 files, 2595 tests, all passing); npx tsc -b; npm run lint; npm run knip — all exit 0"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-07-25
status: complete
---

# Phase 190 Plan 4: Train Page Solve Loop Completion Summary

**The full session experience over the Phase 190-01 tracer: six landing states (D-01..D-04/D-14) resolved from a single auto-fetched status read, a frozen-count progress indicator + last-move highlight on the solve screen, an engine-failure fallback with a bounded readiness timeout, and block-and-retry solve persistence that makes a lost solve POST impossible to miss.**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-07-25
- **Tasks:** 3 planned (all complete), no checkpoints hit (autonomous plan)
- **Files modified:** 8 (3 new, 5 modified)

## Accomplishments

- `TrainStartScreen.tsx` is now the single owner of every pre-loop state a real user hits in week one: loading, error, the plain D-04 empty placeholder, a fresh session ("N puzzles waiting"), a short session with the "still being analyzed" notice (gated on BOTH `blob_pending_count > 0` AND `puzzle_count < requested_count`), a resumable session ("Resume session — 4 of 12 done"), and a completed session's score recap + next-session date.
- Solved the landing-state chicken-and-egg problem without touching the backend: since Phase 189 exposes no separate "preview" endpoint, `Train.tsx` now fires `POST /train/sessions` automatically on mount as a status read, and pressing Start/Resume only flips a local `hasEnteredLoop` flag rather than re-fetching — D-01's "no auto-start on visit" is preserved (the loop UI never appears without a press) while the landing screen still has real data to render.
- Added a client-accumulated, localStorage-backed `sessionScore` to `useTrainSession` so the completed-session recap has a number to show, since `TrainSessionResponse` carries no server-side score aggregate — explicitly flagged as a known limitation for a cold reload on a device that never solved anything this session.
- Completed the solve screen against SOLV-02/SOLV-04/D-06/D-13: a progress indicator using the session's frozen `puzzle_count` (never the remaining-puzzles array length, which can legitimately shrink after a lazy eviction), the opponent's last-move highlight derived from `last_move_uci`, and an engine-failure fallback (`restartEngine()` + a named `TRAIN_ENGINE_READY_TIMEOUT_MS` readiness window) so neither a dead Worker nor one that never completes its UCI handshake strands the user on "Checking your move…" forever.
- Made a lost solve POST impossible to miss: `advance()` is now a real no-op (not just a disabled button) until the current puzzle's solve mutation has actually succeeded, `retrySolve()` re-submits the byte-identical payload rather than re-grading, and the verdict itself renders from the mutation's own `data` so a retry's success surfaces through the exact same path as a first-try success.

## Task Commits

Each task was committed atomically:

1. **Task 1: The six landing states (D-01..D-04, D-14)** — `adcd5d6a` (feat)
2. **Task 2: Solve-screen completion — progress, last move, grading state** — `aa95f790` (feat)
3. **Task 3: Solve persistence is block-and-retry, never silent** — `a5786714` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP updates)

## Files Created/Modified

- `frontend/src/components/train/TrainStartScreen.tsx` — new: the six-state landing screen (`resolveLandingState`'s single ordered branch chain)
- `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` — new: 10 tests covering all six states incl. both negative short-session cases
- `frontend/src/pages/Train.tsx` — auto-fires `startSession()` on mount (status read), renders `TrainStartScreen` vs `TrainSolveScreen` based on local `hasEnteredLoop`
- `frontend/src/hooks/useTrainSession.ts` — `sessionScore` (localStorage-backed), `lastSolveResponse`/`retrySolve`/`resetSolve`, `advance()` gated on a `solvedPositions` set
- `frontend/src/hooks/useTrainGradingEngine.ts` — `restartEngine()` (Worker teardown/recreate via a `restartGeneration` counter, `hasError` reset on restart)
- `frontend/src/components/train/TrainSolveScreen.tsx` — progress bar, last-move highlight, engine-failure fallback UI, solve-error/Retry UI wired to `trainSession.retrySolve`
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — new: 12 tests (progress, orientation, highlight, checking-indicator exact/non-exact, board-stability, engine-failure ×2, forced solve-retry)
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` — one `waitFor` added before the initial Start-button click, to account for the new mount-time status-fetch timing (tracer's own assertions unchanged)

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Train.solveLoop.test.tsx needed a `waitFor` before its first button click**
- **Found during:** Task 1 (auto-fetch on mount design)
- **Issue:** Once `Train.tsx` fires the session-status fetch automatically on mount, the landing screen briefly shows its loading state before `btn-train-start` exists — the tracer test's synchronous `fireEvent.click(screen.getByTestId('btn-train-start'))` immediately after `render()` started failing with "Unable to find an element."
- **Fix:** Added `await waitFor(() => expect(screen.getByTestId('btn-train-start')).not.toBeNull())` before the click. No assertion content changed — the test still verifies exactly one `composeOrResumeSession` call across the whole flow.
- **Files modified:** `frontend/src/pages/__tests__/Train.solveLoop.test.tsx`
- **Verification:** `npm test -- --run Train.solveLoop` passes.
- **Committed in:** `adcd5d6a` (Task 1 commit)

**2. [Rule 2 - Missing Critical] Client-accumulated sessionScore for the completed-state recap**
- **Found during:** Task 1 (six landing states)
- **Issue:** D-03's locked copy ("You scored {score}/{2N} today.") requires a numeric score, but `TrainSessionResponse` has no server-side aggregate score field (only `solved_count`, which counts attempts, not correct answers) — a genuine gap between the plan's must-have truth and the available backend payload, not something a paraphrase or a different UI layout could route around.
- **Fix:** Added a small localStorage-backed tally in `useTrainSession` (`train_score:{session_id}` key), incremented by `correct_guess + correct_move` points on every successful solve, read back on session load. This correctly recovers the score across a same-day page reload (the backend resumes the same `session_id` all day) and for the natural "just finished this session" case; a cold reload on a device that never solved anything this session (or before this feature existed) falls back to 0.
- **Files modified:** `frontend/src/hooks/useTrainSession.ts`, `frontend/src/components/train/TrainStartScreen.tsx`
- **Verification:** `TrainStartScreen.test.tsx`'s completed-state test asserts the recap renders the passed `sessionScore` correctly formatted.
- **Committed in:** `adcd5d6a` (Task 1 commit)

**3. [Rule 3 - Blocking] Engine-failure retry needed a Worker-restart surface not in the plan's literal file list**
- **Found during:** Task 2 (engine-failure fallback)
- **Issue:** The plan's threat model (T-190-13) requires a genuine recovery path ("re-initialises the engine"), but `useTrainGradingEngine.ts` (owned by Plan 01, not listed in Task 2's own `<files>`) had no way to tear down and recreate a failed Worker — without it, "Retry" would just be a relabeled no-op.
- **Fix:** Added `restartEngine()` to `useTrainGradingEngine.ts` (a `restartGeneration` counter added to the Worker-lifecycle effect's deps, plus an explicit `hasError` reset at the start of each (re)run) so a genuinely recovered engine is actually usable again after a press.
- **Files modified:** `frontend/src/hooks/useTrainGradingEngine.ts`
- **Verification:** `TrainSolveScreen.test.tsx`'s two engine-failure tests (Worker `onerror` and readiness-timeout) both assert `train-engine-error` renders and the checking indicator/guess buttons are absent.
- **Committed in:** `aa95f790` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 3 test-timing fix, 1 Rule 2 missing-critical-functionality addition, 1 Rule 3 blocking-capability addition). All three were necessary for the plan's own must-have truths (D-01 exactly-one-fetch, D-03 score recap, T-190-13 genuine recovery) to actually hold, not scope creep beyond what the plan already committed to.

## Issues Encountered

None beyond the three deviations above, which were resolved within this plan rather than deferred.

## User Setup Required

None — no external service configuration required.

## Known Stubs

None. Every state rendered in this plan is backed by real data (the session-status fetch, the grading engine, the solve mutation) — no hardcoded empty values or placeholder text ship as part of the completed feature set.

## Next Phase Readiness

- Plan 05 (reveal panel: verdicts detail, steppable best line, game card, tactic stepper) can build directly on `trainSession.lastSolveResponse`/`retrySolve` and the now-complete solve screen without further Plan 04 follow-up.
- Plan 06's human checkpoint still owns the four backstop truths this plan's must-haves flagged as `verification: backstop` (loading-pattern match, N=1 grammar, the E2 long-text wrap assumption at 320px) — none of those are contradicted by anything built here.
- The `sessionScore` client-side/localStorage limitation (score shows 0 on a genuinely cold cross-device reload of an already-completed session) is a known, explicitly documented gap — not blocking, since the common case (finishing a session in one sitting, or reloading the same device/day) is correctly handled. A future backend aggregate field would close it fully if it becomes a real complaint.
- No blockers for the rest of the phase.

---
*Phase: 190-train-page-solve-loop*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 8 claimed files found on disk; all 3 commit hashes (`adcd5d6a`, `aa95f790`, `a5786714`) found in git history.
