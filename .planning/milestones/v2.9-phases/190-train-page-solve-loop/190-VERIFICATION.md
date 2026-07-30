---
phase: 190-train-page-solve-loop
verified: 2026-07-25T23:45:00Z
status: passed
score: 9/9 must-have requirement IDs verified (SOLV-01..07, NAV-01, NAV-02)
behavior_unverified: 0
overrides_applied: 0
---

# Phase 190: Train Page Solve Loop Verification Report

**Phase Goal:** A gated `/train` route is wired into all three nav surfaces and drives the full session solve loop end-to-end — queue → binary guess → single-move attempt → client-side graded reveal (verdicts, steppable pv, game card, analysis deep-link) → session-end score — against Phase 189's endpoints, so a user can complete a full training session start to finish.

**Verified:** 2026-07-25T23:45:00Z
**Status:** passed (with 4 flagged code-review findings requiring a human decision on follow-up — see Gaps/Advisory section; none block the phase goal)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `/train` route exists, is gated like Openings/Endgames, and is wired into all three nav surfaces (NAV-01, NAV-02) | ✓ VERIFIED | `frontend/src/App.tsx`: `NAV_ITEMS`/`BOTTOM_NAV_ITEMS` both list `{ to: '/train', label: 'Train', Icon: Dumbbell }` at index 1 (element-for-element identical); `IMPORT_EXEMPT_ROUTES = {'/library','/admin','/bots'}` (Train absent → gated); dedicated `isActive` prefix branch (`pathname.startsWith('/train')`); `ROUTE_TITLES['/train'] = 'Train'`. `App.test.tsx` (15 new + 3 corrected cases) passes: `npm test -- --run App.test` → all green. |
| 2 | User presses Start, sees one puzzle, commits a binary guess before moving (SOLV-01) | ✓ VERIFIED | `TrainSolveScreen.tsx` guess buttons (`btn-train-guess-critical`/`btn-train-guess-several`) gate `onPieceDrop`; `Train.solveLoop.test.tsx` asserts a drop before the guess leaves the board unchanged and the same drop after the guess changes it. Confirmed live in 190-06 UAT step 10. |
| 3 | Exactly one move is played and graded fully client-side via vendored Stockfish WASM, reusing `liveFlaw.ts`'s `evalToExpectedScore`/`classifyLiveSeverity` (SOLV-03) | ✓ VERIFIED (see Gaps/Advisory #1 for a race-condition caveat) | `useTrainGradingEngine.ts` imports and calls `evalToExpectedScore`, `classifyLiveSeverity`, `sideToMoveFromFen` from `@/lib/liveFlaw` (no local re-derivation); `useTrainGradingEngine.test.ts` (11 tests) pins the exact-match fast path, MISTAKE_DROP boundary, inaccuracy-band, BLUNDER_DROP boundary, mate-score handling, and mover-sign consistency — all pass. **Caveat:** code review CR-01 (below) identifies a genuine, unmitigated race where a move played before the engine reports `readyok` is graded against a fabricated null eval rather than queued — see Gaps/Advisory. |
| 4 | A session progress indicator is visible throughout the loop (SOLV-04) | ✓ VERIFIED | `TrainSolveScreen.tsx` renders `train-progress`/`train-progress-bar` using the session's frozen `puzzle_count` (not the remaining-array length); `TrainSolveScreen.test.tsx` asserts the frozen-count denominator explicitly. Confirmed live at desktop and 390px (UAT step 12). |
| 5 | The reveal shows guess+move verdicts, best line (steppable), game card, and analysis deep link (SOLV-05) | ✓ VERIFIED | `TrainReveal.tsx` renders verdict rows from `SolveResponse` only, `TrainLineStepper` for the stored best line, `GameCard` with `analyzePly`, all three answer-adjacent fetches (reveal/game-card/tactic-lines) gated on the solve response being present. `TrainReveal.test.tsx` (12 tests) pass; confirmed live (UAT steps 17, 20). |
| 6 | Tactic-tagged flaws offer an opt-in step-through control, never auto-triggered (SOLV-06) | ✓ VERIFIED | `TrainReveal.tsx` renders `btn-train-tactic-step` only when `has_tactic_lines`; the tactic-lines query stays `enabled: false` until the opt-in press — call-count-tested in `TrainReveal.test.tsx` and cross-checked live (UAT step 19). `TrainLineStepper.test.tsx` (9 tests) proves array-indexed stepping, one-move-line both-disabled, and motif label-vs-key separation. |
| 7 | Each puzzle scores 0–2 independent points; session ends on a score screen with a green/yellow/red rating from named thresholds (SOLV-07) | ✓ VERIFIED | `trainScore.ts`: pure module, `TRAIN_RATING_GREEN_MIN`/`TRAIN_RATING_YELLOW_MIN` named constants, `resolveRatingBand` uses at-or-above comparisons (edge-inclusive in the higher band), `displaySessionPercentage` floors and is proven never to contradict the band (comment + tests). `trainScore.test.ts` (15 tests: boundaries, adjacency, zero-scored, reordering, display/band-agreement grid) all pass. `TrainScoreScreen.tsx` renders from these exports only (no inlined thresholds, no confetti). |
| 8 | A real user can complete a full training session start to finish against the real backend, in a real browser, with no dead end | ✓ VERIFIED | 190-06 human UAT: all 23 steps executed live against the real dev backend/DB, operator returned "approved" after one live-found defect (Resume dead-click) was fixed test-first (commit `5bf33fee`) and re-verified. Verified present in code: `useTrainSession.ts` seeds `currentIndex` at 0 (not `solved_count`), matching the backend's remaining-only resume payload. |
| 9 | POOL-10 is never reopened — no answer-key data reaches the client before the attempt | ✓ VERIFIED | `tests/routers/test_train.py::test_pre_attempt_payload_shape` asserts the puzzle JSON key set equals exactly the six locked fields (equality, not membership); `PuzzleRevealResponse.pv` stays behind the existing 409 gate (tested); frontend never calls `revealPuzzle`/`getTacticLines`/game-card before the solve response lands (call-count tests in `Train.solveLoop.test.tsx` and `TrainReveal.test.tsx`). |

