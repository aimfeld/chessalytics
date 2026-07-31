---
phase: 190-train-page-solve-loop
plan: 02
subsystem: api
tags: [fastapi, pydantic, sqlalchemy, chess.js, train, pool-10]

requires:
  - phase: 189-pool-scheduler-backend
    provides: "Shipped Train API (POST /train/sessions, POST /train/sessions/{id}/solve, GET reveal, GET/PUT settings) with a locked no-answer-key pre-attempt payload (P-01), plus the Phase 135 PV-to-SAN walk in library_repository.py"
  - phase: 190-train-page-solve-loop (Plan 01)
    provides: "Working solve-loop tracer + trainApi/types/train.ts mirrors, plus a LATERAL-join fix in app/services/train_pool.py that this plan built on top of"
provides:
  - "TrainPuzzle.last_move_uci — the arriving-move UCI for every composed/resumed puzzle (SOLV-02), null at ply 0"
  - "PuzzleRevealResponse.pv — the stored best line as a SAN list, post-attempt only (SOLV-05)"
  - "fen_and_last_move_at_ply — the single shared PGN-replay implementation behind both full_fen_at_ply and the arriving-move field"
  - "library_repository.pv_to_san_list — the Phase 135 PV walk promoted to public so Train's reveal reuses it instead of re-deriving a second one"
affects: [190-03, 190-04, 190-05, 190-06]

tech-stack:
  added: []
  patterns:
    - "Additive, backward-compatible schema widening behind an existing gate (409 reveal check) rather than a new endpoint — verified by a key-set EQUALITY test (not membership) so a future silent answer-key leak fails CI"
    - "Promote a private helper to public (rename only, same contract) when a second module needs the exact same walk, rather than re-deriving it"

key-files:
  created: []
  modified:
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - app/repositories/library_repository.py
    - app/schemas/train.py
    - app/routers/train.py
    - tests/services/test_train_pool.py
    - tests/routers/test_train.py
    - frontend/src/types/train.ts
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx

key-decisions:
  - "TrainPuzzle.last_move_uci is arrival data (the half-move immediately before ply), never answer data — enforced by a key-set equality test on the serialised puzzle object rather than a comment, so a future answer-key field addition fails CI instead of shipping silently (T-190-05)"
  - "One PGN replay for both full_fen_at_ply and the new arriving-move helper: fen_and_last_move_at_ply is the sole implementation, full_fen_at_ply now delegates to it and returns only the FEN"
  - "SAN (not UCI) chosen for PuzzleRevealResponse.pv, matching library_repository.TacticLinesResponse's existing shape, so the frontend's one stepper component consumes both PV sources without a format branch"
  - "A ply-0 puzzle was produced via the resume path (a directly-seeded open-session entry, bypassing pool_entry_stmt's winnability floor which structurally excludes ply=0 from fresh composition) rather than skipped-with-reason — the null contract is exercised by a real test, not an assumption"
  - "Both frontend train.ts type additions (last_move_uci and pv) were committed together in the Task 2 commit, matching the plan's literal per-task file grouping even though last_move_uci is Task 1's field — the plan's action text explicitly assigned both to Task 2's frontend edit"

patterns-established:
  - "A private module helper gets promoted to public (rename + docstring update, same signature/contract) when a second module needs the identical implementation, instead of a second hand-rolled walk drifting from the first"

requirements-completed: [SOLV-02, SOLV-05]

coverage:
  - id: D1
    description: "Every composed and resumed puzzle carries TrainPuzzle.last_move_uci — the UCI of the move that produced its position — null at ply 0, non-null (and matching the game's own PGN at ply-1) otherwise; the pre-attempt payload's key set is exactly the six locked fields (no answer-key leak)"
    requirement: "SOLV-02"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py::TestFenAndLastMoveAtPly (mid-game ply, ply=0, unparseable PGN, ply-past-end, FEN delegation-guard vs full_fen_at_ply — 5 tests)"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py::test_pre_attempt_payload_shape (key-set equality, six fields), test_last_move_uci_matches_pgn_at_ply_minus_one, test_ply_zero_puzzle_serialises_last_move_uci_as_null"
        status: pass
    human_judgment: false
  - id: D2
    description: "PuzzleRevealResponse.pv returns the stored best line as a SAN list after the attempt is recorded (matching best_move_san's first move), null when the stored PV is absent or unparseable, still 200 (never 500) on a malformed PV, and unreachable (409, no best-line key in the body) before the attempt"
    requirement: "SOLV-05"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py::test_reveal_pv_returns_san_list_matching_best_move_san, test_reveal_pv_null_when_no_stored_pv, test_reveal_pv_null_on_malformed_pv, test_reveal_409_before_attempt (extended to assert no pv key)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Exactly one PV-to-SAN walk exists in the backend: library_repository's Phase 135 helper is promoted from private to public and Train's reveal imports it rather than re-deriving a second walk; the Phase 135 tactic-lines path is unaffected by the rename"
    verification:
      - kind: unit
        ref: "grep -rn \"_pv_to_san_list\" app tests (no matches — private name fully retired); grep -c \"pv_to_san_list\" in both library_repository.py and train_repository.py (>=3 and >=1 respectively)"
        status: pass
      - kind: integration
        ref: "uv run pytest -n auto -x (full backend suite, 3780 passed, 18 skipped — proves the rename didn't regress the existing Phase 135 tactic-lines tests)"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-07-25
