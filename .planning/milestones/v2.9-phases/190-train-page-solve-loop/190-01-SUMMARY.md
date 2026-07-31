---
phase: 190-train-page-solve-loop
plan: 01
subsystem: frontend
tags: [react, tanstack-query, stockfish-wasm, postgres, sqlalchemy, chess.js, train]

requires:
  - phase: 189-pool-scheduler-backend
    provides: "Shipped Train API (POST /train/sessions, POST /train/sessions/{id}/solve, GET reveal, GET/PUT settings) with a locked no-answer-key pre-attempt payload (P-01)"
provides:
  - "/train route reachable and import-gated, proven end to end for one puzzle"
  - "trainApi client + TypeScript mirrors of the Phase 189 schemas"
  - "useTrainGradingEngine: session-scoped single-Worker Stockfish grading engine with a measured, provenance-documented movetime budget"
  - "useTrainSession: session/solve orchestration hook, resume-safe currentIndex"
  - "A backend query-planner fix (LATERAL rewrite) that Plan 02+ inherits — flagged below"
affects: [190-02, 190-03, 190-04, 190-05, 190-06]

tech-stack:
  added: []
  patterns:
    - "Imperative Worker-lifecycle hook (startGrading/abortGrading/gradeMove) instead of a fen-prop-driven one, for a search that must outlive a per-puzzle component key"
    - "LATERAL subquery instead of a plain self-join for any GamePosition correlation keyed on (user_id, game_id, ply [+/- N]) — see app/services/train_pool.py's _prior_position_lateral"

key-files:
  created:
    - frontend/src/types/train.ts
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/hooks/useTrainSession.ts
    - frontend/src/pages/Train.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
    - frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts
    - frontend/scripts/measure-train-movetime.mjs
  modified:
    - frontend/src/api/client.ts
    - frontend/src/App.tsx
    - app/services/train_pool.py

key-decisions:
  - "Grading engine starts its 'find the best move' search at puzzle MOUNT, not at guess-commit (RESEARCH Open Question 1 resolved as recommended) — maximises the D-06 exact-match fast-path hit rate"
  - "Measured grading movetime kept at 1500ms (not lowered) — headless measurement showed the engine's top move never disagreed with a 2500ms baseline across 10 real sharp-blunder FENs, and expected-score stabilized by 1000ms worst-case; 1500ms is one full rung of margin above the measured floor"
  - "Stability metric for the movetime harness is expected-score difference (within INACCURACY_DROP/2 of baseline), not exact cp/mate equality — raw cp is naturally noisy even at a fixed movetime (project_eval_nondeterminism); ES is what the actual grading decision consumes"
  - "Fixed a real backend query-planner bug (LATERAL rewrite in app/services/train_pool.py) discovered via manual checkpoint UAT, not left for a later plan — it blocked every user's first Train session"
  - "Removed a self-authored ref-guard in TrainSolveScreen.tsx that was itself causing an indefinite grading hang under React StrictMode; added a hard TRAIN_GRADING_TIMEOUT_MS ceiling + Worker onerror handling as defense-in-depth against ANY future wedge, not just this one"

patterns-established:
  - "Client-side grading is fully self-contained (no server answer key, per Phase 189 P-01): the client's own Stockfish search IS the exact-match reference, not a fetched best_move"
  - "Every async engine-facing hook surface (gradeMove) must have a hard timeout ceiling — an unbounded await on a Worker response is a latent infinite-hang bug, confirmed in production-shaped conditions (StrictMode) during this plan"

requirements-completed: [SOLV-01, SOLV-03]