**Score:** 9/9 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `frontend/src/App.tsx` | Train nav entry, gating, isActive | ✓ VERIFIED | Confirmed by grep + `App.test.tsx` pass |
| `frontend/src/pages/Train.tsx` | `/train` route page, landing/loop/score orchestration | ✓ VERIFIED | Exists, wired into `App.tsx` lazy route |
| `frontend/src/components/train/TrainStartScreen.tsx` | 6 landing states | ✓ VERIFIED | 10 tests pass (`TrainStartScreen.test.tsx`) |
| `frontend/src/components/train/TrainSolveScreen.tsx` | Board, guess lock, grading, last-move highlight | ✓ VERIFIED | Tests pass; `isReady` present on hook but NOT gated in UI (see Gaps/Advisory #1) |
| `frontend/src/components/train/TrainReveal.tsx` | Verdicts, copy, stepper, game card, deep link | ✓ VERIFIED | 12 tests pass; 4 non-null assertions flagged (WR-03, low severity) |
| `frontend/src/components/train/TrainLineStepper.tsx` | Single-chain SAN stepper | ✓ VERIFIED | 9 tests pass |
| `frontend/src/components/train/TrainScoreScreen.tsx` | Session score/rating | ✓ VERIFIED | Renders from `trainScore.ts` exports only |
| `frontend/src/lib/trainScore.ts` | Pure scoring module | ✓ VERIFIED | 15 tests pass; no React import (`grep -c react` = 0) |
| `frontend/src/hooks/useTrainGradingEngine.ts` | Session-scoped single-Worker grading | ✓ VERIFIED (with caveat) | 11 tests pass; CR-01 race window confirmed present in code |
| `frontend/src/hooks/useTrainSession.ts` | Session/solve orchestration, resume-safe index | ✓ VERIFIED | Resume-dead-click fix (`5bf33fee`) confirmed present |
| `app/schemas/train.py` | `TrainPuzzle.last_move_uci`, `PuzzleRevealResponse.pv` | ✓ VERIFIED | Both fields present, docstrings rewritten |
| `app/services/train_pool.py` | `fen_and_last_move_at_ply`, LATERAL-join perf fix | ✓ VERIFIED | Confirmed present; also fixes a real prod-blocking perf bug found in Plan 01 |
| `tests/routers/test_train.py` | POOL-10 key-set equality guard + reveal pv coverage | ✓ VERIFIED | Test present and passing (`78 passed` for the two Train test files) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `useTrainGradingEngine.ts` | `lib/liveFlaw.ts` | imports `evalToExpectedScore`/`classifyLiveSeverity`/`sideToMoveFromFen` | ✓ WIRED | Confirmed via grep; no local re-derivation |
| `App.tsx` NAV_ITEMS/BOTTOM_NAV_ITEMS | `pages/Train.tsx` | `/train` route inside `ImportRequiredRoute` | ✓ WIRED | Confirmed |
| `TrainReveal.tsx` | `components/results/GameCard.tsx` | `analyzePly` prop | ✓ WIRED | Confirmed via grep + test |
| `TrainReveal.tsx` | `useLibrary.ts` (`useTacticLines`) | lazy, opt-in-gated | ✓ WIRED | Call-count tested |
| `TrainScoreScreen.tsx` | `lib/trainScore.ts` | named threshold exports | ✓ WIRED | Confirmed (`grep -cE "0\.75|0\.5[^0-9]"` = 0 in the screen) |
| `app/repositories/train_repository.py` | `app/services/train_pool.py` | `fen_and_last_move_at_ply` | ✓ WIRED | Both construction sites confirmed |
| `app/repositories/train_repository.py` | `app/repositories/library_repository.py` | `pv_to_san_list` | ✓ WIRED | Confirmed, no private duplicate remains |

### Behavioral Spot-Checks (this verifier's own run, not re-trusting SUMMARY claims)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All Train frontend unit/e2e tests | `npm test -- --run Train.solveLoop useTrainGradingEngine TrainStartScreen TrainSolveScreen TrainReveal TrainScoreScreen TrainLineStepper trainScore App.test` | 8 files, 102 tests, all passed | ✓ PASS |
| Frontend type check | `npx tsc -b` | exit 0 | ✓ PASS |
| Frontend lint | `npm run lint` | 0 errors (3 pre-existing warnings in `coverage/` artifacts, unrelated) | ✓ PASS |
| Frontend dead-export scan | `npm run knip` | no issues | ✓ PASS |
| Backend Train tests | `uv run pytest tests/routers/test_train.py tests/services/test_train_pool.py -q` | 78 passed | ✓ PASS |
| Backend lint | `uv run ruff check` (Train files) | all checks passed | ✓ PASS |
| Backend type check | `uv run ty check app/ tests/` | all checks passed | ✓ PASS |
| CR-01 code-path confirmation | Read `useTrainGradingEngine.ts:240-243` + `TrainSolveScreen.tsx` isReady usage | Confirmed: `search()` resolves a fabricated null result (not a queue) when the engine isn't ready; `engineFailed` gate never checks `isReady` | Confirms REVIEW.md CR-01 is real and unfixed as of HEAD |
| Nav wiring confirmation | grep `App.tsx` | Train at index 1 in both arrays, excluded from `IMPORT_EXEMPT_ROUTES`, dedicated `isActive` branch | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|-------------|--------|----------|
| SOLV-01 | 190-01, 190-06 | Binary guess before one move | ✓ SATISFIED | Guess-lock test + UAT step 10 |
| SOLV-02 | 190-02, 190-04, 190-06 | Lichess-minimal solve screen, last-move highlight | ✓ SATISFIED | `last_move_uci` field + highlight test + UAT step 11 |
| SOLV-03 | 190-01, 190-06 | Client-side grading via WASM, uniform threshold | ✓ SATISFIED (caveat: CR-01) | Unit tests pin threshold boundaries; UAT confirmed normal-path behavior; race-window caveat documented below |
| SOLV-04 | 190-01, 190-04, 190-06 | Session progress indicator | ✓ SATISFIED | Frozen-count test + UAT step 12 |
| SOLV-05 | 190-02, 190-05, 190-06 | Reveal: verdicts, best line, game card, deep link | ✓ SATISFIED | `TrainReveal.test.tsx` + UAT steps 17/20 |
| SOLV-06 | 190-05, 190-06 | Opt-in tactic stepper | ✓ SATISFIED | `TrainReveal.test.tsx`/`TrainLineStepper.test.tsx` + UAT step 19 |
| SOLV-07 | 190-05, 190-06 | 0-2 scoring, rating bands | ✓ SATISFIED | `trainScore.test.ts` (15 tests) + UAT step 22 |
| NAV-01 | 190-03, 190-06 | `/train` on all 3 nav surfaces, correct order | ✓ SATISFIED | `App.test.tsx` + UAT steps 1-3 |
| NAV-02 | 190-03, 190-06 | Import-gated like Openings/Endgames | ✓ SATISFIED | `App.test.tsx` + UAT step 4 |

No orphaned requirements: all 9 phase-190 requirement IDs from REQUIREMENTS.md's traceability table are claimed by at least one plan's `requirements:` frontmatter (cross-referenced above), and all 9 are marked "Complete" in REQUIREMENTS.md.

### Anti-Patterns Found

None of the standard debt markers (TBD/FIXME/XXX/HACK/PLACEHOLDER) were found in the Train-specific files. No unreferenced TODOs. No hardcoded empty-array/object stub returns feeding rendered UI (all data flows from real TanStack Query fetches per the SUMMARYs' explicit "Known Stubs: None" sections, spot-checked above).

### Code Review Findings (Advisory — Gaps/Advisory, not scored against must-haves)

An independent code review (`190-REVIEW.md`, run after the 190-06 UAT) found 1 critical and 3 warnings. This verifier re-confirmed all four directly against the current HEAD (commit `4f571ac5`) rather than trusting the review's own claims:

1. **CR-01 (confirmed present, unfixed).** `useTrainGradingEngine.ts`'s `search()` resolves a fabricated `{evalCp: null, evalMate: null, bestMoveUci: null}` — instead of queuing — when invoked before the engine reports `readyok`. `TrainSolveScreen.tsx` never gates the guess buttons on `gradingEngine.isReady` (only on `hasError`/timeout). A user who moves fast enough on the very first puzzle of a session (WASM still booting) can get a silently wrong `correct_move` verdict with no visible error. This is a genuine, narrow race-condition robustness gap discovered via code review after the human UAT passed — it did not manifest during the 23-step live walkthrough (normal network/WASM-boot timing didn't trigger it), and no must-have truth in plans 01-06 explicitly required an engine-readiness UI gate. Classified as a **WARNING**, not a blocker: the phase's core deliverable (a working, testable solve loop against real endpoints) is demonstrably achieved, but this edge case should be fixed before the feature sees real user traffic.
2. **WR-01 (confirmed present, unfixed).** `handleRetryEngine` calls `startGrading` synchronously before the just-triggered Worker restart has actually landed (React defers the effect to the next commit), so a manual engine-recovery retry can itself silently corrupt or permanently wedge the puzzle it's meant to recover. Narrow scope (only reachable after CR-01/an engine crash already occurred).
3. **WR-02 (confirmed present, unfixed).** `_mark_session_complete_if_done`'s remaining-puzzle count doesn't account for an SR-item's `GameFlaw` row vanishing under reclassification mid-session (a case `load_session_puzzles`' own docstring acknowledges) — could theoretically strand a session in "resume" forever until `expires_on` passes. Very narrow: requires a reclassification event to land on an in-flight session between compose and resume.
4. **WR-03 (confirmed present, unfixed).** `TrainReveal.tsx` uses 4 non-null assertions (`tacticLinesQuery.data!`) instead of narrowing — currently sound by construction but fragile to a future refactor. Pure type-safety hygiene, no behavioral impact today.