status: complete
---

# Phase 190 Plan 2: Backend Payload Additions (Arriving Move + Reveal Best Line) Summary

**Two additive backend fields closing Phase 189's deliberately-open payload gaps: `TrainPuzzle.last_move_uci` (arrival data, SOLV-02) and `PuzzleRevealResponse.pv` (post-attempt best line as SAN, SOLV-05) — one shared PGN replay, one promoted PV-to-SAN walk, no re-architecture.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-25
- **Tasks:** 2 planned (both complete), no unplanned deviations
- **Files modified:** 9

## Accomplishments

- Every composed and resumed Train puzzle now carries `last_move_uci` — the UCI of the half-move that produced its position — so the solve screen can animate/highlight the opponent's last move. It is `null` at ply 0 (verified via a real resume-path fixture, not skipped) and derived from the game's own PGN, never a second data source.
- Added `fen_and_last_move_at_ply` as the single shared PGN-replay implementation; `full_fen_at_ply` now delegates to it, so exactly one replay walk exists for both the FEN-only and FEN+last-move call sites.
- `PuzzleRevealResponse` now carries `pv` — the stored best line as a SAN list — reusing the Phase 135 `library_repository` PV walk (promoted from `_pv_to_san_list` to public `pv_to_san_list`) instead of a second hand-rolled walk. Still gated by the existing post-attempt 409 check; a falsy or malformed PV/FEN yields `null`, never a 500.
- Added a POOL-10 key-set **equality** test on the pre-attempt puzzle payload (six fields exactly) so a future answer-key field addition fails CI rather than shipping silently.
- Mirrored both new fields in `frontend/src/types/train.ts` and fixed the one existing test fixture (`Train.solveLoop.test.tsx`) that the wider `TrainPuzzle` interface required.

## Task Commits

Each task was committed atomically:

1. **Task 1: TrainPuzzle carries the arriving move (SOLV-02)** — `88f306c6` (feat)
2. **Task 2: Reveal carries the stored best line as SAN (SOLV-05)** — `de1d83d0` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP updates)

## Files Created/Modified

- `app/services/train_pool.py` — added `fen_and_last_move_at_ply` (the shared PGN replay); `full_fen_at_ply` now delegates to it
- `app/repositories/train_repository.py` — `ComposedPuzzle.last_move_uci`; both construction sites (`load_session_puzzles` resume path, `compose_and_materialize_session`'s `reconstructed` loop) converted to the new helper; `RevealedPuzzle.pv` + `reveal_for_puzzle`'s PV-to-SAN derivation via the promoted `pv_to_san_list`
- `app/repositories/library_repository.py` — `_pv_to_san_list` renamed to public `pv_to_san_list` (behavior/signature unchanged), both `fetch_tactic_lines` call sites updated
- `app/schemas/train.py` — `TrainPuzzle.last_move_uci`, `PuzzleRevealResponse.pv`, both docstrings rewritten (stale five-field count claim removed)
- `app/routers/train.py` — `last_move_uci=` and `pv=` passed through in the two response constructions
- `tests/services/test_train_pool.py` — `TestFenAndLastMoveAtPly` (5 tests: mid-game ply, ply=0, unparseable PGN, ply-past-end, FEN delegation-guard)
- `tests/routers/test_train.py` — key-set equality guard (6 fields), arriving-move value assertion, ply-0 null assertion (via a real resume-path fixture), 3 reveal-pv tests, extended 409 assertion, `_seed_position_meta` gained an optional `pv` param
- `frontend/src/types/train.ts` — `TrainPuzzle.last_move_uci`, `PuzzleRevealResponse.pv`
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` — one-line fixture update (`last_move_uci` added to the mocked puzzle) required by the wider `TrainPuzzle` interface

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria (key-set equality guard, single-replay grep guards, single-PV-walk grep guards, 409-gate-carries-no-pv assertion) were all satisfied without needing an auto-fix.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `TrainPuzzle.last_move_uci` and `PuzzleRevealResponse.pv` are live on the real endpoints and mirrored in `frontend/src/types/train.ts`; Plan 03+ (solve-screen UI work) can consume both directly via the existing `trainApi` client without further backend changes.
- No architectural changes were introduced — the Phase 189 schema shape and the 409 reveal gate are both unchanged apart from the two additive fields.
- No blockers for the rest of the phase.

---
*Phase: 190-train-page-solve-loop*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 9 claimed files found on disk; both commit hashes (`88f306c6`, `de1d83d0`) found in git history.