coverage:
  - id: D1
    description: "A user on /train can press Start, see one puzzle, commit a binary guess, play exactly one move, and see a graded guess+move verdict end to end against the real Phase 189 endpoints; the board rejects input before the guess and accepts exactly one move after it; no reveal-endpoint call happens before the attempt"
    requirement: "SOLV-01"
    verification:
      - kind: e2e
        ref: "frontend/src/pages/__tests__/Train.solveLoop.test.tsx#locks the board until a guess is committed, then grades exactly one move end to end"
        status: pass
    human_judgment: true
    rationale: "A full manual browser UAT (Start session, board lock/unlock, one move, verdicts, Next button, Network-tab reveal check) was already performed live during this plan's checkpoint after the two bug fixes below — user confirmed 'verified, both work fast now'. Flagging human_judgment true anyway since a future verifier run has no memory of that session and a real-browser WASM/network check is judgment-based by nature."
  - id: D2
    description: "correct_move is derived entirely client-side: exact-match to the engine's own top move is the D-06 fast path (no second search); otherwise a second search grades the played move via evalToExpectedScore/classifyLiveSeverity from lib/liveFlaw, with esBefore/esAfter always sharing the same mover argument"
    requirement: "SOLV-03"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts (11 tests: exact-match fast path w/ exactly one go dispatched, drop exactly at MISTAKE_DROP, drop just under MISTAKE_DROP, drop at/over BLUNDER_DROP, mate score via evalToExpectedScore, mover-sign consistency on a black-to-move position, single-Worker reuse across two puzzles, abort-then-restart isolation, plus 3 checkpoint regression tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The grading movetime/node budget is a measured value with recorded provenance (headless harness against real sharp-blunder FENs), not an inherited default"
    verification:
      - kind: other
        ref: "node scripts/measure-train-movetime.mjs (full output table in this SUMMARY)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Backend Train session composition (fresh and resume paths) runs in well under a second for a real user, not 20-27s — the LATERAL-join query-planner fix"
    verification:
      - kind: integration
        ref: "uv run pytest tests/services/test_train_pool.py tests/repositories/test_train_repository.py tests/routers/test_train.py tests/services/test_train_scheduler.py (124 passed); uv run pytest -n auto -x (3770 passed, 18 skipped, full suite)"
        status: pass
    human_judgment: false

duration: 105min
completed: 2026-07-25
status: complete
---

# Phase 190 Plan 1: Train Page Solve Loop Tracer Summary

**End-to-end "solve one Train puzzle" slice against the real Phase 189 endpoints, plus a measured client-side WASM grading budget — with two real production bugs found and fixed via manual checkpoint UAT (a 20-27s backend query pathology and a React-StrictMode-triggered indefinite grading hang).**

## Performance

- **Duration:** ~105 min (includes a human-verified checkpoint pause and two rounds of bug-fix-then-reverify)
- **Completed:** 2026-07-25
- **Tasks:** 2 planned (both complete) + 1 unplanned checkpoint-fix commit
- **Files modified:** 11 (8 new, 3 modified)

## Accomplishments

- A real user with imported games can navigate to `/train`, start a session against the shipped Phase 189 backend, study a locked puzzle board, commit a guess, play exactly one move, and see a server-verified guess + client-graded move verdict — proven both by an automated jsdom e2e test and by live manual browser UAT.
- Built `useTrainGradingEngine`, a session-scoped single-Worker Stockfish grading engine with an imperative `startGrading`/`abortGrading`/`gradeMove` surface, the D-06 exact-match fast path, and expected-score-drop grading reusing `evalToExpectedScore`/`classifyLiveSeverity` from `lib/liveFlaw` verbatim (never re-derived).
- Measured the grading movetime budget with a real headless WASM harness against 10 real sharp-blunder positions pulled from this project's own dev DB — confirmed the existing 1500ms default already has comfortable margin above the measured 1000ms stability floor, rather than blindly copying `useStockfishEngine`'s number.
- Found and fixed two real bugs during manual checkpoint verification, not deferred: a backend query-planner pathology that made every user's first Train session take 20-27 seconds, and a React-StrictMode-triggered bug that made "Checking your move…" hang forever in dev.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "solve one Train puzzle"** — `aa62569e` (feat)
2. **Checkpoint fix: 20s+ session query + indefinite grading hang** — `584c11ed` (fix, unplanned — see Deviations)
3. **Task 2: Measure the grading search budget and lock the threshold contract** — `818d5a7d` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP updates)

## Files Created/Modified