None of these four findings contradict any must-have truth this phase's plans committed to, and all are pre-existing at the time of this verification (not introduced or missed by this verifier). They are flagged here for a human decision on whether to open a follow-up quick-task/plan before Train reaches production traffic, per this task's explicit instruction to factor the review in without treating it as a missing feature.

### Human Verification Required

None additional beyond what 190-06 already discharged. The 190-06 checkpoint's 23-step live UAT covered every backstop truth (320/360/390px layout, guess-control wrap, one-puzzle grammar, long-motif/deep-PV wrap, loading pattern, forced-failure recovery ×2) and all three flagged copy prohibitions (no shaming, no ability-judgment framing, no engine-verdict-as-absolute-truth framing) — operator returned "approved" with one live-found defect fixed and re-verified inline.

**Recommended (not blocking) human decision:** whether to spin up a follow-up quick-task to fix CR-01 (engine-readiness gate) before Train is exposed to real user traffic, given it can silently mis-grade a puzzle under a real, if narrow, timing condition.

### Gaps Summary

No gaps against this phase's must-have truths or requirement IDs. All 9 requirement IDs (SOLV-01..07, NAV-01, NAV-02) are verified via a combination of this verifier's own test runs, direct code inspection, and the 190-06 live-browser UAT (which found and fixed one real defect, the Resume dead-click, before signing off).

Four code-review findings (1 critical, 3 warnings) are open and unfixed as of this verification. They describe real, narrow-scope robustness gaps — not missing functionality against any must-have truth — and are surfaced above as advisory items for a human follow-up decision, per this verification task's explicit framing.

---

_Verified: 2026-07-25T23:45:00Z_
_Verifier: Claude (gsd-verifier)_