- `frontend/src/types/train.ts` — TypeScript mirrors of `app/schemas/train.py` (5-field `TrainPuzzle`, no answer key; `SolveRequest`/`SolveResponse`; `PuzzleRevealResponse`; `TrainSettingsResponse`/`TrainSettingsUpdate`)
- `frontend/src/api/client.ts` — added `trainApi` (composeOrResumeSession, solvePuzzle, revealPuzzle, getSettings, updateSettings)
- `frontend/src/hooks/useTrainGradingEngine.ts` — session-scoped single-Worker grading engine; measured `TRAIN_GRADING_MOVETIME_MS`/`TRAIN_GRADING_MAX_NODES`; hard `TRAIN_GRADING_TIMEOUT_MS` ceiling; `hasError` surface; generation-counter-based cancellation
- `frontend/src/hooks/useTrainSession.ts` — session/solve TanStack Query orchestration; `currentIndex` seeded from `solved_count`
- `frontend/src/pages/Train.tsx` — `/train` lazy route page, default export
- `frontend/src/components/train/TrainSolveScreen.tsx` — board + guess buttons + one-move attempt + verdict rows + grading-error/Retry state
- `frontend/src/App.tsx` — `/train/*` route registered inside `ImportRequiredRoute` + `Suspense` (nav wiring is Plan 03's)
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` — end-to-end jsdom gate (fake Worker, mocked `trainApi`)
- `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts` — 11 tests: 3 checkpoint regressions + 8 grading-contract cases
- `frontend/scripts/measure-train-movetime.mjs` — headless movetime/ES-stability measurement harness
- `app/services/train_pool.py` — **out-of-plan file** (Phase 189's, not this plan's `files_modified`): `pool_entry_stmt`/`blob_pending_stmt`/`herring_stmt`'s `GamePosition` self-joins rewritten as `LATERAL` subqueries via a new `_prior_position_lateral` helper — see Deviations

## Decisions Made

See `key-decisions` in frontmatter above.

## Movetime Harness Output Table

Run 2026-07-25: `node scripts/measure-train-movetime.mjs` (ladder 500/1000/1500/2500ms, node cap 2,000,000, 10 real sharp-blunder FENs from the dev DB). Stability = same best move AND expected-score within `INACCURACY_DROP / 2` (0.025) of the 2500ms baseline.

| # | FEN (game/ply) | 500ms | 1000ms | 1500ms | 2500ms (baseline) | Stable from |
|---|---|---|---|---|---|---|
| 1 | game 239271 ply 17 | g4f3, cp 245 | g4f3, cp 263 | g4f3, cp 266 | g4f3, cp 266 | 500ms |
| 2 | game 239271 ply 29 | c7e5, cp 1233 | c7e5, mate 8 | c7e5, mate 8 | c7e5, mate 8 | 500ms |
| 3 | game 438394 ply 64 | f4f5, cp 301 | f4f5, cp 332 | f4f5, cp 364 | f4f5, cp 365 | 1000ms |
| 4 | game 238467 ply 22 | f3e5, cp 265 | f3e5, cp 275 | f3e5, cp 275 | f3e5, cp 287 | 500ms |
| 5 | game 237170 ply 12 | b3d5, cp 357 | b3d5, cp 374 | b3d5, cp 386 | b3d5, cp 387 | 500ms |
| 6 | game 642376 ply 48 | g2g3, cp 262 | g2g3, cp 412 | g2g3, cp 402 | g2g3, cp 399 | 1000ms |
| 7 | game 166283 ply 8 | f2f4, cp 319 | f2f4, cp 320 | f2f4, cp 308 | f2f4, cp 314 | 500ms |
| 8 | game 166298 ply 39 | e7h4, cp 32 | e7h4, cp 32 | e7h4, cp 28 | e7h4, cp 15 | 500ms |
| 9 | game 166298 ply 31 | c6e5, cp 395 | c6e5, cp 403 | c6e5, cp 426 | c6e5, cp 430 | 500ms |
| 10 | game 297396 ply 52 | f2h3, cp 170 | f2h3, cp 182 | f2h3, cp 202 | f2h3, cp 186 | 500ms |

**Key result:** the engine's TOP MOVE was identical across every movetime for all 10 FENs (0 disagreements) — the D-06 exact-match fast path is unaffected by movetime in this sample. Worst-case ES stability point: **1000ms**. `TRAIN_GRADING_MOVETIME_MS` kept at **1500ms** — one full rung of margin above the measured floor, generous for sharp-puzzle accuracy without materially lengthening the D-06 "Checking your move…" wait (worst case: two sequential 1500ms searches on a non-exact-match puzzle).

## Deviations from Plan

### Auto-fixed / Rule 1 (bugs) — found via manual checkpoint UAT, not deferred

**1. [Rule 1 - Bug, out-of-plan file] Backend session composition took 20-27s per user (LATERAL join rewrite)**
- **Found during:** Manual browser checkpoint verification after Task 1 — "Start session" appeared to hang.
- **Issue:** `app/services/train_pool.py`'s `pool_entry_stmt`, `blob_pending_stmt`, and `herring_stmt` each correlate a `GamePosition` self-join alias via `(user_id, game_id, ply [+/- N])` using a plain `isouter` join. Confirmed via `EXPLAIN (ANALYZE, BUFFERS)` against the dev DB (real user, ~200k `game_positions` rows, ~1.1k qualifying outer rows): Postgres pushed only `user_id` into the `game_positions_pkey` index scan and left `game_id`/`ply` as a post-scan Join Filter — 108M rows filtered, 21-27s wall time. Reproduced identically outside `--reload`, so not a dev-server artifact.
- **Fix:** rewrote all three self-joins as `LATERAL` subqueries via a new `_prior_position_lateral` helper (same predicates, but Postgres resolves the correlation before planning the inner scan, so it parameterizes the full composite index). Verified byte-identical result sets against the old queries before removing them.
- **Files modified:** `app/services/train_pool.py` — **this file is Phase 189's, not this plan's** `files_modified` list. Flagging explicitly: the 190-02 executor (or any later Train plan) should be aware this file changed underneath it and pull the latest before touching `train_pool.py` again.
- **Verification:** `pool_entry_stmt` 63ms, `blob_pending_stmt` 9ms, `herring_stmt` ~14ms×2, `compose_and_materialize_session` resume path 38ms / fresh path 197ms (all previously 20s+ combined). Backend suite: `uv run pytest -n auto -x` → 3770 passed, 18 skipped. `ruff format/check` and `ty check` clean.
- **Committed in:** `584c11ed`

**2. [Rule 1 - Bug] Indefinite "Checking your move…" hang under React StrictMode**
- **Found during:** Same manual checkpoint round.
- **Issue:** `TrainSolveScreen.tsx`'s puzzle-mount effect had a `startedForFenRef` guard intended to suppress a duplicate `startGrading` dispatch on React StrictMode's dev-only mount→cleanup→mount double-invoke. The guard was itself the bug: the interim cleanup's `abortGrading()` bumps the engine's generation and discards the in-flight search, but the guard then suppressed the SECOND mount's `startGrading` call for the same puzzle fen — leaving no active search for the puzzle's now-current generation, so `gradeMove`'s internal `await bestSearchReadyRef.current` hung forever. `main.tsx` confirmed running `<StrictMode>`, so this fired on every dev-mode puzzle mount.
- **Fix:** removed the guard (`startGrading`/`abortGrading` are already idempotent/cancellation-safe via the hook's generation counter — calling `startGrading` on every effect invocation is correct in both StrictMode dev, one harmless extra stop+go pair, and production). Added defense-in-depth: a hard `TRAIN_GRADING_TIMEOUT_MS` (8s) ceiling around `gradeMove`'s promise and a `Worker.onerror` handler, both of which now reject rather than hang regardless of root cause; a visible `train-grading-error` + Retry UI state in `TrainSolveScreen.tsx`.
- **Files modified:** `frontend/src/components/train/TrainSolveScreen.tsx`, `frontend/src/hooks/useTrainGradingEngine.ts`
- **Verification:** new regression tests in `useTrainGradingEngine.test.ts` (StrictMode double-invoke scenario resolves correctly; hard timeout rejects; `Worker.onerror` rejects + sets `hasError`). Live re-verification: user confirmed "verified, both work fast now" in the browser.
- **Committed in:** `584c11ed`

---

**Total deviations:** 2 auto-fixed (both Rule 1 — genuine bugs blocking the plan's own checkpoint, not scope creep).
**Impact on plan:** Both fixes were necessary for the tracer to actually prove what it claims to prove (a working end-to-end slice). The backend fix touches a file outside this plan's declared scope (Phase 189's `train_pool.py`) — flagged above for the next executor to notice. No unrelated refactoring was done; both fixes are narrowly scoped to the exact broken code paths.

## Issues Encountered

None beyond the two deviations above (which were the actual point of the manual checkpoint — surfaced and resolved within this plan, not carried forward as an open issue).

## User Setup Required

None — no external service configuration required. Dev servers (`uv run uvicorn`, `vite --host`) were already running throughout and picked up all changes via `--reload`/HMR without a restart.

## Next Phase Readiness

- Plan 02+ can build on `useTrainGradingEngine`, `useTrainSession`, `trainApi`, and `types/train.ts` as committed here.
- Plan 02 (per 190-CONTEXT.md/190-RESEARCH.md Pattern 1) will add the two additive backend fields (`TrainPuzzle.last_move_uci`, `PuzzleRevealResponse.pv`) to `app/schemas/train.py`/`app/routers/train.py` — **must pull the `train_pool.py` LATERAL-join fix from this plan first** (same module tree, no conflict expected, but the executor should be aware the file changed).
- Nav wiring (NAV-01/02) is untouched here by design — Plan 03's job.
- No blockers for the rest of the phase.

---
*Phase: 190-train-page-solve-loop*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 9 claimed files found on disk; all 4 commit hashes (`aa62569e`, `584c11ed`, `818d5a7d`, `f890a466`) found in git history.
